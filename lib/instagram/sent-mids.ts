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
