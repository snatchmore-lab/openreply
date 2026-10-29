/**
 * Daily owner reminders, run from the daily cron:
 *
 *   RAILWAY_TRIAL_ENDS=2026-11-21   the date Railway starts charging (or the
 *                                   trial credit ends); reminded 7 and 2 days
 *                                   before
 *   AI_CREDIT_USD=10                the Anthropic balance after the last top-up
 *   AI_CREDIT_SINCE=2026-10-26      the day of that top-up; reminded at 80%
 *                                   and 95% of estimated spend
 *
 * Anthropic does not expose the balance, so spend is estimated from the
 * tokens this app recorded, at the AI model's list price.
 */

import { prisma } from "@/lib/db/client";
import { remindOnce } from "./owner-line";

/** US$ per million tokens for the default model (claude-haiku-5-5). */
const INPUT_USD_PER_MTOK = 0.1;
const OUTPUT_USD_PER_MTOK = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const date = new Date(`${value.trim()}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function runDailyOwnerChecks(now = new Date()): Promise<void> {
  const trialEnds = parseDate(process.env.RAILWAY_TRIAL_ENDS);
  if (trialEnds) {
    const daysLeft = Math.ceil((trialEnds.getTime() - now.getTime()) / DAY_MS);
    for (const threshold of [7, 2]) {
      if (daysLeft <= threshold && daysLeft >= 0) {
        await remindOnce(
          `railway-${process.env.RAILWAY_TRIAL_ENDS}-${threshold}`,
          `Railway 再 ${daysLeft} 天要開始收費了（${process.env.RAILWAY_TRIAL_ENDS}）\n沒有設定付款的話，自動回覆會停止\n請登入 railway.com 選方案或確認付款方式`
        );
        break;
      }
    }
  }

  const credit = Number(process.env.AI_CREDIT_USD);
  const since = parseDate(process.env.AI_CREDIT_SINCE);
  if (credit > 0 && since) {
    const usage = await prisma.aiUsage.aggregate({
      where: { date: { gte: new Date(since.getTime() - DAY_MS) } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    const spent =
      ((usage._sum.inputTokens ?? 0) * INPUT_USD_PER_MTOK + (usage._sum.outputTokens ?? 0) * OUTPUT_USD_PER_MTOK) / 1e6;
    const used = spent / credit;
    for (const percent of [95, 80]) {
      if (used * 100 >= percent) {
        await remindOnce(
          `ai-credit-${process.env.AI_CREDIT_SINCE}-${percent}`,
          `AI 額度大約用了 ${Math.round(used * 100)}%（估計 US$${spent.toFixed(2)} / US$${credit}）\n用完機器人會暫停回覆，請到 console.anthropic.com 的 Billing 儲值\n儲值後跟我說，我更新提醒的基準`
        );
        break;
      }
    }
  }
}
