/**
 * Follow-ups the FAQ bot sends once, inside Messenger's 24-hour window.
 *
 * "ad": a person taps a button on an ad, Meta's template and the bot answer,
 * and the person goes quiet. One hour later one of the owner's [追蹤訊息]
 * variants goes out, picked at random so no two people compare identical
 * texts. Only people whose every message so far is an ad button get it.
 *
 * "quiet": a person typed, the bot answered last, and then they went quiet.
 * 23 hours later the model writes one short line about what they talked
 * about, in the owner's voice; [對話追蹤訊息] is the fallback when it cannot.
 *
 * Configured in the knowledge base, so the owner can change it without code:
 *   [追蹤訊息:1] Hello~ 不好意思打擾一下😊      (one variant per number;
 *   [追蹤訊息:1] 浴室是想做哪個部分呢?             lines with the same
 *   [追蹤訊息:2] 哈囉~ 剛剛有看到您的訊息^_^      number form one text)
 *   [廣告按鈕] 線上評估【淋浴空間】
 *   [對話追蹤訊息] 想請問還有什麼可以幫您的嗎😊
 * Without the lines, that kind of follow-up is off.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { getDMQueue, FAQ_NUDGE_JOB_NAME, type FaqNudgeJob } from "@/lib/queue/client";
import { createInstagramContext, hasInstagramCredentials, sendDirectMessage } from "@/lib/instagram/provider";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";
import { completeJson } from "./service";
import { buildFaqContextBlock } from "./prompts";
import { capByLines, formatAiText } from "./text";

export const NUDGE_DELAY_MS = 60 * 60 * 1000;
export const QUIET_DELAY_MS = 23 * 60 * 60 * 1000;
/** Messenger's standard messaging window. */
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

type Message = {
  direction: string;
  text: string;
  messageId: string | null;
  createdAt: Date;
  aiMeta?: unknown;
};

export interface NudgeConfig {
  /** One or more variants; one is picked at random per person. */
  texts: string[];
  buttons: Set<string>;
}

/** Lines starting with `[tag]` or `[tag:KEY]`, grouped by KEY in order. */
function taggedGroups(knowledgeBase: string, tag: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const raw of knowledgeBase.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(`[${tag}`)) continue;
    const close = line.indexOf("]");
    const head = line.slice(tag.length + 1, close);
    if (close < 0 || (head && !/^[:：]/.test(head))) continue;
    const key = head.replace(/^[:：]/, "").trim();
    groups.set(key, [...(groups.get(key) ?? []), line.slice(close + 1).trim()]);
  }
  return groups;
}

export function parseNudgeConfig(knowledgeBase: string): NudgeConfig | null {
  const texts = [...taggedGroups(knowledgeBase, "追蹤訊息").values()]
    .map((lines) => lines.filter(Boolean).join("\n"))
    .filter(Boolean);
  const buttons = new Set(
    [...taggedGroups(knowledgeBase, "廣告按鈕").values()].flat().map(normalizeButton).filter(Boolean)
  );
  return texts.length > 0 && buttons.size > 0 ? { texts, buttons } : null;
}

/** The [對話追蹤訊息] lines (the fallback), or null when the owner has not set one. */
export function parseQuietFollowUp(knowledgeBase: string): string | null {
  return [...taggedGroups(knowledgeBase, "對話追蹤訊息").values()].flat().filter(Boolean).join("\n") || null;
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
  const fallback = kind === "quiet" ? parseQuietFollowUp(settings.knowledgeBase) : null;
  if (!adConfig && !fallback) return "skipped";

  const conversation = await prisma.conversation.findUnique({
    where: { id: job.conversationId },
    select: {
      id: true,
      senderId: true,
      status: true,
      instagramAccountId: true,
      messages: {
        orderBy: { createdAt: "asc" },
        select: { direction: true, text: true, messageId: true, createdAt: true, aiMeta: true },
      },
    },
  });
  if (!conversation || conversation.instagramAccountId !== account.id) return "skipped";
  const ok = adConfig
    ? shouldNudge(conversation, job.messageId, adConfig, now)
    : shouldFollowUpQuiet(conversation, job.messageId, fallback!, now, outOfAreaReplies(settings.knowledgeBase));
  if (!ok) return "skipped";

  const text = adConfig
    ? adConfig.texts[Math.floor(Math.random() * adConfig.texts.length)]
    : await writeQuietFollowUp({
        workspaceId: account.workspaceId,
        conversationId: conversation.id,
        knowledgeBase: settings.knowledgeBase,
        messages: conversation.messages,
        fallback: fallback!,
        lineWidth: settings.maxLineWidth,
      });

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

export const QUIET_SYSTEM_PROMPT = `You write ONE short follow-up Messenger message for a bathroom renovation business (御本衛浴). The customer chatted yesterday, got answers, then went quiet. Write it in the owner's voice described in the knowledge base (friendly, casual, Traditional Chinese, 台灣用語, calls the customer 您).

Rules:
- Mention what this customer actually talked about (the style, the area, the question they asked), so it reads like the owner remembers them. Use only things the customer or the earlier replies said.
- Never add a price, a date, a promise, or a fact that is not already in the conversation or the knowledge base.
- Exactly 2 or 3 short lines, at most 15 Chinese characters each, one phrase per line. Start like the owner does (for example "Hello~"). At most one emoji. Never use 「。」.
- End by gently offering the next step: asking if they have other questions, or offering to book 師傅免費到府丈量討論 (say that phrase in full).
- Do not say you are following up because they went quiet, and do not mention yesterday's exact time.
- Never say what 師傅 or anyone has done, is doing, or will do (no 已經幫您排, 會再回覆, 還在確認, 有記下來). Only mention what the customer asked about, then ask or offer.
- If the conversation gives you nothing specific to mention, set ok=false.`;

export const QuietOutput = z.object({ message: z.string(), ok: z.boolean() });

/** The model's personalised line, or the owner's fallback when it cannot write one. */
async function writeQuietFollowUp(input: {
  workspaceId: string;
  conversationId: string;
  knowledgeBase: string;
  messages: Message[];
  fallback: string;
  lineWidth?: number;
}): Promise<string> {
  const transcript = input.messages
    .slice(-12)
    .map((m) => `${m.direction === "IN" ? "客人" : m.direction === "OUT_HUMAN" ? "師傅" : "回覆"}：${m.text.replace(/\n/g, " ")}`)
    .join("\n");
  const result = await completeJson({
    feature: "faq",
    workspaceId: input.workspaceId,
    system: QUIET_SYSTEM_PROMPT,
    context: buildFaqContextBlock(input.knowledgeBase),
    user: `Conversation (oldest first):\n${transcript}\n\nWrite the follow-up.`,
    schema: QuietOutput,
    cacheScope: [input.conversationId, "quiet-nudge"],
    maxTokens: 1000,
  });
  if (!result.ok || !result.result.ok) return input.fallback;
  return safeQuietText(result.result.message, transcript, input.lineWidth) ?? input.fallback;
}

/**
 * Clean the model's line, or null when it should not go out: empty, too long,
 * or carrying a number (a price, a date) the conversation never mentioned.
 */
export function safeQuietText(raw: string, transcript: string, lineWidth?: number): string | null {
  const text = capByLines(formatAiText(raw.replace(/。/g, "").trim(), lineWidth), 120);
  if (!text || text.split("\n").length > 4) return null;
  // Claims about progress the owner never made ("已經幫您排囉", "師傅會再回覆").
  if (/師傅(會|還在|已經|正在)|已經幫|幫您排|確認中|記下來/.test(text)) return null;
  const numbers = text.match(/\d[\d,.]*/g) ?? [];
  if (numbers.some((n) => !transcript.includes(n))) return null;
  return text;
}

/** The owner's "we don't serve your area" fixed replies: no follow-up after those. */
function outOfAreaReplies(knowledgeBase: string): string[] {
  const fixed = taggedGroups(knowledgeBase, "固定回覆");
  return ["沒服務", "開放"]
    .map((name) => (fixed.get(name) ?? []).join("\n").replace(/^\n+|\n+$/g, ""))
    .filter(Boolean);
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

function nudgeKind(message: Message): unknown {
  const meta = message.aiMeta as { nudge?: unknown } | null | undefined;
  return message.direction === "OUT_AI" ? meta?.nudge : undefined;
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
  // The owner already replied, or a follow-up already went out.
  if (conversation.messages.some((m) => m.direction === "OUT_HUMAN")) return false;
  if (conversation.messages.some((m) => nudgeKind(m) || (m.direction === "OUT_AI" && config.texts.includes(m.text)))) {
    return false;
  }
  return true;
}

/** Pure decision for the quiet follow-up, exposed for tests. */
export function shouldFollowUpQuiet(
  conversation: { status: string; messages: Message[] },
  messageId: string,
  fallback: string,
  now: Date,
  outOfArea: string[] = []
): boolean {
  // Handed to the owner or taken over: his call, not the bot's.
  if (conversation.status !== "AI") return false;
  const last = stillLatest(conversation.messages, messageId, now);
  if (!last) return false;
  // The bot answered last; a thread the bot left unanswered is not "quiet".
  const final = conversation.messages[conversation.messages.length - 1];
  if (!final || final.direction !== "OUT_AI") return false;
  if (conversation.messages.some((m) => m.direction === "OUT_HUMAN" && m.createdAt >= last.createdAt)) return false;
  // Already told them we do not serve their area: nothing to follow up on.
  if (conversation.messages.some((m) => m.direction === "OUT_AI" && outOfArea.includes(m.text))) return false;
  if (conversation.messages.some((m) => nudgeKind(m) === "quiet" || (m.direction === "OUT_AI" && m.text === fallback))) {
    return false;
  }
  return true;
}
