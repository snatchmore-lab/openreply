/**
 * Follow-ups the FAQ bot sends once, inside Messenger's 24-hour window.
 *
 * "ad": a person taps a button on an ad, Meta's template and the bot answer,
 * and the person goes quiet. One hour later the [追蹤訊息] line goes out.
 * Only people whose every message so far is an ad button get it.
 *
 * "quiet": a person typed, the bot answered last, and then they went quiet.
 * 23 hours later the [對話追蹤訊息] line goes out, once per conversation.
 *
 * Configured in the knowledge base, so the owner can change it without code:
 *   [追蹤訊息] 想了解淋浴拉門還是浴室整修呢😊
 *   [廣告按鈕] 線上評估【淋浴空間】
 *   [對話追蹤訊息] 想請問還有什麼可以幫您的嗎😊
 * Without the lines, that kind of follow-up is off.
 */

import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { getDMQueue, FAQ_NUDGE_JOB_NAME, type FaqNudgeJob } from "@/lib/queue/client";
import { createInstagramContext, hasInstagramCredentials, sendDirectMessage } from "@/lib/instagram/provider";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";

export const NUDGE_DELAY_MS = 60 * 60 * 1000;
export const QUIET_DELAY_MS = 23 * 60 * 60 * 1000;
/** Messenger's standard messaging window. */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

type Message = { direction: string; text: string; messageId: string | null; createdAt: Date };

export interface NudgeConfig {
  text: string;
  buttons: Set<string>;
}

function taggedLines(knowledgeBase: string, tag: string): string[] {
  return knowledgeBase
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((line) => line.startsWith(tag))
    .map((line) => line.slice(tag.length).trim());
}

export function parseNudgeConfig(knowledgeBase: string): NudgeConfig | null {
  const text = taggedLines(knowledgeBase, "[追蹤訊息]").filter(Boolean).join("\n");
  const buttons = new Set(taggedLines(knowledgeBase, "[廣告按鈕]").map(normalizeButton));
  return text && buttons.size > 0 ? { text, buttons } : null;
}

/** The [對話追蹤訊息] lines, or null when the owner has not set one. */
export function parseQuietFollowUp(knowledgeBase: string): string | null {
  return taggedLines(knowledgeBase, "[對話追蹤訊息]").filter(Boolean).join("\n") || null;
}

function normalizeButton(text: string): string {
  return text.trim().replace(/\s+/g, "");
}

export function isAdButton(config: NudgeConfig, text: string): boolean {
  return config.buttons.has(normalizeButton(text));
}

/** Called for every inbound message; schedules the check for its kind. */
export async function scheduleNudge(input: {
  knowledgeBase: string;
  instagramAccountId: string;
  conversationId: string;
  messageId: string;
  messageText: string;
}): Promise<void> {
  const config = parseNudgeConfig(input.knowledgeBase);
  let kind: "ad" | "quiet";
  if (config && isAdButton(config, input.messageText)) kind = "ad";
  else if (parseQuietFollowUp(input.knowledgeBase)) kind = "quiet";
  else return;
  const job: FaqNudgeJob = {
    instagramAccountId: input.instagramAccountId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    kind,
  };
  await getDMQueue()
    .add(FAQ_NUDGE_JOB_NAME, job, {
      delay: kind === "ad" ? NUDGE_DELAY_MS : QUIET_DELAY_MS,
      jobId: `nudge_${kind}_${input.conversationId}_${Buffer.from(input.messageId).toString("base64url")}`,
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
  const kind = job.kind ?? "ad";
  const adConfig = kind === "ad" ? parseNudgeConfig(settings.knowledgeBase) : null;
  const text = adConfig?.text ?? (kind === "quiet" ? parseQuietFollowUp(settings.knowledgeBase) : null);
  if (!text) return "skipped";

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
  const ok = adConfig
    ? shouldNudge(conversation, job.messageId, adConfig, now)
    : shouldFollowUpQuiet(conversation, job.messageId, text, now);
  if (!ok) return "skipped";

  const slot = await reserveDMSlot(account.instagramId);
  if (!slot.allowed) return "skipped";
  try {
    const context = await createInstagramContext(account, `nudge:${conversation.id}`);
    await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: conversation.senderId,
      message: text,
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
        text,
        aiMeta: { nudge: kind } as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } }),
  ]);
  return "sent";
}

/** The person's newest message, if it is still the one the job was for and recent enough. */
function stillLatest(messages: Message[], messageId: string, now: Date): Message | null {
  const inbound = messages.filter((m) => m.direction === "IN");
  const last = inbound[inbound.length - 1];
  // The person wrote again: that message's own job decides.
  if (!last || last.messageId !== messageId) return null;
  if (now.getTime() - last.createdAt.getTime() > MESSAGING_WINDOW_MS) return null;
  return last;
}

/** Pure decision for the ad follow-up, exposed for tests. */
export function shouldNudge(
  conversation: { status: string; messages: Message[] },
  messageId: string,
  config: NudgeConfig,
  now: Date
): boolean {
  if (conversation.status !== "AI") return false;
  if (!stillLatest(conversation.messages, messageId, now)) return false;
  const inbound = conversation.messages.filter((m) => m.direction === "IN");
  if (!inbound.every((m) => isAdButton(config, m.text))) return false;
  // The owner already replied, or the follow-up already went out.
  if (conversation.messages.some((m) => m.direction === "OUT_HUMAN")) return false;
  if (conversation.messages.some((m) => m.direction === "OUT_AI" && m.text === config.text)) return false;
  return true;
}

/** Pure decision for the quiet follow-up, exposed for tests. */
export function shouldFollowUpQuiet(
  conversation: { status: string; messages: Message[] },
  messageId: string,
  text: string,
  now: Date
): boolean {
  // Handed to the owner or taken over: his call, not the bot's.
  if (conversation.status !== "AI") return false;
  const last = stillLatest(conversation.messages, messageId, now);
  if (!last) return false;
  // The bot answered last; a thread the bot left unanswered is not "quiet".
  const final = conversation.messages[conversation.messages.length - 1];
  if (!final || final.direction !== "OUT_AI") return false;
  if (conversation.messages.some((m) => m.direction === "OUT_HUMAN" && m.createdAt >= last.createdAt)) return false;
  if (conversation.messages.some((m) => m.direction === "OUT_AI" && m.text === text)) return false;
  return true;
}
