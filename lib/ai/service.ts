/**
 * The only module that talks to an LLM. Every AI feature goes through
 * `completeJson`, which adds the three guards the features share:
 *
 *   1. Off switch — no AI_API_KEY means every call returns `disabled` and the
 *      caller falls back to the non-AI path. Nothing else in the app has to
 *      check the key.
 *   2. Cache — the same inputs never cost a second call (AiCache table).
 *   3. Daily cap — AI_DAILY_CALL_LIMIT calls per workspace per UTC day across
 *      all features (AiUsage table). Over the cap, calls return `limit` and the
 *      caller falls back, so a viral post cannot run up the bill.
 *
 * Swapping the model or the provider is a change to this file only.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import type { z } from "zod";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { alertAiUnavailable, resolveAiProblems } from "@/lib/notify/alerts";

export const DEFAULT_AI_MODEL = "claude-haiku-5-5";
export const DEFAULT_DAILY_CALL_LIMIT = 2000;

export type AiFeature = "match" | "opening" | "faq" | "vary";

export type AiSkipReason = "disabled" | "limit" | "error";

export interface AiUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export type AiResult<T> =
  | { ok: true; result: T; cached: boolean; model: string; usage: AiUsageInfo | null }
  | { ok: false; reason: AiSkipReason; detail?: string };

export interface CompleteJsonOptions<T> {
  feature: AiFeature;
  workspaceId: string;
  system: string;
  /**
   * Optional second system block, cached separately from `system`. Meant for
   * per-workspace reference text (the FAQ knowledge base) that is large,
   * changes rarely, and is shared by every call for that workspace.
   */
  context?: string;
  user: string;
  schema: z.ZodType<T>;
  /** Extra strings that identify the call for caching (campaign id, settings). */
  cacheScope?: string[];
  maxTokens?: number;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.AI_API_KEY?.trim());
}

export function getAiModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
}

export function getDailyCallLimit(): number {
  const raw = Number(process.env.AI_DAILY_CALL_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_DAILY_CALL_LIMIT;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.AI_API_KEY, maxRetries: 2 });
  }
  return client;
}

/** Exposed for tests so a fake client can be injected. */
export function __setAiClientForTests(fake: Anthropic | null) {
  client = fake;
}

/**
 * Drop cached verdicts older than `days`. Called from the worker's periodic
 * sweep so the AiCache table cannot grow without bound; a pruned entry just
 * means one more model call if the same text ever comes back.
 */
export async function pruneAiCache(days = 30): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  try {
    const result = await prisma.aiCache.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return result.count;
  } catch {
    return 0;
  }
}

export function buildCacheKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

function utcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Reserve one call against today's cap. Returns false when the workspace is
 * already at the limit. Counted before the call so a burst of concurrent
 * jobs cannot all slip under the cap at once.
 */
async function reserveDailyCall(workspaceId: string, feature: AiFeature): Promise<boolean> {
  const date = utcDay();
  const limit = getDailyCallLimit();

  const total = await prisma.aiUsage.aggregate({
    where: { workspaceId, date },
    _sum: { calls: true },
  });
  if ((total._sum.calls ?? 0) >= limit) return false;

  await prisma.aiUsage.upsert({
    where: { workspaceId_date_feature: { workspaceId, date, feature } },
    create: { workspaceId, date, feature, calls: 1 },
    update: { calls: { increment: 1 } },
  });
  return true;
}

async function recordTokens(
  workspaceId: string,
  feature: AiFeature,
  usage: AiUsageInfo
): Promise<void> {
  const date = utcDay();
  await prisma.aiUsage
    .update({
      where: { workspaceId_date_feature: { workspaceId, date, feature } },
      data: {
        inputTokens: { increment: usage.inputTokens + usage.cacheReadTokens },
        outputTokens: { increment: usage.outputTokens },
      },
    })
    .catch(() => {});
}

export async function completeJson<T>(
  options: CompleteJsonOptions<T>
): Promise<AiResult<T>> {
  if (!isAiConfigured()) return { ok: false, reason: "disabled" };

  const model = getAiModel();
  const key = buildCacheKey([
    options.feature,
    model,
    options.system,
    options.context ?? "",
    options.user,
    ...(options.cacheScope ?? []),
  ]);

  const cached = await prisma.aiCache.findUnique({ where: { key } }).catch(() => null);
  if (cached) {
    const parsed = options.schema.safeParse(cached.result);
    if (parsed.success) {
      return { ok: true, result: parsed.data, cached: true, model, usage: null };
    }
  }

  try {
    // Inside the try on purpose: a database hiccup here (or a migration that
    // has not been applied yet) must degrade to "no AI this time", not crash
    // the DM job that asked.
    const allowed = await reserveDailyCall(options.workspaceId, options.feature);
    if (!allowed) return { ok: false, reason: "limit" };

    const response = await getClient().messages.parse({
      model,
      max_tokens: options.maxTokens ?? 1024,
      // Classification-sized calls: lowest effort keeps latency and cost down.
      output_config: { effort: "low", format: zodOutputFormat(options.schema) },
      system: [
        { type: "text", text: options.system, cache_control: { type: "ephemeral" } },
        ...(options.context
          ? [
              {
                type: "text" as const,
                text: options.context,
                cache_control: { type: "ephemeral" as const },
              },
            ]
          : []),
      ],
      messages: [{ role: "user", content: options.user }],
    });

    const usage: AiUsageInfo = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    await recordTokens(options.workspaceId, options.feature, usage);
    await resolveAiProblems().catch(() => {});

    if (response.stop_reason === "refusal" || response.parsed_output == null) {
      return {
        ok: false,
        reason: "error",
        detail: response.stop_reason === "refusal" ? "refusal" : "unparseable",
      };
    }

    const result = response.parsed_output;
    await prisma.aiCache
      .upsert({
        where: { key },
        create: {
          key,
          feature: options.feature,
          result: result as unknown as Prisma.InputJsonValue,
        },
        update: { result: result as unknown as Prisma.InputJsonValue },
      })
      .catch(() => {});

    return { ok: true, result, cached: false, model, usage };
  } catch (error) {
    // Typed SDK errors first; anything else is a network or runtime failure.
    // All of them mean "fall back to the non-AI behaviour", never "crash the
    // job", so the DM pipeline keeps running without AI.
    if (error instanceof Anthropic.AuthenticationError) {
      // A rejected key silently turns every AI feature off. Make it visible on
      // the Diagnostics page instead of only in worker logs.
      await prisma.operationalEvent
        .create({
          data: {
            workspaceId: options.workspaceId,
            source: "WORKER",
            level: "ERROR",
            message: "AI_API_KEY was rejected by the AI provider; AI features are falling back to non-AI behaviour",
            payload: { feature: options.feature },
          },
        })
        .catch(() => {});
      await alertAiUnavailable(options.workspaceId, "key").catch(() => {});
      return { ok: false, reason: "error", detail: "invalid AI_API_KEY" };
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, reason: "error", detail: "rate limited by AI provider" };
    }
    // An empty prepaid balance comes back as a 400 whose message mentions the
    // credit balance. Same fallback, but the owner gets an email to top up.
    if (
      error instanceof Anthropic.BadRequestError &&
      /credit balance/i.test(error.message)
    ) {
      await alertAiUnavailable(options.workspaceId, "credit").catch(() => {});
      return { ok: false, reason: "error", detail: "AI credit balance too low" };
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, reason: "error", detail: `AI API error ${error.status}` };
    }
    return {
      ok: false,
      reason: "error",
      detail: error instanceof Error ? error.message : "unknown AI error",
    };
  }
}
