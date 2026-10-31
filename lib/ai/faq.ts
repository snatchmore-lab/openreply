/**
 * FAQ bot (feature 3).
 *
 * Runs on inbound DMs that matched no campaign. It answers only from the
 * workspace's plain-text knowledge base; when it cannot, it sends the owner's
 * handoff message once and flags the conversation NEEDS_HUMAN, after which it
 * stays silent until a person takes over or hands it back.
 *
 * Guards, in order: feature off / empty knowledge base → duplicate message →
 * conversation not in AI state → per-person hourly cap → model call. Every
 * guard failure means "say nothing", never "crash the job".
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import {
  createInstagramContext,
  hasInstagramCredentials,
  sendDirectImage,
  sendDirectMessage,
  PermissionError,
  TokenExpiredError,
} from "@/lib/instagram/provider";
import { isLatestInboundMessage, rememberAutomatedAnswer, takeAutomatedAnswer } from "@/lib/instagram/sent-mids";
import { getPageUserName } from "@/lib/meta/client";
import { lineNotifyEnabledFor, pushThrottledLineMessage } from "@/lib/notify/line";
import { scheduleLineReminder } from "@/lib/notify/line-reminder";
import { scheduleNudge } from "./nudge";
import { reportProblem, resolveProblem } from "@/lib/notify/owner-line";
import { completeJson, type AiResult } from "./service";
import { capByLines, formatAiText, MAX_LINE_WIDTH } from "./text";
import { normalizeTone } from "./opening";
import { releaseDMSlot, reserveDMSlot } from "@/lib/utils/rate-limiter";
import { isValidEmail, sendThrottledNotifyEmail } from "@/lib/notify/email";
import {
  buildFaqContextBlock,
  buildFaqUserPrompt,
  FAQ_SYSTEM_PROMPT,
  type FaqHistoryItem,
} from "./prompts";

export const DEFAULT_HANDOFF_MESSAGE = "這個問題我幫你轉給本人回覆，請稍等一下 🙏";
/** A message older than this when its job runs is a catch-up after an outage, not a conversation. */
export const STALE_MESSAGE_MS = 30 * 60 * 1000;
export const HISTORY_TURNS = 6;

/**
 * Sent instead of any answer when the person mentions suicide or self-harm.
 * Fixed text, never written by the model: Taiwan's 24-hour 安心專線.
 */
export const CRISIS_MESSAGE = "如果你現在很難受\n可以撥 1925 安心專線\n24 小時都有人接";

const FaqOutput = z.object({
  answer: z.string().max(2000),
  confident: z.boolean(),
  crisis: z.boolean(),
  /** Photo URLs picked from the knowledge base's [圖片] lines. */
  images: z.array(z.string()),
  /** NAME of a [固定回覆:NAME] the knowledge base says to use, or "". */
  fixedReply: z.string(),
});

const MAX_IMAGES_PER_REPLY = 3;

/**
 * Photo URLs the knowledge base offers, one per line as
 * "[圖片] description：https://…". Only these may ever be sent.
 */
export function knowledgeBaseImages(knowledgeBase: string): Set<string> {
  const urls = new Set<string>();
  for (const line of knowledgeBase.split(/\r?\n/)) {
    if (!line.trim().startsWith("[圖片]")) continue;
    const url = line.match(/https:\/\/\S+/)?.[0];
    if (url) urls.add(url);
  }
  return urls;
}

/** The model's picks, minus anything not listed in the knowledge base. */
export function pickImages(requested: string[] | undefined, knowledgeBase: string): string[] {
  const allowed = knowledgeBaseImages(knowledgeBase);
  return [...new Set((requested ?? []).map((u) => u.trim()))]
    .filter((u) => allowed.has(u))
    .slice(0, MAX_IMAGES_PER_REPLY);
}

export interface FaqSettings {
  faqEnabled: boolean;
  knowledgeBase: string;
  handoffMessage: string;
  hourlyLimitPerUser: number;
  tone: string;
  maxReplyChars: number;
  notifyEmail?: string | null;
  answerAfterHandoff?: boolean;
  maxLineWidth?: number;
}

/**
 * Dry run for the dashboard test bench: same prompt, same decision rules, no
 * conversation state, nothing sent. Uses the settings as typed in the form,
 * so the owner can try an unsaved knowledge base.
 */
export async function previewFaqAnswer(input: {
  workspaceId: string;
  question: string;
  settings: Pick<FaqSettings, "knowledgeBase" | "handoffMessage" | "tone" | "maxReplyChars" | "maxLineWidth">;
}): Promise<
  | { kind: "answered" | "handoff" | "crisis"; text: string }
  | { kind: "unavailable"; detail?: string }
> {
  if (!input.settings.knowledgeBase.trim()) {
    return { kind: "handoff", text: input.settings.handoffMessage.trim() || DEFAULT_HANDOFF_MESSAGE };
  }
  const maxChars = Math.min(1000, Math.max(50, input.settings.maxReplyChars));
  const pre = preReplyRule(input.question, input.settings.knowledgeBase, [], false);
  const result = pre?.kind === "result"
    ? pre.result
    : await completeJson({
      feature: "faq",
      workspaceId: input.workspaceId,
      system: FAQ_SYSTEM_PROMPT,
      context: buildFaqContextBlock(input.settings.knowledgeBase),
      user: buildFaqUserPrompt({
        question: input.question.slice(0, 1000),
        history: [],
        tone: normalizeTone(input.settings.tone),
        maxChars,
        lineWidth: clampLineWidth(input.settings.maxLineWidth),
      }),
      schema: FaqOutput,
      cacheScope: ["preview"],
      maxTokens: 2000,
    });
  if (!result.ok) return { kind: "unavailable", detail: result.detail };
  return decideFaqReply(result.result, { ...input.settings, maxReplyChars: maxChars });
}

export type FaqOutcome =
  | { kind: "answered"; text: string; cached: boolean }
  | { kind: "handoff"; text: string }
  | { kind: "crisis"; text: string }
  | {
      kind: "silent";
      reason:
        | "disabled"
        | "duplicate"
        | "no-account"
        | "not-ai-state"
        | "hourly-limit"
        | "ai-unavailable"
        | "send-failed"
        | "superseded"
        | "auto-answered"
        | "stale";
    };

/** Unanswered messages from the last two minutes are answered together. */
const PENDING_WINDOW_MS = 2 * 60 * 1000;

/**
 * Split the earlier messages (oldest first, current one excluded) into the
 * person's trailing unanswered messages and the history before them.
 */
export function splitPendingMessages(
  earlier: { direction: string; text: string; createdAt: Date }[],
  now: Date
): { pending: string[]; history: FaqHistoryItem[] } {
  let start = earlier.length;
  while (
    start > 0 &&
    earlier[start - 1].direction === "IN" &&
    now.getTime() - earlier[start - 1].createdAt.getTime() <= PENDING_WINDOW_MS
  ) {
    start -= 1;
  }
  return {
    pending: earlier.slice(start).map((m) => m.text),
    history: earlier
      .slice(0, start)
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.direction === "IN" ? "user" : "assistant", text: m.text })),
  };
}

async function fillPageSenderName(
  account: Parameters<typeof createInstagramContext>[0],
  conversationId: string,
  senderId: string
): Promise<void> {
  try {
    const context = await createInstagramContext(account, `name:${conversationId}`);
    if (context.provider !== "FACEBOOK_PAGE") return;
    const name = await getPageUserName(context.accessToken, context.pageId, senderId);
    if (name) await prisma.conversation.update({ where: { id: conversationId }, data: { senderName: name } });
  } catch {
    // Cosmetic only; the inbox falls back to the id.
  }
}

/** One short line saying what the person sent, for the LINE alert. */
export function lineAlertSummary(question: string): string {
  const text = question
    .replace(/\(客人傳了照片\)/g, "傳了照片")
    .replace(/\(客人傳了影片\)/g, "傳了影片")
    .replace(/\(客人傳了語音\)/g, "傳了語音")
    .replace(/\(客人傳了檔案\)/g, "傳了檔案")
    .replace(/\(客人分享了連結\)/g, "分享了連結")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("／");
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function clampLineWidth(width: number | null | undefined): number {
  return Math.min(30, Math.max(8, Math.round(width ?? MAX_LINE_WIDTH)));
}

/** Same clean-up as the opener, minus the URL strip: KB URLs are allowed. */
export function sanitizeAnswer(raw: string, maxChars: number, lineWidth?: number): string | null {
  let text = raw.replace(/\{[a-z_]+\}/gi, "").trim();
  text = text.replace(/^["「『“]+/, "").replace(/["」』”]+$/, "").trim();
  text = capByLines(formatAiText(text, clampLineWidth(lineWidth)), maxChars);
  return text || null;
}

/**
 * Pure decision: given the model's output, what goes out?
 * Exposed for tests.
 */
/**
 * Fixed replies the owner wrote word for word, as knowledge-base lines
 * "[固定回覆:NAME] text" (several lines with the same NAME form one reply).
 * The model answers {{NAME}} and the exact text goes out, line breaks kept.
 */
export function knowledgeBaseFixedReplies(knowledgeBase: string): Map<string, string> {
  const replies = new Map<string, string[]>();
  for (const raw of knowledgeBase.split(/\r?\n/)) {
    const match = raw.trim().match(/^\[固定回覆[:：]([^\]]+)\]\s*(.*)$/);
    if (!match) continue;
    const name = match[1].trim();
    replies.set(name, [...(replies.get(name) ?? []), match[2].trim()]);
  }
  // Blank lines inside a reply are the owner's spacing; keep them.
  return new Map([...replies].map(([name, lines]) => [name, lines.join("\n").replace(/^\n+|\n+$/g, "")]));
}

export function decideFaqReply(
  output: { answer: string; confident: boolean; crisis?: boolean; fixedReply?: string } | null,
  settings: Pick<FaqSettings, "handoffMessage" | "maxReplyChars" | "maxLineWidth"> & { knowledgeBase?: string }
):
  | { kind: "answered"; text: string }
  | { kind: "handoff"; text: string }
  | { kind: "crisis"; text: string } {
  // Safety first: a crisis never gets a knowledge-base answer.
  if (output?.crisis) return { kind: "crisis", text: CRISIS_MESSAGE };
  const handoff = settings.handoffMessage.trim() || DEFAULT_HANDOFF_MESSAGE;
  if (!output) return { kind: "handoff", text: handoff };
  // A fixed reply the owner wrote wins, even if the model marked itself unsure:
  // the knowledge base said to use it.
  const fixedReplies = knowledgeBaseFixedReplies(settings.knowledgeBase ?? "");
  const picked = fixedReplies.get(output.fixedReply?.trim() ?? "");
  if (picked) return { kind: "answered", text: picked };
  if (!output.confident) return { kind: "handoff", text: handoff };
  // {{NAME}}, or the bare NAME the model sometimes sends instead.
  const fixedName = output.answer.trim().match(/^\{\{(.+)\}\}$/)?.[1]?.trim();
  if (fixedName) {
    const fixed = fixedReplies.get(fixedName);
    return fixed ? { kind: "answered", text: fixed } : { kind: "handoff", text: handoff };
  }
  const bare = fixedReplies.get(output.answer.trim());
  if (bare) return { kind: "answered", text: bare };
  const text = sanitizeAnswer(output.answer, settings.maxReplyChars, settings.maxLineWidth);
  if (!text) return { kind: "handoff", text: handoff };
  // The model sometimes writes the owner's handoff line itself as a confident
  // answer. That is a handoff, and must count as one so the "never twice in a
  // row" rule still applies (seen in simulation: the same line three times).
  if (sameWords(text, handoff)) return { kind: "handoff", text: handoff };
  return { kind: "answered", text };
}

/** Equal once spaces, line breaks and punctuation are ignored. */
function sameWords(a: string, b: string): boolean {
  const strip = (t: string) => t.replace(/[\s\p{P}\p{S}]/gu, "");
  return strip(a).length > 0 && strip(a) === strip(b);
}

/**
 * Places the owner does not serve and places they do, as knowledge-base lines
 * "[沒服務地區] 台北 新北 …" and "[服務地區] 台中 彰化 …". A message naming
 * only unserved places gets [固定回覆:沒服務] without asking the model, which
 * sometimes hands a long out-of-area request to the owner instead. Once per
 * conversation: after that the model answers follow-ups (a referral, say).
 */
export function isOutOfAreaRequest(
  message: string,
  knowledgeBase: string,
  earlier: { direction: string; text: string }[]
): boolean {
  const reply = knowledgeBaseFixedReplies(knowledgeBase).get("沒服務");
  if (!reply) return false;
  const text = message.replace(/臺/g, "台");
  if (!placeList(knowledgeBase, "沒服務地區").some((place) => text.includes(place))) return false;
  if (placeList(knowledgeBase, "服務地區").some((place) => text.includes(place))) return false;
  return !earlier.some((m) => m.direction === "OUT_AI" && m.text === reply);
}

function placeList(knowledgeBase: string, tag: string): string[] {
  return knowledgeBase
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`[${tag}]`))
    .flatMap((line) => line.slice(tag.length + 2).split(/[\s、，,]+/))
    .map((place) => place.replace(/臺/g, "台"))
    .filter(Boolean);
}

/** The model's output for an out-of-area request, written by the rule above. */
const OUT_OF_AREA_RESULT: FaqAi = {
  ok: true,
  result: { answer: "", confident: true, crisis: false, images: [], fixedReply: "沒服務" },
  cached: false,
  model: "rule:out-of-area",
  usage: null,
};

/** Not an answer: the per-person hourly cap is reached, so the owner takes over. */
const HOURLY_LIMIT_RESULT: FaqAi = {
  ok: true,
  result: { answer: "", confident: false, crisis: false, images: [], fixedReply: "" },
  cached: false,
  model: "rule:hourly-limit",
  usage: null,
};

type FaqAi = Extract<AiResult<z.infer<typeof FaqOutput>>, { ok: true }>;

/**
 * Towns inside the served counties the owner wants to confirm himself, as a
 * knowledge-base line "[偏遠鄉鎮] 泰安 南庄 …". The model, asked about one,
 * tended to say "有在跑"; the owner asked for these to come straight to him.
 */
export function isRemoteTownRequest(message: string, knowledgeBase: string): boolean {
  const text = message.replace(/臺/g, "台");
  return placeList(knowledgeBase, "偏遠鄉鎮").some((place) => text.includes(place));
}

/** Not an answer: the town needs the owner's say-so, so the thread is his. */
const REMOTE_TOWN_RESULT: FaqAi = {
  ok: true,
  result: { answer: "", confident: false, crisis: false, images: [], fixedReply: "" },
  cached: false,
  model: "rule:remote-town",
  usage: null,
};

function fixedReplyResult(name: string, model: string): FaqAi {
  return {
    ok: true,
    result: { answer: "", confident: true, crisis: false, images: [], fixedReply: name },
    cached: false,
    model,
    usage: null,
  };
}

/** "還沒回嗎", "有人在嗎", "師傅多久會回": the person is waiting on the owner. */
const ASKING_FOR_REPLY =
  /(還沒|沒有|怎麼沒|什麼時候|幾時|多久|何時).{0,6}(回|理我|看到|有人)|(^|[^現])在嗎|有人嗎|有看到嗎|人呢|回一下|回我|已讀|等很久|等多久/u;

export function isAskingForReply(message: string): boolean {
  return ASKING_FOR_REPLY.test(message.replace(/\s/g, ""));
}

export type PreReplyRule = { kind: "result"; result: FaqAi } | { kind: "silent" } | null;

/**
 * What is decided before the model is asked. Shared with the simulation so
 * it runs the same bot as production.
 * - a message naming only unserved places → [固定回覆:沒服務], once
 * - while the owner has the thread, "還沒回嗎" → [固定回覆:回覆時間] once,
 *   then quiet (the owner is already alerted; nagging him again helps nobody)
 * - a town the owner wants to confirm himself → handoff
 */
export function preReplyRule(
  question: string,
  knowledgeBase: string,
  earlier: { direction: string; text: string }[],
  waitingOnOwner: boolean
): PreReplyRule {
  if (isOutOfAreaRequest(question, knowledgeBase, earlier)) {
    return { kind: "result", result: OUT_OF_AREA_RESULT };
  }
  const replyTime = knowledgeBaseFixedReplies(knowledgeBase).get("回覆時間");
  if (waitingOnOwner && replyTime && isAskingForReply(question)) {
    const saidAlready = earlier.some((m) => m.direction === "OUT_AI" && m.text === replyTime);
    return saidAlready ? { kind: "silent" } : { kind: "result", result: fixedReplyResult("回覆時間", "rule:reply-time") };
  }
  if (isRemoteTownRequest(question, knowledgeBase)) return { kind: "result", result: REMOTE_TOWN_RESULT };
  return null;
}

type Decision = ReturnType<typeof decideFaqReply>;

/**
 * What is checked after the model (or a rule above) decided. Shared with the
 * simulation.
 * - never the same text twice in a row: a person who asks the same thing
 *   again gets the owner, which is what the knowledge base asks for
 *   (追問同樣的事 → 請師傅回覆). Simulation showed the same 線上報價 line
 *   going out three times to one person. The out-of-area replies are left
 *   alone: repeating "we do not serve there" is no reason to wake the owner.
 * - a shower-door thread is asked about fixtures ([固定回覆:先問配件])
 *   before it is asked for photos. The knowledge base says so and the model
 *   skipped it often; the photo request lines are swapped for the question.
 */
export function applyReplyRules(
  decision: Decision,
  input: {
    question: string;
    earlier: { direction: string; text: string }[];
    settings: { handoffMessage: string; knowledgeBase: string };
  }
): Decision {
  const fixed = knowledgeBaseFixedReplies(input.settings.knowledgeBase);
  const lastOut = [...input.earlier].reverse().find((m) => m.direction !== "IN");
  const outOfArea = ["沒服務", "開放"].map((name) => fixed.get(name));
  if (
    decision.kind === "answered" &&
    lastOut?.direction === "OUT_AI" &&
    sameWords(lastOut.text, decision.text) &&
    !outOfArea.includes(decision.text)
  ) {
    return { kind: "handoff", text: input.settings.handoffMessage.trim() || DEFAULT_HANDOFF_MESSAGE };
  }

  const askFixtures = fixed.get("先問配件");
  if (
    askFixtures &&
    decision.kind === "answered" &&
    ![...fixed.values()].includes(decision.text) &&
    asksForPhotos(decision.text)
  ) {
    const inbound = [...input.earlier.filter((m) => m.direction === "IN").map((m) => m.text), input.question];
    const outbound = input.earlier.filter((m) => m.direction !== "IN").map((m) => m.text);
    const showerDoor = inbound.some((t) => /拉門|淋浴門|玻璃門|隔屏|浴簾/.test(t));
    const fixturesCovered =
      outbound.some((t) => /龍頭|馬桶|配件/.test(t)) ||
      inbound.some((t) => /龍頭|馬桶|配件|臉盆|浴櫃|設備|整修|翻新/.test(t));
    const photoSent = inbound.some((t) => t.includes("客人傳了照片"));
    if (showerDoor && !fixturesCovered && !photoSent) {
      // Keep what comes before the photo request, cut back to a sentence end
      // (the sanitizer wraps long sentences over several lines), drop the
      // request and whatever followed it, then ask about fixtures.
      const lines = decision.text.split("\n");
      const kept = lines.slice(0, lines.findIndex((line) => line.includes("照片")));
      while (kept.length && !/[~～唷呢嗎喔啊呀😊🥹😂👌)）!！?？_]$/u.test(kept[kept.length - 1])) kept.pop();
      return { kind: "answered", text: [...kept, askFixtures].join("\n") };
    }
  }
  return decision;
}

function asksForPhotos(text: string): boolean {
  return text.includes("照片") && /傳|拍|提供|給/.test(text);
}

/** Meta's default ad-template follow-up line ("…你好！來向你打聲招呼…"). */
const META_AUTOMATION_PHRASES = ["來向你打聲招呼"];

function taggedPhrases(knowledgeBase: string, tag: string): string[] {
  return knowledgeBase
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`[${tag}]`))
    .map((line) => line.slice(tag.length + 2).trim())
    .filter(Boolean);
}

/**
 * Texts Meta sends by itself around the conversation (ad-template greetings
 * and follow-ups): the default phrase, plus any the owner lists in the
 * knowledge base as "[Meta自動訊息] phrase". Not the owner, and not an answer
 * to anything the customer asked.
 */
export function isMetaAutomationText(text: string, knowledgeBase: string): boolean {
  return [...META_AUTOMATION_PHRASES, ...taggedPhrases(knowledgeBase, "Meta自動訊息")].some((phrase) =>
    text.includes(phrase)
  );
}

/**
 * Texts Meta sends as the answer to a button the customer tapped (an ad
 * template's button reply, a Page FAQ answer), listed in the knowledge base as
 * "[Meta按鈕回覆] phrase". Not the owner, but it does answer the customer's
 * message, so the bot stays out of that one.
 */
export function isMetaButtonReplyText(text: string, knowledgeBase: string): boolean {
  return taggedPhrases(knowledgeBase, "Meta按鈕回覆").some((phrase) => text.includes(phrase));
}

export type MetaEchoKind = "greeting" | "button-reply" | null;

/** Which of Meta's own automations this echo is, per the account's knowledge base. */
export async function classifyMetaEcho(instagramId: string, text: string): Promise<MetaEchoKind> {
  if (!text) return null;
  let knowledgeBase = "";
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { instagramId },
      select: { aiSettings: { select: { knowledgeBase: true } }, workspace: { select: { aiSettings: { select: { knowledgeBase: true } } } } },
    });
    knowledgeBase = account?.aiSettings?.knowledgeBase ?? account?.workspace.aiSettings?.knowledgeBase ?? "";
  } catch {
    // Default phrases only.
  }
  if (isMetaAutomationText(text, knowledgeBase)) return "greeting";
  if (isMetaButtonReplyText(text, knowledgeBase)) return "button-reply";
  return null;
}

async function isMetaAutomationEcho(instagramId: string, text: string): Promise<boolean> {
  return (await classifyMetaEcho(instagramId, text)) === "greeting";
}

/**
 * An automated message (Meta's Page FAQ answering a button tap) right after
 * the customer's message. Meta's ad greetings are not answers: they arrive
 * around the first message whatever the customer asked.
 */
export async function noteAutomatedAnswer(input: {
  instagramAccountId: string;
  recipientId: string;
  messageText: string;
}): Promise<void> {
  if (await isMetaAutomationEcho(input.instagramAccountId, input.messageText)) return;
  await rememberAutomatedAnswer(input.instagramAccountId, input.recipientId, input.messageText || "[附件]");
}

/**
 * Meta's Page FAQ already answered this message: the bot does not answer it
 * again. The answer is kept as the bot's turn (not counted as its reply), so
 * later answers know what the customer was already asked.
 */
async function answeredByAutomation(
  conversationId: string,
  input: { instagramAccountId: string; senderId: string; messageId: string }
): Promise<boolean> {
  const text = await takeAutomatedAnswer(input.instagramAccountId, input.senderId, input.messageId);
  if (!text) return false;
  await prisma.conversationMessage.create({
    data: {
      conversationId,
      direction: "OUT_AI",
      text,
      aiMeta: { automation: true } as unknown as Prisma.InputJsonValue,
    },
  });
  return true;
}

/**
 * The account owner replied from the Instagram app (an echo whose message id
 * this system never sent). Hand the thread to the human: the bot goes silent
 * and the dashboard shows "Taken over". A reply in a thread the bot has not
 * seen yet (an older customer, or one the owner wrote to first) starts that
 * thread as the owner's, so the customer's next message is not answered as
 * if it were a new chat. The human's text is kept so the bot's later context
 * and the dashboard history include it.
 */
export async function handleHumanEcho(input: {
  instagramAccountId: string; // IG user id (instagramId), as in the webhook
  recipientId: string;
  messageId: string;
  messageText: string;
}): Promise<"taken-over" | "already-human" | "no-thread" | "automation"> {
  // Meta's own follow-up from the ad template can land in a thread at any
  // time; it is not the owner typing.
  if (await isMetaAutomationEcho(input.instagramAccountId, input.messageText)) return "automation";

  const conversation = await prisma.conversation.findFirst({
    where: {
      senderId: input.recipientId,
      instagramAccount: { instagramId: input.instagramAccountId },
    },
    select: { id: true, status: true },
  });
  if (!conversation) return startHumanThread(input);

  await prisma.conversationMessage
    .create({
      data: {
        conversationId: conversation.id,
        direction: "OUT_HUMAN",
        text: input.messageText,
        messageId: input.messageId,
      },
    })
    .catch(() => {
      // Duplicate echo delivery; the unique messageId already recorded it.
    });

  if (conversation.status === "HUMAN") {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    return "already-human";
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: "HUMAN", takenOverAt: new Date(), lastMessageAt: new Date() },
  });
  return "taken-over";
}

async function startHumanThread(input: {
  instagramAccountId: string;
  recipientId: string;
  messageId: string;
  messageText: string;
}): Promise<"taken-over" | "no-thread"> {
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: input.instagramAccountId },
  });
  if (!account) return "no-thread";

  const now = new Date();
  // upsert: the customer's message may have created the thread meanwhile.
  const conversation = await prisma.conversation.upsert({
    where: {
      instagramAccountId_senderId: { instagramAccountId: account.id, senderId: input.recipientId },
    },
    create: {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      senderId: input.recipientId,
      status: "HUMAN",
      takenOverAt: now,
      lastMessageAt: now,
    },
    update: { status: "HUMAN", takenOverAt: now, lastMessageAt: now },
    select: { id: true, senderName: true },
  });
  await prisma.conversationMessage
    .create({
      data: {
        conversationId: conversation.id,
        direction: "OUT_HUMAN",
        text: input.messageText,
        messageId: input.messageId,
      },
    })
    .catch(() => {
      // Duplicate echo delivery; the unique messageId already recorded it.
    });
  if (account.provider === "FACEBOOK_PAGE" && !conversation.senderName) {
    await fillPageSenderName(account, conversation.id, input.recipientId);
  }
  return "taken-over";
}

/** The owner may have replied while the model was writing. */
async function ownerHasThread(conversationId: string): Promise<boolean> {
  const current = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { status: true },
  });
  return current?.status === "HUMAN";
}

/**
 * A person replied from the OpenReply dashboard inbox. That send goes through
 * our own send layer, so the echo looks like ours and handleHumanEcho would
 * not fire; mark the takeover explicitly instead. No-op when the bot has
 * never touched the thread.
 */
export async function recordDashboardReply(input: {
  instagramAccountRecordId: string;
  recipientId: string;
  text: string;
}): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: {
      instagramAccountId_senderId: {
        instagramAccountId: input.instagramAccountRecordId,
        senderId: input.recipientId,
      },
    },
    select: { id: true, status: true },
  });
  if (!conversation) return;
  await prisma.$transaction([
    prisma.conversationMessage.create({
      data: { conversationId: conversation.id, direction: "OUT_HUMAN", text: input.text },
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(conversation.status === "HUMAN"
          ? {}
          : { status: "HUMAN", takenOverAt: new Date() }),
      },
    }),
  ]);
}

export async function handleFaqMessage(input: {
  instagramAccountId: string; // IG user id (instagramId), as in the webhook
  senderId: string;
  messageId: string;
  messageText: string;
  /** When the webhook received the message (ms since epoch). */
  receivedAt?: number;
}): Promise<FaqOutcome> {
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: input.instagramAccountId },
    include: { aiSettings: true, workspace: { include: { aiSettings: true } } },
  });
  if (!account) return { kind: "silent", reason: "no-account" };

  // Account row wins outright; otherwise inherit the workspace defaults.
  const settings = account.aiSettings ?? account.workspace.aiSettings;
  if (!settings || !settings.faqEnabled || !settings.knowledgeBase.trim()) {
    return { kind: "silent", reason: "disabled" };
  }

  // Dedup on the Instagram message id: a retried job must not answer twice.
  const seen = await prisma.conversationMessage.findUnique({
    where: { messageId: input.messageId },
    select: { id: true },
  });
  if (seen) return { kind: "silent", reason: "duplicate" };

  const now = new Date();
  const conversation = await prisma.conversation.upsert({
    where: {
      instagramAccountId_senderId: {
        instagramAccountId: account.id,
        senderId: input.senderId,
      },
    },
    create: {
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      senderId: input.senderId,
      lastInboundAt: now,
      lastMessageAt: now,
    },
    update: { lastInboundAt: now, lastMessageAt: now },
  });

  await prisma.conversationMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "IN",
      text: input.messageText,
      messageId: input.messageId,
    },
  });

  // Facebook Page threads have no other place to show who is talking.
  if (account.provider === "FACEBOOK_PAGE" && !conversation.senderName) {
    await fillPageSenderName(account, conversation.id, input.senderId);
  }

  // The worker was down and is catching up: answering a message from half an
  // hour ago lands after the owner has most likely dealt with it. The thread
  // goes to the owner instead, with one LINE note per outage.
  if (input.receivedAt && now.getTime() - input.receivedAt > STALE_MESSAGE_MS) {
    if (conversation.status === "AI") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "NEEDS_HUMAN", needsHumanAt: now },
      });
    }
    if (lineNotifyEnabledFor(account.instagramId)) {
      await pushThrottledLineMessage(
        `stale-${account.id}`,
        10 * 60,
        "機器人剛恢復運作\n停擺期間有客人傳訊息進來\n超過 30 分鐘的機器人不會補回\n請到收件匣看一下並親自回覆"
      );
    }
    return { kind: "silent", reason: "stale" };
  }

  await scheduleNudge({
    knowledgeBase: settings.knowledgeBase,
    instagramAccountId: input.instagramAccountId,
    conversationId: conversation.id,
    messageId: input.messageId,
    messageText: input.messageText,
  });

  // The person sent something newer: that message's job answers both.
  if (!(await isLatestInboundMessage(input.instagramAccountId, input.senderId, input.messageId))) {
    return { kind: "silent", reason: "superseded" };
  }

  // HUMAN (the owner replied) always silences the bot. NEEDS_HUMAN does too,
  // unless the account opted in to keep answering what the knowledge base
  // covers while the owner has not replied yet.
  const afterHandoff =
    conversation.status === "NEEDS_HUMAN" && Boolean(settings.answerAfterHandoff);
  if (conversation.status !== "AI" && !afterHandoff) {
    return { kind: "silent", reason: "not-ai-state" };
  }

  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const recentReplies = await prisma.conversationMessage.count({
    where: {
      conversationId: conversation.id,
      direction: "OUT_AI",
      createdAt: { gte: oneHourAgo },
    },
  });
  // Over the per-person cap: the thread goes to the owner once (handoff line,
  // alert) instead of the person being left on read; after that, quiet until
  // the hour passes.
  const limitReached = recentReplies >= Math.max(1, settings.hourlyLimitPerUser);
  if (limitReached && conversation.status !== "AI") {
    return { kind: "silent", reason: "hourly-limit" };
  }

  if (!hasInstagramCredentials(account)) {
    return { kind: "silent", reason: "no-account" };
  }

  // Filtered in code: a Prisma `not` on messageId would also drop our own
  // replies, whose messageId is null.
  const earlier = (
    await prisma.conversationMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS + 10,
      select: { direction: true, text: true, messageId: true, createdAt: true },
    })
  )
    .filter((m) => m.messageId !== input.messageId)
    .reverse();
  const { pending, history } = splitPendingMessages(earlier, now);
  const question = [...pending, input.messageText].join("\n");

  if (await answeredByAutomation(conversation.id, input)) return { kind: "silent", reason: "auto-answered" };

  const tone = normalizeTone(settings.tone);
  const maxChars = Math.min(1000, Math.max(50, settings.maxReplyChars));

  const pre = limitReached ? null : preReplyRule(question, settings.knowledgeBase, earlier, afterHandoff);
  if (pre?.kind === "silent") return { kind: "silent", reason: "not-ai-state" };
  const result = limitReached
    ? HOURLY_LIMIT_RESULT
    : pre?.kind === "result"
    ? pre.result
    : await completeJson({
      feature: "faq",
      workspaceId: account.workspaceId,
      system: FAQ_SYSTEM_PROMPT,
      context: buildFaqContextBlock(settings.knowledgeBase),
      user: buildFaqUserPrompt({
        question: question.slice(0, 1000),
        history,
        tone,
        maxChars,
        lineWidth: clampLineWidth(settings.maxLineWidth),
      }),
      schema: FaqOutput,
      cacheScope: [conversation.id],
      maxTokens: 2000,
    });

  if (!result.ok) {
    // AI off / cap / provider error: silence is safer than a canned handoff
    // for every message during an outage.
    return { kind: "silent", reason: "ai-unavailable" };
  }

  let decision = applyReplyRules(decideFaqReply(result.result, settings), { question, earlier, settings });

  // Already handed off: never send the handoff line twice in a row. If the
  // bot has answered other things since, a new request that needs the owner
  // (a booking, a photo) is handed off again, alert included. Right after the
  // handoff line, an owner-written [固定回覆:再轉交] ("I'll pass this on too")
  // goes out once instead; after that the bot stays quiet.
  if (afterHandoff && decision.kind === "handoff") {
    const lastReply = [...earlier].reverse().find((m) => m.direction !== "IN");
    const passOn = knowledgeBaseFixedReplies(settings.knowledgeBase).get("再轉交");
    const lastWasHandoff = lastReply?.direction === "OUT_AI" && lastReply.text === decision.text;
    const lastWasPassOn = lastReply?.direction === "OUT_AI" && Boolean(passOn) && lastReply.text === passOn;
    if (!lastReply || lastWasPassOn) return { kind: "silent", reason: "not-ai-state" };
    if (lastWasHandoff) {
      if (!passOn) return { kind: "silent", reason: "not-ai-state" };
      decision = { kind: "handoff", text: passOn };
    }
  }

  // The person may have sent more while the model was writing; that newer
  // message's job answers everything, this draft is dropped.
  if (!(await isLatestInboundMessage(input.instagramAccountId, input.senderId, input.messageId))) {
    return { kind: "silent", reason: "superseded" };
  }
  if (await ownerHasThread(conversation.id)) return { kind: "silent", reason: "not-ai-state" };
  if (await answeredByAutomation(conversation.id, input)) return { kind: "silent", reason: "auto-answered" };

  // Share the per-account hourly DM budget with campaign sends so the bot can
  // never push the account over Instagram's cap. No slot → stay silent now;
  // the person can ask again later.
  const slot = await reserveDMSlot(account.instagramId);
  if (!slot.allowed) return { kind: "silent", reason: "hourly-limit" };

  let context;
  try {
    context = await createInstagramContext(account, `faq:${conversation.id}`);
    await sendDirectMessage({
      context,
      instagramAccountId: account.instagramId,
      userId: input.senderId,
      message: decision.text,
    });
  } catch (error) {
    if (slot.reserved) await releaseDMSlot(account.instagramId).catch(() => {});
    console.error(
      "[FAQ bot] Failed to send reply:",
      error instanceof Error ? error.message : error
    );
    // Account-wide problems (authorization gone) need the owner; a single
    // customer's failed send does not.
    if (error instanceof TokenExpiredError || error instanceof PermissionError) {
      await reportProblem(
        `send-${account.id}`,
        `${account.username}：機器人沒辦法回覆客人${String.fromCharCode(10)}原因：粉專或帳號的授權失效了，請到 OpenReply 設定頁重新連接`
      ).catch(() => {});
    }
    return { kind: "silent", reason: "send-failed" };
  }
  await resolveProblem(`send-${account.id}`, `${account.username}：機器人已恢復正常回覆`).catch(() => {});

  // Photos follow the text. Each one is a DM against the hourly budget; a
  // failed or over-budget photo is dropped, the text already went out.
  const sentImages: string[] = [];
  if (decision.kind === "answered") {
    for (const imageUrl of pickImages(result.result?.images, settings.knowledgeBase)) {
      const imageSlot = await reserveDMSlot(account.instagramId);
      if (!imageSlot.allowed) break;
      try {
        await sendDirectImage({ context, userId: input.senderId, imageUrl });
        sentImages.push(imageUrl);
      } catch (error) {
        if (imageSlot.reserved) await releaseDMSlot(account.instagramId).catch(() => {});
        console.error(
          "[FAQ bot] Failed to send image:",
          error instanceof Error ? error.message : error
        );
        break;
      }
    }
  }

  const needsHuman = decision.kind !== "answered";
  const aiMeta = {
    confident: decision.kind === "answered",
    handoff: needsHuman,
    crisis: decision.kind === "crisis",
    cached: result.cached,
    model: result.model,
  };
  await prisma.$transaction([
    prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "OUT_AI",
        text: [decision.text, ...sentImages.map((u) => `[圖片] ${u}`)].join("\n"),
        aiMeta: aiMeta as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        aiReplyCount: { increment: 1 },
        ...(needsHuman ? { status: "NEEDS_HUMAN", needsHumanAt: new Date() } : {}),
      },
    }),
  ]);

  if (decision.kind === "crisis" && isValidEmail(settings.notifyEmail)) {
    await sendThrottledNotifyEmail(`crisis-${conversation.id}`, 10 * 60, {
      to: settings.notifyEmail,
      subject: `【緊急】@${account.username} 有人在私訊提到想不開`,
      text: [
        `@${account.username} 收到一則可能涉及自我傷害的私訊。`,
        `機器人已回覆 1925 安心專線，之後不會再自動回這個人：`,
        `「${decision.text.replace(/\n/g, " ")}」`,
        "",
        "對方的訊息：",
        input.messageText.slice(0, 500),
        "",
        "請盡快打開 Instagram App 親自關心對方。",
        "如果對方有立即危險，請撥 110 或 119。",
        "",
        "（這封信由 OpenReply 自動寄出）",
      ].join("\n"),
    }).catch(() => {});
  } else if (decision.kind === "handoff" && isValidEmail(settings.notifyEmail)) {
    // One email per handoff; the thread stays NEEDS_HUMAN afterwards, so this
    // fires again only if someone hands it back to the bot and it hands off
    // again. The throttle key guards against a retried job double-sending.
    await sendThrottledNotifyEmail(`handoff-${conversation.id}`, 60 * 60, {
      to: settings.notifyEmail,
      subject: `【@${account.username}】有一則私訊需要你親自回覆`,
      text: [
        `@${account.username} 的問答機器人答不了這個問題，已經回覆對方：`,
        `「${decision.text}」`,
        "",
        "對方的訊息：",
        input.messageText.slice(0, 500),
        "",
        "請直接打開 Instagram App 回覆對方。你一回覆，機器人就會自動停止回這個人。",
        "",
        "（這封信由 OpenReply 自動寄出）",
      ].join("\n"),
    }).catch(() => {});
  }

  if (decision.kind !== "answered" && lineNotifyEnabledFor(account.instagramId)) {
    const who = await prisma.conversation
      .findUnique({ where: { id: conversation.id }, select: { senderName: true } })
      .then((c) => c?.senderName)
      .catch(() => null);
    const urgent = decision.kind === "crisis";
    const alert = urgent
      ? `【緊急】"${who ?? "有客人"}" 的訊息可能涉及自我傷害，請盡快親自關心`
      : `"${who ?? "有客人"}" 需要你回復\n${lineAlertSummary(question)}`;
    const sent = await pushThrottledLineMessage(
      // Per message: a repeat handoff (never two in a row) alerts again.
      `${urgent ? "crisis" : "handoff"}-${conversation.id}-${input.messageId}`,
      urgent ? 10 * 60 : 60 * 60,
      alert
    );
    // Still unanswered an hour later: one more nudge, then never again.
    if (sent) await scheduleLineReminder(conversation.id, alert);
  }

  return decision.kind === "answered"
    ? { kind: "answered", text: decision.text, cached: result.cached }
    : { kind: decision.kind, text: decision.text };
}
