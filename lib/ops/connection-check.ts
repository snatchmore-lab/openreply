/**
 * Hourly check that Meta still lets the app reach each connected account.
 *
 * When Meta blocks the app (it asked the developer account to confirm itself
 * on 2026-10-30) or an account's authorization is revoked, webhooks simply
 * stop. Nothing fails on our side, the bot just goes quiet. So the worker asks
 * Meta directly once an hour and tells the owner on LINE, once a day while it
 * lasts and once when it works again.
 */

import { prisma } from "@/lib/db/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import { getFacebookAppId } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { reportProblem, resolveProblem } from "@/lib/notify/owner-line";
import { getRedisConnection } from "@/lib/queue/client";

const CHECK_EVERY_SECONDS = 55 * 60;

/** null: Meta could not be reached, so nothing is known either way. */
export type ConnectionCheck = { ok: true } | { ok: false; reason: string } | null;

function metaError(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" ? message.replace(/\s+/g, " ").trim().slice(0, 120) : "沒有說明原因";
}

/** A Page is reachable when our app is still subscribed to its messages. */
export function interpretPageCheck(ok: boolean, body: unknown, appId: string): ConnectionCheck {
  if (!ok) return { ok: false, reason: metaError(body) };
  const apps = (body as { data?: { id?: string; subscribed_fields?: string[] }[] } | null)?.data ?? [];
  const ours = apps.find((app) => app.id === appId);
  if (!ours?.subscribed_fields?.includes("messages")) {
    return { ok: false, reason: "粉專沒有訂閱這個 App 的訊息通知" };
  }
  return { ok: true };
}

export function interpretInstagramCheck(ok: boolean, body: unknown): ConnectionCheck {
  return ok ? { ok: true } : { ok: false, reason: metaError(body) };
}

async function checkAccount(account: {
  instagramId: string;
  provider: string;
  accessToken: string;
}): Promise<ConnectionCheck> {
  const token = encodeURIComponent(decryptToken(account.accessToken));
  const version = getMetaGraphApiVersion();
  try {
    if (account.provider === "FACEBOOK_PAGE") {
      const res = await fetch(
        `https://graph.facebook.com/${version}/${account.instagramId}/subscribed_apps?access_token=${token}`
      );
      return interpretPageCheck(res.ok, await res.json().catch(() => null), getFacebookAppId());
    }
    const res = await fetch(`https://graph.instagram.com/${version}/me?fields=user_id&access_token=${token}`);
    return interpretInstagramCheck(res.ok, await res.json().catch(() => null));
  } catch {
    return null;
  }
}

export async function checkConnections(): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    const due = await getRedisConnection().set("openreply:connection-check", "1", "EX", CHECK_EVERY_SECONDS, "NX");
    if (due !== "OK") return;
  } catch {
    return;
  }

  const accounts = await prisma.instagramAccount.findMany({
    where: { provider: { in: ["FACEBOOK_PAGE", "META"] } },
    select: { id: true, instagramId: true, username: true, name: true, provider: true, accessToken: true },
  });
  for (const account of accounts) {
    const result = await checkAccount(account).catch(() => null);
    if (!result) continue;
    const label =
      account.provider === "FACEBOOK_PAGE" ? `粉專「${account.name ?? account.username}」` : `IG @${account.username}`;
    const key = `connection-${account.id}`;
    if (result.ok) {
      await resolveProblem(key, `${label}：連線恢復正常，機器人又收得到訊息了`);
    } else {
      await reportProblem(
        key,
        [
          `${label}：機器人收不到訊息了`,
          `Meta 的回覆：${result.reason}`,
          "請到 developers.facebook.com 看是不是要確認帳號",
          "或到 OpenReply 設定頁重新連接",
        ].join("\n")
      );
    }
  }
}
