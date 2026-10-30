/**
 * BullMQ Queue Client
 *
 * Provides the DM processing queue and Redis connection for BullMQ.
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
  }
  return connection;
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

export type CommentSource = "WEBHOOK" | "POLLING";

export interface ProcessCommentJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  // Set when the comment came from an ad: the organic post the ad was made
  // from. Campaigns are bound to that post, so both ids have to be matched.
  originalMediaId?: string;
  requeueAttempt?: number;
  // Human-like pacing: the first pass sends the DM and leaves the public reply
  // to a second, later pass of the same job (`publicReplyOnly`), delayed by
  // `publicReplyDelayMs`. Absent on reconciler jobs, which keep the old order.
  deferPublicReply?: boolean;
  publicReplyDelayMs?: number;
  publicReplyOnly?: boolean;
  // Which path enqueued this comment. It is not copied to ProcessedComment or
  // used for reconciliation dedup.
  source?: CommentSource;
}

// Delivered when a user taps an opening DM's button — carries the reveal target.
export interface ProcessPostbackJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  fallback?: boolean;
  // Set on the delayed second pass of a follow-gate check. Instagram does not
  // report a brand-new follow immediately, so the first `false` is re-checked
  // later instead of rejecting the tap outright.
  followRecheck?: boolean;
  // How many delayed re-checks have run, counting this one. Absent on jobs
  // queued before re-checks were counted, where `followRecheck` meant one.
  followRecheckAttempt?: number;
}

// Scheduled after the link is delivered, to send the appreciation follow-up.
// Enqueued with a delay (followUpDelayMinutes) so it can fire later, not just
// immediately.
export interface ProcessFollowUpJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  userId: string;
  automationId: string;
  commenterName?: string | null;
}

// An inbound DM from a user. Campaigns with `dmTriggerEnabled` whose keywords
// match the text reply to the sender.
export interface ProcessMessageJob {
  accountConnectionId?: string;
  instagramAccountId: string;
  messageId: string;
  messageText: string;
  senderId: string;
  /** When the webhook received it; a job run long after is a catch-up, not a reply. */
  receivedAt?: number;
}

// One hour after a person tapped an ad button: if they have said nothing
// else, the FAQ bot sends the account's follow-up line once.
export interface FaqNudgeJob {
  accountConnectionId?: string;
  instagramAccountId: string; // instagramId, as in the webhook
  conversationId: string;
  messageId: string;
  /** "ad": silent ad-button tap (default). "quiet": went quiet after the bot answered. */
  kind?: "ad" | "quiet";
}

// One hour after a handoff alert: remind the owner on LINE if still unanswered.
export interface LineRemindJob {
  accountConnectionId?: string;
  instagramAccountId?: string;
  conversationId: string;
  handoffAt: string;
  text: string;
}

export type DmQueueJob =
  | ProcessCommentJob
  | ProcessPostbackJob
  | ProcessFollowUpJob
  | ProcessMessageJob
  | FaqNudgeJob
  | LineRemindJob;

export const POSTBACK_JOB_NAME = "process-postback";
export const FOLLOWUP_JOB_NAME = "process-followup";
export const MESSAGE_JOB_NAME = "process-message";
export const FAQ_NUDGE_JOB_NAME = "faq-nudge";
export const LINE_REMIND_JOB_NAME = "line-remind";

let dmQueue: Queue<DmQueueJob> | null = null;

export function getDMQueue(): Queue<DmQueueJob> {
  if (!dmQueue) {
    dmQueue = new Queue<DmQueueJob>("dm-processing", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        // Clear failed jobs shortly after they exhaust retries. Job ids are
        // deterministic (comment_<acct>_<id>), so a retained failed job would
        // block the polling reconciler from ever retrying that comment. Clearing
        // them lets a later sweep re-enqueue and try again once a transient
        // failure (e.g. an Instagram rate-limit window) has passed. Failure
        // detail is still preserved in DmLog.
        removeOnFail: { age: 300, count: 2000 },
        attempts: 3,
        backoff: {
          type: "custom",
        },
      },
    });
  }
  return dmQueue;
}
