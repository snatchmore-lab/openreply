import { describe, it, expect, vi } from "vitest";

describe("Meta automation echoes", () => {
  it("knows how long ago the customer's last message arrived", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    const store = new Map<string, string>();
    vi.doMock("@/lib/queue/client", () => ({
      getRedisConnection: () => ({
        set: async (k: string, v: string) => (store.set(k, v), "OK"),
        get: async (k: string) => store.get(k) ?? null,
      }),
    }));
    const { rememberInboundMessage, secondsSinceInbound } = await import("@/lib/instagram/sent-mids");

    expect(await secondsSinceInbound("page1", "user1")).toBeNull();
    await rememberInboundMessage("page1", "user1");
    const age = await secondsSinceInbound("page1", "user1");
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(2);
    expect(await secondsSinceInbound("page1", "user2")).toBeNull();
  });

  it("tells Meta's greetings from its button replies by the knowledge base", async () => {
    const { isMetaAutomationText, isMetaButtonReplyText } = await import("@/lib/ai/faq");
    const kb = ["[Meta自動訊息] 想幫你家浴室做哪些改變呢", "[Meta按鈕回覆] 預約麻煩提供以下資訊"].join(String.fromCharCode(10));
    const greeting = ["Hello~ 王小姐", "想幫你家浴室做哪些改變呢👇"].join(String.fromCharCode(10));
    expect(isMetaAutomationText(greeting, kb)).toBe(true);
    expect(isMetaButtonReplyText(greeting, kb)).toBe(false);
    expect(isMetaButtonReplyText("預約麻煩提供以下資訊⬇️ 1️⃣ 您的居住地區", kb)).toBe(true);
    expect(isMetaAutomationText("好的", kb)).toBe(false);
    expect(isMetaButtonReplyText("好的", kb)).toBe(false);
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
    const { rememberInboundMessage, secondsSinceInbound } = await import("@/lib/instagram/sent-mids");
    await expect(rememberInboundMessage("p", "u")).resolves.toBeUndefined();
    expect(await secondsSinceInbound("p", "u")).toBeNull();
  });
});

describe("latest inbound message", () => {
  it("only the newest message from a person is answered", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    const store = new Map<string, string>();
    vi.doMock("@/lib/queue/client", () => ({
      getRedisConnection: () => ({
        set: async (k: string, v: string) => (store.set(k, v), "OK"),
        get: async (k: string) => store.get(k) ?? null,
        exists: async (k: string) => (store.has(k) ? 1 : 0),
      }),
    }));
    const { rememberInboundMessage, isLatestInboundMessage } = await import("@/lib/instagram/sent-mids");
    await rememberInboundMessage("page1", "user1", "m1");
    await rememberInboundMessage("page1", "user1", "m2");
    expect(await isLatestInboundMessage("page1", "user1", "m1")).toBe(false);
    expect(await isLatestInboundMessage("page1", "user1", "m2")).toBe(true);
    expect(await isLatestInboundMessage("page1", "user9", "x")).toBe(true);
  });
});

describe("automated answers", () => {
  it("belongs to the message it answered and is read once", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    const store = new Map<string, string>();
    vi.doMock("@/lib/queue/client", () => ({
      getRedisConnection: () => ({
        set: async (k: string, v: string) => (store.set(k, v), "OK"),
        get: async (k: string) => store.get(k) ?? null,
        del: async (k: string) => (store.delete(k) ? 1 : 0),
      }),
    }));
    const { rememberInboundMessage, rememberAutomatedAnswer, takeAutomatedAnswer } = await import(
      "@/lib/instagram/sent-mids"
    );
    await rememberInboundMessage("page1", "user1", "m1");
    await rememberAutomatedAnswer("page1", "user1", "傳幾張浴室照片");
    await rememberAutomatedAnswer("page1", "user1", "[附件]");

    expect(await takeAutomatedAnswer("page1", "user1", "m0")).toBeNull();
    expect(await takeAutomatedAnswer("page1", "user1", "m1")).toBe("傳幾張浴室照片" + String.fromCharCode(10) + "[附件]");
    expect(await takeAutomatedAnswer("page1", "user1", "m1")).toBeNull();

    // The person wrote again after Meta answered: the newer message is the bot's.
    await rememberAutomatedAnswer("page1", "user1", "傳幾張浴室照片");
    await rememberInboundMessage("page1", "user1", "m2");
    expect(await takeAutomatedAnswer("page1", "user1", "m2")).toBeNull();
  });
});
