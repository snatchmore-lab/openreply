/**
 * Owner alerts: problems that silently stop the automation and need a person.
 * Sent to the workspace owner's sign-in email, throttled to one per problem
 * per day.
 */

import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { sendThrottledNotifyEmail } from "./email";

const ONE_DAY = 24 * 60 * 60;

async function ownerEmail(workspaceId: string): Promise<string | null> {
  const ws = await prisma.workspace
    .findUnique({ where: { id: workspaceId }, select: { owner: { select: { email: true } } } })
    .catch(() => null);
  return ws?.owner.email ?? null;
}

export async function alertAiUnavailable(
  workspaceId: string,
  kind: "credit" | "key"
): Promise<void> {
  const to = await ownerEmail(workspaceId);
  if (!to) return;
  const subject =
    kind === "credit"
      ? "【OpenReply】AI 額度用完了，AI 功能已暫停"
      : "【OpenReply】AI 金鑰失效，AI 功能已暫停";
  const reason =
    kind === "credit"
      ? "Anthropic 帳戶餘額不足，AI 呼叫被拒絕。"
      : "Anthropic 拒絕了目前的 AI_API_KEY（可能被撤銷或打錯）。";
  await sendThrottledNotifyEmail(`ai-${kind}-${workspaceId}`, ONE_DAY, {
    to,
    subject,
    text: [
      reason,
      "",
      "目前的影響：AI 智慧比對、AI 開場、問答機器人、AI 微調字句都會自動退回不用 AI。",
      "一般關鍵字比對和自動私訊照常運作，不會中斷。",
      "",
      kind === "credit"
        ? "處理方式：到 https://console.anthropic.com 的 Billing 儲值。儲值後不用重新部署，下一則就會恢復。"
        : "處理方式：到 https://console.anthropic.com 建立新金鑰，更新 Railway 和 Vercel 的 AI_API_KEY。",
      "",
      `後台：${getBaseUrl()}`,
      "（同一個問題一天最多通知一次）",
    ].join("\n"),
  });
}

export async function alertWorkerDown(
  workspaceId: string,
  lastSeen: string | null
): Promise<void> {
  const to = await ownerEmail(workspaceId);
  if (!to) return;
  await sendThrottledNotifyEmail(`worker-down-${workspaceId}`, ONE_DAY, {
    to,
    subject: "【OpenReply】自動私訊已停止運作（worker 沒有回應）",
    text: [
      "負責發送私訊的 worker（Railway 上的 openreply 服務）沒有回應。",
      lastSeen ? `最後一次回報時間：${lastSeen}` : "沒有任何回報紀錄。",
      "",
      "目前的影響：留言會被記錄，但不會發出任何私訊。",
      "",
      "最常見的原因是 Railway 的免費試用額度用完，或付款方式失效。",
      "處理方式：登入 https://railway.com 看 openreply 服務的狀態與帳單。",
      "",
      `系統狀態頁：${getBaseUrl()}/api/health`,
      "（同一個問題一天最多通知一次）",
    ].join("\n"),
  });
}
