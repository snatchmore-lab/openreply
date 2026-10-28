/**
 * Remember the ids of messages this system sent, for a short while.
 *
 * Instagram echoes every outbound message back through the webhook, whether
 * it was sent by this app or by the account owner typing in the Instagram
 * app. The two look identical on the wire. Keeping our own ids for a few
 * minutes lets the webhook tell them apart: an echo we did not send means a
 * human replied, and the FAQ bot must step back from that thread.
 *
 * Redis is best-effort here: if it is unavailable, sends still succeed and an
 * echo is treated as human, which only ever makes the bot quieter.
 */

import { getRedisConnection } from "@/lib/queue/client";

const TTL_SECONDS = 15 * 60;
const KEY_PREFIX = "openreply:sent-mid:";

export async function rememberSentMessageId(
  messageId: string | null | undefined
): Promise<void> {
  if (!messageId || !process.env.REDIS_URL) return;
  try {
    await getRedisConnection().set(KEY_PREFIX + messageId, "1", "EX", TTL_SECONDS);
  } catch {
    // Best-effort; see module comment.
  }
}

export async function wasSentByUs(messageId: string): Promise<boolean> {
  if (!process.env.REDIS_URL) return false;
  try {
    return (await getRedisConnection().exists(KEY_PREFIX + messageId)) === 1;
  } catch {
    return false;
  }
}

/** Await a send, record its message id, pass the result through unchanged. */
export async function trackSent<T extends { message_id?: string } | undefined>(
  send: Promise<T>
): Promise<T> {
  const result = await send;
  void rememberSentMessageId(result?.message_id);
  return result;
}

/**
 * Meta's own automations (Page instant replies, saved-reply templates, ad
 * welcome flows) answer within a few seconds of the customer's message and
 * echo back like a human reply. A person never answers that fast, so an echo
 * inside this window after the customer's last inbound message is treated as
 * an automation and does not take the thread away from the bot.
 */
const AUTOMATION_WINDOW_SECONDS = 15;
const INBOUND_PREFIX = "openreply:inbound:";

/**
 * The newest inbound message id per person. The FAQ bot waits a few seconds
 * after each message and only the job for the newest one answers, covering
 * everything the person sent in a row.
 */
const LATEST_PREFIX = "openreply:latest-inbound:";
const LATEST_TTL_SECONDS = 10 * 60;

export async function rememberInboundMessage(
  accountId: string,
  senderId: string,
  messageId?: string
): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    const redis = getRedisConnection();
    await redis.set(`${INBOUND_PREFIX}${accountId}:${senderId}`, "1", "EX", AUTOMATION_WINDOW_SECONDS);
    if (messageId) {
      await redis.set(`${LATEST_PREFIX}${accountId}:${senderId}`, messageId, "EX", LATEST_TTL_SECONDS);
    }
  } catch {
    // Best-effort: without it the echo counts as human, the old behaviour.
  }
}

export async function isLikelyAutomatedEcho(accountId: string, recipientId: string): Promise<boolean> {
  if (!process.env.REDIS_URL) return false;
  try {
    return (await getRedisConnection().exists(`${INBOUND_PREFIX}${accountId}:${recipientId}`)) === 1;
  } catch {
    return false;
  }
}

/** False only when Redis knows of a newer message from this person. */
export async function isLatestInboundMessage(
  accountId: string,
  senderId: string,
  messageId: string
): Promise<boolean> {
  if (!process.env.REDIS_URL) return true;
  try {
    const latest = await getRedisConnection().get(`${LATEST_PREFIX}${accountId}:${senderId}`);
    return !latest || latest === messageId;
  } catch {
    return true;
  }
}
