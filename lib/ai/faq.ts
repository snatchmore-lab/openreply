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
  sendDirectMessage,
} from "@/lib/instagram/provider";
import { completeJson } from "./service";
import { stripFullStops } from "./text";
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

const FaqOutput = z.object({
  answer: z.string().max(2000),
  confident: z.boolean(),
});

export interface FaqSettings {
  faqEnabled: boolean;
  knowledgeBase: string;
  handoffMessage: string;
  hourlyLimitPerUser: number;
  tone: string;
  maxReplyChars: number;
  notifyEmail?: string | null;
}

/**
 * Dry run for the dashboard test bench: same prompt, same decision rules, no
 * conversation state, nothing sent. Uses the settings as typed in the form,
 * so the owner can try an unsaved knowledge base.
 */
export async function previewFaqAnswer(input: {
  workspaceId: string;
  question: string;
  settings: Pick<FaqSettings, "knowledgeBase" | "handoffMessage" | "tone" | "maxReplyChars">;
}): Promise<
  | { kind: "answered" | "handoff"; text: string }
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
  | {
      kind: "silent";
      reason:
        | "disabled"
        | "duplicate"
        | "no-account"
        | "not-ai-state"
        | "hourly-limit"
        | "ai-unavailable"
        | "send-failed";
    };

/** Same clean-up as the opener, minus the URL strip: KB URLs are allowed. */
export function sanitizeAnswer(raw: string, maxChars: number): string | null {
  let text = stripFullStops(raw).replace(/\{[a-z_]+\}/gi, "").replace(/\s+/g, " ").trim();
  text = text.replace(/^["「『“]+/, "").replace(/["」』”]+$/, "").trim();
  if (!text) return null;
  if ([...text].length > maxChars) text = [...text].slice(0, maxChars).join("").trimEnd();
  return text || null;
}

/**
 * Pure decision: given the model's output, what goes out?
 * Exposed for tests.
 */
export function decideFaqReply(
  output: { answer: string; confident: boolean } | null,
  settings: Pick<FaqSettings, "handoffMessage" | "maxReplyChars">
): { kind: "answered"; text: string } | { kind: "handoff"; text: string } {
  const handoff = settings.handoffMessage.trim() || DEFAULT_HANDOFF_MESSAGE;
  if (!output || !output.confident) return { kind: "handoff", text: handoff };
  const text = sanitizeAnswer(output.answer, settings.maxReplyChars);
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

  if (conversation.status !== "AI") {
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

  const historyRows = await prisma.conversationMessage.findMany({
    where: { conversationId: conversation.id, messageId: { not: input.messageId } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_TURNS,
    select: { direction: true, text: true },
  });
  const history: FaqHistoryItem[] = historyRows
    .reverse()
    .map((m) => ({ role: m.direction === "IN" ? "user" : "assistant", text: m.text }));

  const tone = normalizeTone(settings.tone);
  const maxChars = Math.min(1000, Math.max(50, settings.maxReplyChars));

  const result = await completeJson({
    feature: "faq",
    workspaceId: account.workspaceId,
    system: FAQ_SYSTEM_PROMPT,
    context: buildFaqContextBlock(settings.knowledgeBase),
    user: buildFaqUserPrompt({
      question: input.messageText.slice(0, 1000),
      history,
      tone,
      maxChars,
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

  const aiMeta = {
    confident: decision.kind === "answered",
    handoff: decision.kind === "handoff",
    cached: result.cached,
    model: result.model,
  };
  await prisma.$transaction([
    prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        direction: "OUT_AI",
        text: decision.text,
        aiMeta: aiMeta as unknown as Prisma.InputJsonValue,
      },
    }),
    prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        aiReplyCount: { increment: 1 },
        ...(decision.kind === "handoff"
          ? { status: "NEEDS_HUMAN", needsHumanAt: new Date() }
          : {}),
      },
    }),
  ]);

  if (decision.kind === "handoff" && isValidEmail(settings.notifyEmail)) {
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

  return decision.kind === "answered"
    ? { kind: "answered", text: decision.text, cached: result.cached }
    : { kind: "handoff", text: decision.text };
}
