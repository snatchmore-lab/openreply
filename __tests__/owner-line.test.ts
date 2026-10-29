import { describe, it, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const store = new Map<string, string>();
const push = vi.fn().mockResolvedValue(true);
vi.mock("@/lib/notify/line", () => ({ pushLineMessage: (t: string) => push(t) }));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => ({
    set: async (k: string, v: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === "NX" && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
    del: async (k: string) => (store.delete(k) ? 1 : 0),
  }),
}));
const aggregate = vi.fn();
vi.mock("@/lib/db/client", () => ({ prisma: { aiUsage: { aggregate: (a: unknown) => aggregate(a) } } }));

beforeEach(() => {
  store.clear();
  push.mockClear();
  process.env.REDIS_URL = "redis://test";
});

describe("owner LINE alerts", () => {
  it("reports a problem once a day and the recovery once", async () => {
    const { reportProblem, resolveProblem } = await import("@/lib/notify/owner-line");
    await reportProblem("worker", "停了");
    await reportProblem("worker", "停了");
    expect(push).toHaveBeenCalledTimes(1);
    await resolveProblem("worker", "恢復了");
    await resolveProblem("worker", "恢復了");
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith("✅ 恢復了");
  });

  it("never sends a recovery without an earlier problem", async () => {
    const { resolveProblem } = await import("@/lib/notify/owner-line");
    await resolveProblem("ai-credit", "恢復");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("daily owner checks", () => {
  it("reminds about Railway 7 days ahead, once", async () => {
    vi.stubEnv("RAILWAY_TRIAL_ENDS", "2026-11-21");
    vi.stubEnv("AI_CREDIT_USD", "");
    const { runDailyOwnerChecks } = await import("@/lib/notify/daily-checks");
    await runDailyOwnerChecks(new Date("2026-11-15T05:00:00Z"));
    await runDailyOwnerChecks(new Date("2026-11-16T05:00:00Z"));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toContain("Railway");
    vi.unstubAllEnvs();
  });

  it("warns when estimated AI spend passes 80% of the credit", async () => {
    vi.stubEnv("RAILWAY_TRIAL_ENDS", "");
    vi.stubEnv("AI_CREDIT_USD", "10");
    vi.stubEnv("AI_CREDIT_SINCE", "2026-10-26");
    aggregate.mockResolvedValue({ _sum: { inputTokens: 60_000_000, outputTokens: 5_000_000 } }); // $6 + $2.5
    const { runDailyOwnerChecks } = await import("@/lib/notify/daily-checks");
    await runDailyOwnerChecks(new Date("2026-11-01T05:00:00Z"));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0]).toContain("85%");
    vi.unstubAllEnvs();
  });
});
