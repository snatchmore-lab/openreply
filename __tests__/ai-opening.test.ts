import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    aiCache: { findUnique: vi.fn(), upsert: vi.fn() },
    aiUsage: { aggregate: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

import {
  clampMaxChars,
  composeDmWithOpening,
  generateOpening,
  sanitizeOpening,
} from "@/lib/ai/opening";
import { __setAiClientForTests } from "@/lib/ai/service";

const campaign = {
  id: "camp_1",
  workspaceId: "ws_1",
  aiOpeningTone: "friendly",
  aiOpeningMaxChars: 40,
  aiMatchDescription: "7 天睡眠日記 PDF",
};

function fakeClient(opening: string) {
  const parse = vi.fn().mockResolvedValue({
    parsed_output: { opening },
    stop_reason: "end_turn",
    usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 0 },
  });
  return { client: { messages: { parse } } as never, parse };
}

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

describe("sanitizeOpening", () => {
  it("strips URLs, template tokens, hashtags and wrapping quotes", () => {
    expect(
      sanitizeOpening("「看到你想要睡眠日記 https://evil.example {link} #sleep 🙏」", 60)
    ).toBe("看到你想要睡眠日記 🙏");
  });

  it("collapses whitespace and enforces the character cap", () => {
    expect(sanitizeOpening("這是一句\n很長很長很長很長的開場白", 8)).toBe("這是一句 很長很");
  });

  it("returns null when nothing usable is left", () => {
    expect(sanitizeOpening("https://only.a.link", 40)).toBeNull();
    expect(sanitizeOpening("   ", 40)).toBeNull();
  });
});

describe("clampMaxChars", () => {
  it("defaults and clamps into the allowed range", () => {
    expect(clampMaxChars(undefined)).toBe(40);
    expect(clampMaxChars(3)).toBe(10);
    expect(clampMaxChars(999)).toBe(120);
    expect(clampMaxChars(55.6)).toBe(56);
  });
});

describe("generateOpening", () => {
  it("returns the sanitized sentence from the model", async () => {
    const { client, parse } = fakeClient("看到你想睡好一點，這份日記很適合你 🙏");
    __setAiClientForTests(client);

    const opening = await generateOpening("想要睡眠日記", "rban.case", campaign);

    expect(opening).toBe("看到你想睡好一點，這份日記很適合你 🙏");
    expect(parse).toHaveBeenCalledTimes(1);
    const req = parse.mock.calls[0][0];
    // The owner's DM text is never part of the model input.
    expect(JSON.stringify(req)).not.toContain("{link}");
  });

  it("never lets a URL from the model reach the DM", async () => {
    const { client } = fakeClient("點這裡 https://phish.example 拿日記");
    __setAiClientForTests(client);

    const opening = await generateOpening("想要", null, campaign);

    expect(opening).toBe("點這裡 拿日記");
  });

  it("returns null when AI is off or the call fails, so the DM is unchanged", async () => {
    delete process.env.AI_API_KEY;
    expect(await generateOpening("想要", null, campaign)).toBeNull();

    process.env.AI_API_KEY = "test-key";
    const parse = vi.fn().mockRejectedValue(new Error("boom"));
    __setAiClientForTests({ messages: { parse } } as never);
    expect(await generateOpening("想要", null, campaign)).toBeNull();
  });
});

describe("composeDmWithOpening", () => {
  it("prepends with a blank line and leaves the owner's text intact", () => {
    expect(composeDmWithOpening("嗨！", "連結在這：{link}")).toBe("嗨！\n\n連結在這：{link}");
    expect(composeDmWithOpening(null, "連結在這：{link}")).toBe("連結在這：{link}");
  });
});

describe("stripFullStops", () => {
  it("removes every Chinese full stop from AI text", async () => {
    const { stripFullStops } = await import("@/lib/ai/text");
    expect(stripFullStops("收到你的留言了。日記馬上傳給你。")).toBe("收到你的留言了 日記馬上傳給你");
    expect(stripFullStops("睡不好真的很辛苦。🙏")).toBe("睡不好真的很辛苦 🙏");
    expect(stripFullStops("「好的。」")).toBe("「好的」");
    expect(stripFullStops("沒有句號")).toBe("沒有句號");
  });

  it("applies to openers, FAQ answers and reply variations", async () => {
    const { sanitizeOpening } = await import("@/lib/ai/opening");
    const { acceptVariation } = await import("@/lib/ai/vary");
    expect(sanitizeOpening("看到你想睡好一點。", 40)).toBe("看到你想睡好一點");
    expect(acceptVariation("私訊給你囉 💌", "已經私訊你了。💌")).toBe("已經私訊你了 💌");
  });
});
