/**
 * Send one photo to a customer as the bot, on the owner's instruction, and
 * keep the thread under bot control (same echo handling as send-as-bot.ts).
 *
 *   npx tsx scripts/ops/send-image-as-bot.ts <conversationId> <imageUrl>
 */
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

async function main() {
  const { prisma } = await import("@/lib/db/client");
  const { createInstagramContext, sendDirectImage } = await import("@/lib/instagram/provider");
  const [conversationId, imageUrl] = process.argv.slice(2);
  if (!conversationId || !imageUrl) throw new Error("usage: send-image-as-bot.ts <conversationId> <imageUrl>");

  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { instagramAccount: true } });
  if (!conversation) throw new Error("no such conversation");
  const account = conversation.instagramAccount;
  const before = conversation.status;
  console.log("to:", conversation.senderName, "status:", before);

  const context = await createInstagramContext(account, `ops:${conversation.id}`);
  const sent = await sendDirectImage({ context, instagramAccountId: account.instagramId, userId: conversation.senderId, imageUrl });
  const mid = (sent as { message_id?: string } | null)?.message_id ?? null;
  console.log("sent, message_id:", mid);

  // The echo is recorded as the owner typing; relabel it as the bot's photo.
  let echo: { id: string } | null = null;
  for (let i = 0; i < 20 && !echo; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    echo = mid ? await prisma.conversationMessage.findFirst({ where: { conversationId, messageId: mid }, select: { id: true } }) : null;
  }
  if (echo) {
    await prisma.conversationMessage.update({ where: { id: echo.id }, data: { direction: "OUT_AI" } });
    console.log("echo relabelled OUT_AI");
  } else {
    await prisma.conversationMessage.create({ data: { conversationId, direction: "OUT_AI", text: "(照片)", messageId: mid } });
    console.log("no echo seen in 60 s; recorded OUT_AI myself");
  }
  const after = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: before === "HUMAN" ? "AI" : before, takenOverAt: null },
    select: { status: true },
  });
  console.log("status now:", after.status);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
