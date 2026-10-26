import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    aiCache: { findUnique: vi.fn(), upsert: vi.fn() },
    aiUsage: { aggregate: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import { acceptVariation, varyPublicReply } from "@/lib/ai/vary";
import { __setAiClientForTests } from "@/lib/ai/service";

describe("acceptVariation", () => {
  it("accepts a light rewording that keeps tokens, URLs and mentions", () => {
    expect(
      acceptVariation("已經私訊你囉 {username} 📩 快去看 https://a.b/x", "{username} 私訊已經送出囉 📩 去看看 https://a.b/x")
    ).toBe("{username} 私訊已經送出囉 📩 去看看 https://a.b/x");
  });

  it("rejects a rewrite that drops or adds a placeholder", () => {
    expect(acceptVariation("已私訊你 {username}", "已私訊你囉")).toBeNull();
    expect(acceptVariation("已私訊你", "已私訊你 {link}")).toBeNull();
  });

  it("rejects a rewrite that adds a URL or a mention", () => {
    expect(acceptVariation("已私訊你囉", "已私訊你囉 https://phish.example")).toBeNull();
    expect(acceptVariation("已私訊你囉", "已私訊你囉 @someone")).toBeNull();
  });

  it("rejects an empty or much longer rewrite", () => {
    expect(acceptVariation("已私訊你囉", "   ")).toBeNull();
    expect(acceptVariation("已私訊你囉", "已".repeat(80))).toBeNull();
  });
});

describe("varyPublicReply", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.AI_API_KEY = "test-key";
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

  const campaign = { id: "camp_1", workspaceId: "ws_1" };

  it("returns the accepted rewrite", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { reply: "私訊送出囉 {username} 📩" },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    });
    __setAiClientForTests({ messages: { parse } } as never);

    expect(await varyPublicReply("已私訊你 {username} 📩", "open", campaign, "c1")).toBe(
      "私訊送出囉 {username} 📩"
    );
  });

  it("returns null (caller posts the template) when the rewrite breaks the rules or AI is off", async () => {
    const parse = vi.fn().mockResolvedValue({
      parsed_output: { reply: "私訊送出囉 📩 https://evil.example" },
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    });
    __setAiClientForTests({ messages: { parse } } as never);
    expect(await varyPublicReply("已私訊你 📩", "open", campaign, "c2")).toBeNull();

    delete process.env.AI_API_KEY;
    expect(await varyPublicReply("已私訊你 📩", "open", campaign, "c3")).toBeNull();
  });
});
