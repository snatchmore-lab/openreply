/**
 * AI keyword matching (feature 1).
 *
 * Called only after the exact matcher (lib/utils/keyword-matcher.ts) has
 * already said no, and only for campaigns with `aiMatchEnabled`. The verdict
 * is returned whole so the worker can write it into DmLog.aiDecision for
 * later review, whether or not it counted as a hit.
 */

import { z } from "zod";
import { completeJson, type AiSkipReason } from "./service";
import { buildMatchUserPrompt, MATCH_SYSTEM_PROMPT } from "./prompts";

export const DEFAULT_AI_MATCH_THRESHOLD = 0.8;

const MatchVerdict = z.object({
  match: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});

export type AiMatchDecision = {
  /** True only when the model said match AND confidence >= threshold. */
  matched: boolean;
  match: boolean;
  confidence: number;
  reason: string;
  threshold: number;
  model: string;
  cached: boolean;
};

export type AiMatchOutcome =
  | { kind: "decision"; decision: AiMatchDecision }
  | { kind: "skipped"; reason: AiSkipReason; detail?: string };

export interface AiMatchCampaign {
  id: string;
  workspaceId: string;
  keywords: string[];
  aiMatchThreshold: number;
  aiMatchDescription: string | null;
}

export async function aiMatch(
  text: string,
  campaign: AiMatchCampaign,
  channel: "comment" | "dm"
): Promise<AiMatchOutcome> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      kind: "decision",
      decision: {
        matched: false,
        match: false,
        confidence: 0,
        reason: "empty message",
        threshold: campaign.aiMatchThreshold,
        model: "none",
        cached: true,
      },
    };
  }

  const outcome = await completeJson({
    feature: "match",
    workspaceId: campaign.workspaceId,
    system: MATCH_SYSTEM_PROMPT,
    user: buildMatchUserPrompt({
      commentText: trimmed.slice(0, 2000),
      keywords: campaign.keywords,
      description: campaign.aiMatchDescription,
      channel,
    }),
    schema: MatchVerdict,
    // The threshold is applied after the call, so it is deliberately NOT part
    // of the cache key: changing it in the UI reuses existing verdicts.
    cacheScope: [],
    maxTokens: 1024,
  });

  if (!outcome.ok) {
    return { kind: "skipped", reason: outcome.reason, detail: outcome.detail };
  }

  const { match, confidence, reason } = outcome.result;
  const threshold = clampThreshold(campaign.aiMatchThreshold);
  return {
    kind: "decision",
    decision: {
      matched: match && confidence >= threshold,
      match,
      confidence,
      reason,
      threshold,
      model: outcome.model,
      cached: outcome.cached,
    },
  };
}

export function clampThreshold(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AI_MATCH_THRESHOLD;
  }
  return Math.min(1, Math.max(0, value));
}
