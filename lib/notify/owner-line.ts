/**
 * LINE alerts to the owner about the system itself: something stopped, a bill
 * is coming, credit is running low. Each problem is remembered in Redis, so
 * the first success afterwards sends a "back to normal" message once.
 *
 * Uses the same LINE_CHANNEL_ACCESS_TOKEN / LINE_NOTIFY_USER_ID as the
 * customer handoff alerts; set them on Vercel too for the daily checks.
 */

import { getRedisConnection } from "@/lib/queue/client";
import { pushLineMessage } from "./line";

const PREFIX = "openreply:owner-alert:";
/** A problem left unresolved is still reported again once a day. */
const REPEAT_SECONDS = 24 * 60 * 60;
/** How long a problem stays remembered for the recovery message. */
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;

/** Report a problem; repeats at most once a day while it lasts. */
export async function reportProblem(key: string, text: string): Promise<void> {
  try {
    if (process.env.REDIS_URL) {
      const redis = getRedisConnection();
      await redis.set(`${PREFIX}open:${key}`, "1", "EX", REMEMBER_SECONDS);
      const fresh = await redis.set(`${PREFIX}sent:${key}`, "1", "EX", REPEAT_SECONDS, "NX");
      if (fresh !== "OK") return;
    }
  } catch {
    // fall through and send
  }
  await pushLineMessage(`⚠️ ${text}`);
}

/** Things work again: tell the owner once, only if a problem was reported. */
export async function resolveProblem(key: string, text: string): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    const redis = getRedisConnection();
    const removed = await redis.del(`${PREFIX}open:${key}`);
    if (removed !== 1) return;
    await redis.del(`${PREFIX}sent:${key}`);
  } catch {
    return;
  }
  await pushLineMessage(`✅ ${text}`);
}

/** A one-off reminder (a bill date, a credit level), sent once per key. */
export async function remindOnce(key: string, text: string, ttlSeconds = 60 * 24 * 60 * 60): Promise<void> {
  try {
    if (process.env.REDIS_URL) {
      const fresh = await getRedisConnection().set(`${PREFIX}once:${key}`, "1", "EX", ttlSeconds, "NX");
      if (fresh !== "OK") return;
    }
  } catch {
    // fall through and send
  }
  await pushLineMessage(`🔔 ${text}`);
}
