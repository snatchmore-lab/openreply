/**
 * AI report (feature 5): per-campaign funnel including the AI matcher's
 * verdicts, plus workspace-level FAQ-bot and AI-usage totals.
 *
 * "Comments" here means comments that produced a DmLog row: exact hits, AI
 * hits and AI misses. A comment the exact matcher rejected on a campaign with
 * AI matching off never gets a row (that is stock OpenReply behaviour), so it
 * cannot be counted.
 */

import { prisma } from "@/lib/db/client";
import {
  calculateCtr,
  CLICK_ROW_SELECT,
  countUniqueClicksBy,
} from "@/lib/tracking/analytics";

export interface CampaignAiRow {
  id: string;
  name: string;
  accountUsername: string;
  isActive: boolean;
  aiMatchEnabled: boolean;
  aiOpeningEnabled: boolean;
  aiPublicReplyVary: boolean;
  comments: number;
  exactHits: number;
  aiHits: number;
  aiMisses: number;
  sent: number;
  failed: number;
  clicks: number;
  ctr: number;
  aiOpeners: number;
}

export interface AiUsageRow {
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD, estimated from the default model's list price. */
  estimatedUsd: number;
}

export interface AiReport {
  days: number;
  campaigns: CampaignAiRow[];
  conversations: {
    total: number;
    ai: number;
    needsHuman: number;
    human: number;
    aiReplies: number;
  };
  usage: AiUsageRow[];
  usageTotalUsd: number;
}

// Haiku 5.5 list price per million tokens. Cache reads are billed lower, so
// this slightly overstates cost; it is an upper bound, not an invoice.
const USD_PER_M_INPUT = 0.1;
const USD_PER_M_OUTPUT = 0.5;

function estimateUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens * USD_PER_M_INPUT + outputTokens * USD_PER_M_OUTPUT) / 1_000_000;
}

export async function getAiReport(workspaceId: string, days = 30): Promise<AiReport> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const automations = await prisma.automation.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      isActive: true,
      aiMatchEnabled: true,
      aiOpeningEnabled: true,
      aiPublicReplyVary: true,
      instagramAccount: { select: { username: true } },
    },
  });
  const ids = automations.map((a) => a.id);

  const [logs, clickRows, conversationGroups, aiReplySum, usageRows] = await Promise.all([
    prisma.dmLog.findMany({
      where: { automationId: { in: ids }, createdAt: { gte: since } },
      select: {
        automationId: true,
        status: true,
        matchSource: true,
        aiOpening: true,
        commentId: true,
      },
    }),
    prisma.linkClick.findMany({
      where: { workspaceId, automationId: { in: ids }, createdAt: { gte: since } },
      select: { ...CLICK_ROW_SELECT, automationId: true },
    }),
    prisma.conversation.groupBy({
      by: ["status"],
      where: { workspaceId },
      _count: { _all: true },
    }),
    prisma.conversation.aggregate({
      where: { workspaceId },
      _sum: { aiReplyCount: true },
    }),
    prisma.aiUsage.groupBy({
      by: ["feature"],
      where: { workspaceId, date: { gte: since } },
      _sum: { calls: true, inputTokens: true, outputTokens: true },
    }),
  ]);

  const clicksByCampaign = countUniqueClicksBy(clickRows, (row) => row.automationId);

  const byCampaign = new Map<string, Omit<CampaignAiRow, "id" | "name" | "accountUsername" | "isActive" | "aiMatchEnabled" | "aiOpeningEnabled" | "aiPublicReplyVary" | "ctr" | "clicks">>();
  for (const id of ids) {
    byCampaign.set(id, {
      comments: 0,
      exactHits: 0,
      aiHits: 0,
      aiMisses: 0,
      sent: 0,
      failed: 0,
      aiOpeners: 0,
    });
  }
  for (const log of logs) {
    const row = byCampaign.get(log.automationId);
    if (!row) continue;
    row.comments += 1;
    if (log.status === "SKIPPED_AI_NO_MATCH") {
      row.aiMisses += 1;
    } else if (log.matchSource === "AI") {
      row.aiHits += 1;
    } else {
      // "EXACT", or rows written before matchSource existed.
      row.exactHits += 1;
    }
    if (log.status === "SENT") row.sent += 1;
    if (log.status === "FAILED") row.failed += 1;
    if (log.aiOpening) row.aiOpeners += 1;
  }

  const campaigns: CampaignAiRow[] = automations.map((a) => {
    const counts = byCampaign.get(a.id)!;
    const clicks = clicksByCampaign.get(a.id) ?? 0;
    return {
      id: a.id,
      name: a.name,
      accountUsername: a.instagramAccount.username,
      isActive: a.isActive,
      aiMatchEnabled: a.aiMatchEnabled,
      aiOpeningEnabled: a.aiOpeningEnabled,
      aiPublicReplyVary: a.aiPublicReplyVary,
      ...counts,
      clicks,
      ctr: calculateCtr(clicks, counts.sent),
    };
  });

  const statusCount = (status: "AI" | "NEEDS_HUMAN" | "HUMAN") =>
    conversationGroups.find((g) => g.status === status)?._count._all ?? 0;
  const conversations = {
    ai: statusCount("AI"),
    needsHuman: statusCount("NEEDS_HUMAN"),
    human: statusCount("HUMAN"),
    total: 0,
    aiReplies: aiReplySum._sum.aiReplyCount ?? 0,
  };
  conversations.total = conversations.ai + conversations.needsHuman + conversations.human;

  const usage: AiUsageRow[] = usageRows
    .map((u) => {
      const inputTokens = u._sum.inputTokens ?? 0;
      const outputTokens = u._sum.outputTokens ?? 0;
      return {
        feature: u.feature,
        calls: u._sum.calls ?? 0,
        inputTokens,
        outputTokens,
        estimatedUsd: estimateUsd(inputTokens, outputTokens),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  return {
    days,
    campaigns,
    conversations,
    usage,
    usageTotalUsd: usage.reduce((sum, u) => sum + u.estimatedUsd, 0),
  };
}
