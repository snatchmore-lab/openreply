import { describe, it, expect, vi } from "vitest";

describe("Meta automation echoes", () => {
  it("treats an echo right after the customer's message as automated", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    const store = new Map<string, number>();
    const set = vi.fn(async (key: string, _v: string, _ex: string, ttl: number) => {
      store.set(key, ttl);
      return "OK";
    });
    const exists = vi.fn(async (key: string) => (store.has(key) ? 1 : 0));
    vi.doMock("@/lib/queue/client", () => ({ getRedisConnection: () => ({ set, exists }) }));
    const { rememberInboundMessage, isLikelyAutomatedEcho } = await import("@/lib/instagram/sent-mids");

    expect(await isLikelyAutomatedEcho("page1", "user1")).toBe(false);
    await rememberInboundMessage("page1", "user1");
    expect(set).toHaveBeenCalledWith("openreply:inbound:page1:user1", "1", "EX", 15);
    expect(await isLikelyAutomatedEcho("page1", "user1")).toBe(true);
    expect(await isLikelyAutomatedEcho("page1", "user2")).toBe(false);
  });

  it("falls back to 'human' when Redis is down", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    vi.doMock("@/lib/queue/client", () => ({
      getRedisConnection: () => ({
        set: vi.fn().mockRejectedValue(new Error("down")),
        exists: vi.fn().mockRejectedValue(new Error("down")),
      }),
    }));
    const { rememberInboundMessage, isLikelyAutomatedEcho } = await import("@/lib/instagram/sent-mids");
    await expect(rememberInboundMessage("p", "u")).resolves.toBeUndefined();
    expect(await isLikelyAutomatedEcho("p", "u")).toBe(false);
  });
});
