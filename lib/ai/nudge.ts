/**
 * Ad follow-up ("nudge"): a person taps a button on an ad, Meta's template
 * and the FAQ bot answer, and the person goes quiet. One hour later the bot
 * sends the account's follow-up line, once per conversation.
 *
 * Configured in the knowledge base, so the owner can change it without code:
 *   [追蹤訊息] 想了解淋浴拉門還是浴室整修呢😊
 *   [追蹤訊息] 方便的話可以傳張浴室照片給我們
 *   [廣告按鈕] 線上評估【淋浴空間】
 *   [廣告按鈕] 預約免費現場丈量
 * Without a [追蹤訊息] line the feature is off.
 *
 * Only people whose every message so far is an ad button get it: anyone who
 * typed something real is in a conversation, not silent.
 */

import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { getDMQueue, FAQ_NUDGE_JOB_NAME, type FaqNudgeJob } from "@/lib/queue/client";
import { createInstagramContext, hasInstagramCredentials, sendDirectMessage } from "@/lib/instagram/provider";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";

export const NUDGE_DELAY_MS = 60 * 60 * 1000;
/** Messenger's standard messaging window. */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NudgeConfig {
  text: string;
  buttons: Set<string>;
}

export function parseNudgeConfig(knowledgeBase: string): NudgeConfig | null {
  const textLines: string[] = [];
  const buttons = new Set<string>();
  for (const raw of knowledgeBase.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[追蹤訊息]")) textLines.push(line.slice("[追蹤訊息]".length).trim());
    else if (line.startsWith("[廣告按鈕]")) buttons.add(normalizeButton(line.slice("[廣告按鈕]".length)));
  }
  const text = textLines.filter(Boolean).join("\n");
  return text && buttons.size > 0 ? { text, buttons } : null;
}

function normalizeButton(text: string): string {
  return text.trim().replace(/\s+/g, "");
}

export function isAdButton(config: NudgeConfig, text: string): boolean {
  return config.buttons.has(normalizeButton(text));
}

/** Called for every inbound message; schedules the one-hour check after a button tap. */
export async function scheduleNudge(input: {
  knowledgeBase: string;
  instagramAccountId: string;
  conversationId: string;
  messageId: string;
  messageText: string;
}): Promise<void> {
  const config = parseNudgeConfig(input.knowledgeBase);
  if (!config || !isAdButton(config, input.messageText)) return;
  const job: FaqNudgeJob = {
    instagramAccountId: input.instagramAccountId,
    conversationId: input.conversationId,
    messageId: input.messageId,
  };
  await getDMQueue()
    .add(FAQ_NUDGE_JOB_NAME, job, {
      delay: NUDGE_DELAY_MS,
      jobId: `nudge_${input.conversationId}_${Buffer.from(input.messageId).toString("base64url")}`,
    })
    .catch((error: unknown) => {
      console.error("[FAQ nudge] schedule failed:", error instanceof Error ? error.message : error);
    });
}

export type NudgeOutcome = "sent" | "skipped";

export async function handleNudge(job: FaqNudgeJob, now = new Date()): Promise<NudgeOutcome> {
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: job.instagramAccountId },
    include: { aiSettings: true, workspace: { include: { aiSettings: true } } },
  });
  if (!account || !hasInstagramCredentials(account)) return "skipped";
  const settings = account.aiSettings ?? account.workspace.aiSettings;
  if (!settings?.faqEnabled) return "skipped";
  const config = parseNudgeConfig(settings.knowledgeBase);
  if (!config) return "skipped";

  const conversation = await prisma.conversation.findUnique({
    where: { id: job.conversationId },
    select: {
      id: true,
      senderId: true,
      status: true,
      instagramAccountId: true,
      messages: { orderBy: { createdAt: "asc" }, select: { direction: true, text: true, messageId: true, createdAt: true } },
    },
  });
  if (!conversation || conversation.instagramAccountId !== account.id) return "skipped";
  if (!shouldNudge(conversation, job.messageId, config, now)) return "skipped";

  const slot = await reserveDMSlot(account.instagramId);
  if (!slot.allowed) return "skipped";
  try {
    const context = await createInstagramContext(account, `nudge:${conversation.id}`);
    await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: conversation.senderId,
      message: config.text,
    });
  } catch (error) {
    if (slot.reserved) await releaseDMSlot(account.instagramId).catch(() => {});
    console.error("[FAQ nudge] send failed:", error instanceof Error ? error.message : error);
    return "skipped";
  }
  await prisma.$transaction([
    prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "OUT_AI",
        text: config.text,
        aiMeta: { nudge: true } as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } }),
  ]);
  return "sent";
}

/** Pure decision, exposed for tests. */
export function shouldNudge(
  conversation: {
    status: string;
    messages: { direction: string; text: string; messageId: string | null; createdAt: Date }[];
  },
  messageId: string,
  config: NudgeConfig,
  now: Date
): boolean {
  if (conversation.status !== "AI") return false;
  const inbound = conversation.messages.filter((m) => m.direction === "IN");
  const last = inbound[inbound.length - 1];
  // The person wrote again since the tap: that message's own job decides.
  if (!last || last.messageId !== messageId) return false;
  if (now.getTime() - last.createdAt.getTime() > MESSAGING_WINDOW_MS) return false;
  if (!inbound.every((m) => isAdButton(config, m.text))) return false;
  // The owner already replied, or the follow-up already went out.
  if (conversation.messages.some((m) => m.direction === "OUT_HUMAN")) return false;
  if (conversation.messages.some((m) => m.direction === "OUT_AI" && m.text === config.text)) return false;
  return true;
}
