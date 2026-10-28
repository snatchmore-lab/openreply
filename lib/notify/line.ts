/**
 * LINE alerts for the account owner, through a LINE Official Account's
 * Messaging API (LINE Notify was shut down in 2025).
 *
 * Env:
 *   LINE_CHANNEL_ACCESS_TOKEN  long-lived channel access token
 *   LINE_NOTIFY_USER_ID        the owner's LINE user id ("Your user ID" on the
 *                              channel's Basic settings page)
 *   LINE_NOTIFY_ACCOUNT_IDS    comma-separated Instagram/Page ids (instagramId)
 *                              whose handoffs are sent to LINE
 *
 * Best-effort: a LINE failure never affects the reply or the email.
 */

import { getRedisConnection } from "@/lib/queue/client";

const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const MAX_TEXT = 1000;

export function lineNotifyEnabledFor(instagramId: string): boolean {
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN || !process.env.LINE_NOTIFY_USER_ID) return false;
  return (process.env.LINE_NOTIFY_ACCOUNT_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .includes(instagramId);
}

export async function pushLineMessage(text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_NOTIFY_USER_ID;
  if (!token || !to) return false;
  try {
    const response = await fetch(PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, MAX_TEXT) }] }),
    });
    if (!response.ok) {
      console.error("[LINE] push failed:", response.status, (await response.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (error) {
    console.error("[LINE] push failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** One LINE message per throttle key and window, like the handoff email. */
export async function pushThrottledLineMessage(
  throttleKey: string,
  windowSeconds: number,
  text: string
): Promise<boolean> {
  try {
    if (process.env.REDIS_URL) {
      const claimed = await getRedisConnection().set(
        `openreply:line:${throttleKey}`,
        "1",
        "EX",
        windowSeconds,
        "NX"
      );
      if (claimed !== "OK") return false;
    }
  } catch {
    // fall through and send
  }
  return pushLineMessage(text);
}
