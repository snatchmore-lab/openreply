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
} from "@/lib/instagram/provider";
import { isLatestInboundMessage } from "@/lib/instagram/sent-mids";
import { getPageUserName } from "@/lib/meta/client";
import { lineNotifyEnabledFor, pushThrottledLineMessage } from "@/lib/notify/line";
import { scheduleNudge } from "./nudge";
import { completeJson } from "./service";
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
  const result = await completeJson({
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
        | "superseded";
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
export function decideFaqReply(
  output: { answer: string; confident: boolean; crisis?: boolean } | null,
  settings: Pick<FaqSettings, "handoffMessage" | "maxReplyChars" | "maxLineWidth">
):
  | { kind: "answered"; text: string }
  | { kind: "handoff"; text: string }
  | { kind: "crisis"; text: string } {
  // Safety first: a crisis never gets a knowledge-base answer.
  if (output?.crisis) return { kind: "crisis", text: CRISIS_MESSAGE };
  const handoff = settings.handoffMessage.trim() || DEFAULT_HANDOFF_MESSAGE;
  if (!output || !output.confident) return { kind: "handoff", text: handoff };
  const text = sanitizeAnswer(output.answer, settings.maxReplyChars, settings.maxLineWidth);
  if (!text) return { kind: "handoff", text: handoff };
  return { kind: "answered", text };
}

/**
 * The account owner replied from the Instagram app (an echo whose message id
 * this system never sent). Hand the thread to the human: the bot goes silent
 * and the dashboard shows "Taken over". Only threads the bot has already
 * touched are affected; a human replying in a thread the bot never saw
 * creates nothing. The human's text is kept so the bot's later context and
 * the dashboard history include it.
 */
export async function handleHumanEcho(input: {
  instagramAccountId: string; // IG user id (instagramId), as in the webhook
  recipientId: string;
  messageId: string;
  messageText: string;
}): Promise<"taken-over" | "already-human" | "no-thread"> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      senderId: input.recipientId,
      instagramAccount: { instagramId: input.instagramAccountId },
    },
    select: { id: true, status: true },
  });
  if (!conversation) return "no-thread";

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
  if (recentReplies >= Math.max(1, settings.hourlyLimitPerUser)) {
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

  const tone = normalizeTone(settings.tone);
  const maxChars = Math.min(1000, Math.max(50, settings.maxReplyChars));

  const result = await completeJson({
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

  const decision = decideFaqReply(result.result, settings);

  // Already handed off: never repeat the handoff line or its email. Only a
  // real answer (or a crisis reply) goes out.
  if (afterHandoff && decision.kind === "handoff") {
    return { kind: "silent", reason: "not-ai-state" };
  }

  // The person may have sent more while the model was writing; that newer
  // message's job answers everything, this draft is dropped.
  if (!(await isLatestInboundMessage(input.instagramAccountId, input.senderId, input.messageId))) {
    return { kind: "silent", reason: "superseded" };
  }

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
    return { kind: "silent", reason: "send-failed" };
  }

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
        ...(needsHuman && !afterHandoff
          ? { status: "NEEDS_HUMAN", needsHumanAt: new Date() }
          : {}),
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
    await pushThrottledLineMessage(
      `${urgent ? "crisis" : "handoff"}-${conversation.id}`,
      urgent ? 10 * 60 : 60 * 60,
      urgent
        ? `【緊急】"${who ?? "有客人"}" 的訊息可能涉及自我傷害，請盡快親自關心`
        : `"${who ?? "有客人"}" 需要你回復\n${lineAlertSummary(question)}`
    );
  }

  return decision.kind === "answered"
    ? { kind: "answered", text: decision.text, cached: result.cached }
    : { kind: decision.kind, text: decision.text };
}
