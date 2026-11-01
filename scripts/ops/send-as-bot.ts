/**
 * Send one message to a customer as the bot, on the owner's instruction, and
 * keep the thread under bot control.
 *
 * Run from a machine without REDIS_URL, the echo of this send comes back to
 * the webhook looking like the owner typing, which flips the thread to HUMAN.
 * So: send, wait for that echo row, relabel it OUT_AI, put the status back.
 *
 *   npx tsx scripts/ops/send-as-bot.ts <conversationId> "<line 1>" "<line 2>" ...
 */
import path from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

async function main() {
  const { prisma } = await import("@/lib/db/client");
  const { createInstagramContext, sendDirectMessage } = await import("@/lib/instagram/provider");
  const [conversationId, ...lines] = process.argv.slice(2);
  const text = lines.join("\n").trim();
  if (!conversationId || !text) throw new Error("usage: send-as-bot.ts <conversationId> <lines...>");

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { instagramAccount: true },
  });
  if (!conversation) throw new Error("no such conversation");
  const account = conversation.instagramAccount;
  console.log("to:", conversation.senderName, conversation.senderId, "status:", conversation.status);

  const context = await createInstagramContext(account, `ops:${conversation.id}`);
  const sent = await sendDirectMessage({ context, instagramAccountId: account.instagramId, userId: conversation.senderId, message: text });
  const mid = sent?.message_id ?? null;
  console.log("sent, message_id:", mid);

  // Wait for the webhook echo (recorded as OUT_HUMAN by the live app).
  let echo: { id: string } | null = null;
  for (let i = 0; i < 20 && !echo; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    echo = mid
      ? await prisma.conversationMessage.findFirst({ where: { conversationId, messageId: mid }, select: { id: true } })
      : await prisma.conversationMessage.findFirst({ where: { conversationId, direction: "OUT_HUMAN", text, createdAt: { gte: new Date(Date.now() - 120_000) } }, select: { id: true } });
  }
  if (echo) {
    await prisma.conversationMessage.update({ where: { id: echo.id }, data: { direction: "OUT_AI", text } });
    console.log("echo relabelled OUT_AI");
  } else {
    await prisma.conversationMessage.create({ data: { conversationId, direction: "OUT_AI", text, messageId: mid } });
    console.log("no echo seen in 60 s; recorded OUT_AI myself");
  }
  const after = await prisma.conversation.update({
    where: { id: conversationId },
    data: { status: "AI", takenOverAt: null, needsHumanAt: null, lastMessageAt: new Date(), aiReplyCount: { increment: 1 } },
    select: { status: true },
  });
  console.log("status now:", after.status);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
