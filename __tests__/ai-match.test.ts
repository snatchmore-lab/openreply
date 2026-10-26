import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    aiCache: { findUnique: vi.fn(), upsert: vi.fn() },
    aiUsage: { aggregate: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { aiMatch } from "@/lib/ai/match";
import {
  __setAiClientForTests,
  completeJson,
  isAiConfigured,
} from "@/lib/ai/service";
import { z } from "zod";

const campaign = {
  id: "camp_1",
  workspaceId: "ws_1",
  keywords: ["open"],
  aiMatchThreshold: 0.8,
  aiMatchDescription: "免費教學影片",
};

function fakeClient(parsedOutput: unknown, stopReason = "end_turn") {
  const parse = vi.fn().mockResolvedValue({
    parsed_output: parsedOutput,
    stop_reason: stopReason,
    usage: { input_tokens: 120, output_tokens: 20, cache_read_input_tokens: 0 },
  });
  // Only the surface the service touches is faked.
  return { client: { messages: { parse } } as never, parse };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.AI_API_KEY = "test-key";
  delete process.env.AI_MODEL;
  delete process.env.AI_DAILY_CALL_LIMIT;
  mockPrisma.aiCache.findUnique.mockResolvedValue(null);
  mockPrisma.aiCache.upsert.mockResolvedValue({});
  mockPrisma.aiUsage.aggregate.mockResolvedValue({ _sum: { calls: 0 } });
  mockPrisma.aiUsage.upsert.mockResolvedValue({});
  mockPrisma.aiUsage.update.mockResolvedValue({});
});

afterEach(() => {
  __setAiClientForTests(null);
  delete process.env.AI_API_KEY;
});

describe("AI service guards", () => {
  it("is disabled without AI_API_KEY and never calls the model", async () => {
    delete process.env.AI_API_KEY;
    const { client, parse } = fakeClient({ match: true, confidence: 1, reason: "x" });
    __setAiClientForTests(client);

    expect(isAiConfigured()).toBe(false);
    const outcome = await aiMatch("open!!", campaign, "comment");

    expect(outcome).toEqual({ kind: "skipped", reason: "disabled" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("serves a cached verdict without calling the model or counting usage", async () => {
    mockPrisma.aiCache.findUnique.mockResolvedValue({
      key: "k",
      feature: "match",
      result: { match: true, confidence: 0.95, reason: "cached" },
    });
    const { client, parse } = fakeClient({ match: false, confidence: 0, reason: "live" });
    __setAiClientForTests(client);

    const outcome = await aiMatch("想要教學 🙏", campaign, "comment");

    expect(outcome.kind).toBe("decision");
    if (outcome.kind !== "decision") throw new Error("unreachable");
    expect(outcome.decision.matched).toBe(true);
    expect(outcome.decision.cached).toBe(true);
    expect(parse).not.toHaveBeenCalled();
    expect(mockPrisma.aiUsage.upsert).not.toHaveBeenCalled();
  });

  it("stops at the daily call limit", async () => {
    process.env.AI_DAILY_CALL_LIMIT = "10";
    mockPrisma.aiUsage.aggregate.mockResolvedValue({ _sum: { calls: 10 } });
    const { client, parse } = fakeClient({ match: true, confidence: 1, reason: "x" });
    __setAiClientForTests(client);

    const outcome = await aiMatch("open please", campaign, "comment");

    expect(outcome).toEqual({ kind: "skipped", reason: "limit" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("reserves a call, stores the verdict in the cache and records tokens", async () => {
    const { client, parse } = fakeClient({ match: true, confidence: 0.9, reason: "asks for it" });
    __setAiClientForTests(client);

    const result = await completeJson({
      feature: "match",
      workspaceId: "ws_1",
      system: "sys",
      user: "usr",
      schema: z.object({ match: z.boolean(), confidence: z.number(), reason: z.string() }),
    });

    expect(result.ok).toBe(true);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][0].model).toBe("claude-haiku-5-5");
    expect(mockPrisma.aiUsage.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.aiCache.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.aiUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          inputTokens: { increment: 120 },
          outputTokens: { increment: 20 },
        },
      })
    );
  });

  it("falls back on a model refusal instead of throwing", async () => {
    const { client } = fakeClient(null, "refusal");
    __setAiClientForTests(client);

    const outcome = await aiMatch("open", campaign, "comment");

    expect(outcome).toEqual({ kind: "skipped", reason: "error", detail: "refusal" });
  });

  it("falls back on a thrown provider error instead of throwing", async () => {
    const parse = vi.fn().mockRejectedValue(new Error("socket hang up"));
    __setAiClientForTests({ messages: { parse } } as never);

    const outcome = await aiMatch("open", campaign, "comment");

    expect(outcome.kind).toBe("skipped");
    if (outcome.kind !== "skipped") throw new Error("unreachable");
    expect(outcome.reason).toBe("error");
  });
});

describe("AI match threshold", () => {
  it("counts a hit only when confidence reaches the campaign threshold", async () => {
    const { client } = fakeClient({ match: true, confidence: 0.75, reason: "probably" });
    __setAiClientForTests(client);

    const strict = await aiMatch("給我", { ...campaign, aiMatchThreshold: 0.8 }, "comment");
    expect(strict.kind).toBe("decision");
    if (strict.kind !== "decision") throw new Error("unreachable");
    expect(strict.decision.match).toBe(true);
    expect(strict.decision.matched).toBe(false);
    expect(strict.decision.threshold).toBe(0.8);

    const loose = await aiMatch("給我", { ...campaign, aiMatchThreshold: 0.7 }, "comment");
    if (loose.kind !== "decision") throw new Error("unreachable");
    expect(loose.decision.matched).toBe(true);
  });

  it("never matches when the model says no, whatever the confidence", async () => {
    const { client } = fakeClient({ match: false, confidence: 0.99, reason: "unrelated praise" });
    __setAiClientForTests(client);

    const outcome = await aiMatch("好可愛", campaign, "comment");
    if (outcome.kind !== "decision") throw new Error("unreachable");
    expect(outcome.decision.matched).toBe(false);
  });

  it("short-circuits empty text without a model call", async () => {
    const { client, parse } = fakeClient({ match: true, confidence: 1, reason: "x" });
    __setAiClientForTests(client);

    const outcome = await aiMatch("   ", campaign, "dm");
    if (outcome.kind !== "decision") throw new Error("unreachable");
    expect(outcome.decision.matched).toBe(false);
    expect(parse).not.toHaveBeenCalled();
  });
});
