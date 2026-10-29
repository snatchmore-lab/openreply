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

/** The [對話追蹤範本] lines with a {主題} slot, or null when not set. */
export function parseQuietTemplate(knowledgeBase: string): string | null {
  const text = [...taggedGroups(knowledgeBase, "對話追蹤範本").values()].flat().filter(Boolean).join("\n");
  return text.includes("{主題}") ? text : null;
}

export const QUIET_TOPIC_PROMPT = `From the conversation, name what the customer asked about, as a short Traditional Chinese noun phrase that fits after "您詢問的" (for example 白框三橫拉, 無框內推門, 浴室整修, 淋浴拉門價格, 玻璃隔屏). Use the customer's own words where possible. At most 10 Chinese characters. No price, no date, no place name, no verb, no punctuation. If there is nothing specific, set ok=false.`;

export const QuietTopic = z.object({ topic: z.string(), ok: z.boolean() });

/**
 * The owner's template with the topic filled in by the model, or the
 * owner's fallback line when there is no template or no usable topic.
 */
async function writeQuietFollowUp(input: {
  workspaceId: string;
  conversationId: string;
  knowledgeBase: string;
  messages: Message[];
  fallback: string;
}): Promise<string> {
  const template = parseQuietTemplate(input.knowledgeBase);
  if (!template) return input.fallback;
  const transcript = input.messages
    .slice(-12)
    .map((m) => `${m.direction === "IN" ? "客人" : m.direction === "OUT_HUMAN" ? "師傅" : "回覆"}：${m.text.replace(/\n/g, " ")}`)
    .join("\n");
  const result = await completeJson({
    feature: "faq",
    workspaceId: input.workspaceId,
    system: QUIET_TOPIC_PROMPT,
    user: `Conversation (oldest first):\n${transcript}`,
    schema: QuietTopic,
    cacheScope: [input.conversationId, "quiet-topic"],
    maxTokens: 500,
  });
  if (!result.ok || !result.result.ok) return input.fallback;
  const topic = safeTopic(result.result.topic, transcript);
  return topic ? template.replace("{主題}", topic) : input.fallback;
}

/** A short topic the template can take, or null: too long, punctuated, or with an invented number. */
export function safeTopic(raw: string, transcript: string): string | null {
  const topic = raw.trim().replace(/^您?詢問的/, "").replace(/^[「『"]|[」』"]$/g, "").trim();
  if (!topic || [...topic].length > 12) return null;
  if (/[。，、！？!?,.\n]/.test(topic)) return null;
  const numbers = topic.match(/\d[\d,.]*/g) ?? [];
  if (numbers.some((n) => !transcript.includes(n))) return null;
  return topic;
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
