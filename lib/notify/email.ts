/**
 * Plain notification emails (not login links). Uses the same delivery the
 * magic-link sign-in uses: EMAIL_SERVER (SMTP) when set, otherwise Resend's
 * HTTP API with RESEND_API_KEY. Never throws: a failed notification must not
 * break the DM pipeline that triggered it.
 */

import { getRedisConnection } from "@/lib/queue/client";

export interface NotifyEmail {
  to: string;
  subject: string;
  text: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string | null | undefined): value is string {
  return Boolean(value && EMAIL_PATTERN.test(value.trim()));
}

export async function sendNotifyEmail(mail: NotifyEmail): Promise<boolean> {
  if (!isValidEmail(mail.to)) return false;
  const from = process.env.EMAIL_FROM ?? "OpenReply <login@example.com>";

  try {
    if (process.env.EMAIL_SERVER) {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport(process.env.EMAIL_SERVER);
      await transport.sendMail({ from, to: mail.to.trim(), subject: mail.subject, text: mail.text });
      return true;
    }

    const key = process.env.RESEND_API_KEY;
    if (!key) return false;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [mail.to.trim()], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) {
      console.error(`[notify] Email send failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[notify] Email send failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Send at most once per `windowSeconds` for a given key, so a burst of the
 * same problem (every AI call failing, say) produces one email, not hundreds.
 * Redis down → send anyway; an occasional duplicate beats a missed alert.
 */
export async function sendThrottledNotifyEmail(
  throttleKey: string,
  windowSeconds: number,
  mail: NotifyEmail
): Promise<boolean> {
  try {
    if (process.env.REDIS_URL) {
      const claimed = await getRedisConnection().set(
        `openreply:notify:${throttleKey}`,
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
  return sendNotifyEmail(mail);
}
