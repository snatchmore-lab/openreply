import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { refreshLongLivedToken } from "@/lib/meta/client";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { alertWorkerDown } from "@/lib/notify/alerts";
import { reportProblem, resolveProblem } from "@/lib/notify/owner-line";
import { runDailyOwnerChecks } from "@/lib/notify/daily-checks";

const DAYS_BEFORE_EXPIRY = 10;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  // Daily watchdog: the worker cannot report its own death, so the web app's
  // daily cron checks its heartbeat and emails every workspace owner with a
  // connected account when it is gone (most often: Railway credit ran out).
  try {
    const worker = await getWorkerHealth();
    if (!worker.healthy) {
      const workspaces = await prisma.instagramAccount.findMany({
        distinct: ["workspaceId"],
        select: { workspaceId: true },
      });
      for (const { workspaceId } of workspaces) {
        await alertWorkerDown(workspaceId, worker.heartbeat?.checkedAt ?? null);
      }
    } else {
      await resolveProblem("worker", "自動回覆已恢復運作（worker 正常）");
    }
  } catch (error) {
    console.error("[cron] Worker watchdog failed:", error instanceof Error ? error.message : error);
  }

  // Bills and credit coming due: one LINE reminder each.
  await runDailyOwnerChecks().catch((error: unknown) => {
    console.error("[cron] Owner checks failed:", error instanceof Error ? error.message : error);
  });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + DAYS_BEFORE_EXPIRY);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const usageReset = await prisma.workspace.updateMany({
    where: { usagePeriodStart: { lt: monthStart } },
    data: {
      usagePeriodStart: monthStart,
      dmsSentThisPeriod: 0,
    },
  });

  const accountsToRefresh = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      provider: "META",
      tokenExpiresAt: {
        not: null,
        lte: cutoffDate,
      },
    },
    select: {
      id: true,
      workspaceId: true,
      username: true,
      accessToken: true,
    },
  });

  const results: Array<{
    instagramAccountId: string;
    username: string;
    status: "refreshed" | "failed";
    error?: string;
  }> = [];

  for (const account of accountsToRefresh) {
    try {
      const currentToken = decryptToken(account.accessToken);
      const { accessToken: newToken, expiresIn } =
        await refreshLongLivedToken(currentToken);
      const encryptedToken = encryptToken(newToken);
      const newExpiry = new Date(Date.now() + expiresIn * 1000);

      await prisma.instagramAccount.update({
        where: { id: account.id },
        data: {
          accessToken: encryptedToken,
          tokenExpiresAt: newExpiry,
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "refreshed",
      });
      await resolveProblem(`token-${account.id}`, `@${account.username} 的授權已更新，恢復正常`).catch(() => {});
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      await prisma.operationalEvent.create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "ERROR",
          message: `Token refresh failed for @${account.username}: ${errorMessage}`,
          payload: {
            instagramAccountId: account.id,
            username: account.username,
          },
        },
      });

      results.push({
        instagramAccountId: account.id,
        username: account.username,
        status: "failed",
        error: errorMessage,
      });
      await reportProblem(
        `token-${account.id}`,
        `@${account.username} 的 Instagram 授權更新失敗，到期後自動回覆會停止${String.fromCharCode(10)}請到 OpenReply 設定頁重新連接這個帳號`
      ).catch(() => {});
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      totalProcessed: accountsToRefresh.length,
      workspacesReset: usageReset.count,
      results,
    },
  });
}
