import { describe, it, expect, vi } from "vitest";

// faq.ts imports the Prisma client and the Instagram provider at module load;
// neither is exercised by the pure helpers under test here.
vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: vi.fn().mockResolvedValue({ allowed: true, reserved: true }),
  releaseDMSlot: vi.fn(),
}));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(),
  hasInstagramCredentials: vi.fn(),
  sendDirectMessage: vi.fn(),
}));

import { decideFaqReply, sanitizeAnswer, DEFAULT_HANDOFF_MESSAGE } from "@/lib/ai/faq";
import { buildFaqUserPrompt, buildFaqContextBlock } from "@/lib/ai/prompts";

const settings = { handoffMessage: "我幫你轉給本人，稍等 🙏", maxReplyChars: 300 };

describe("decideFaqReply", () => {
  it("sends the owner's handoff message when the model is not confident", () => {
    expect(decideFaqReply({ answer: "也許是…", confident: false }, settings)).toEqual({
      kind: "handoff",
      text: "我幫你轉給本人，稍等 🙏",
    });
  });

  it("falls back to the handoff when the model returned nothing usable", () => {
    expect(decideFaqReply(null, settings).kind).toBe("handoff");
    expect(decideFaqReply({ answer: "   ", confident: true }, settings).kind).toBe("handoff");
  });

  it("uses the default handoff text when the owner left it blank", () => {
    const out = decideFaqReply({ answer: "", confident: false }, { ...settings, handoffMessage: "  " });
    expect(out).toEqual({ kind: "handoff", text: DEFAULT_HANDOFF_MESSAGE });
  });

  it("returns the sanitized answer when confident", () => {
    const out = decideFaqReply(
      { answer: "「檔案會在留言後 5 分鐘內私訊給你」", confident: true },
      settings
    );
    expect(out).toEqual({ kind: "answered", text: "檔案會在留言後 5 分鐘內私訊給你" });
  });

  it("caps the answer length", () => {
    const long = "字".repeat(400);
    const out = decideFaqReply({ answer: long, confident: true }, settings);
    expect(out.kind).toBe("answered");
    expect([...out.text].length).toBe(300);
  });
});

describe("sanitizeAnswer", () => {
  it("keeps URLs (the knowledge base may contain them) but strips template tokens", () => {
    expect(sanitizeAnswer("下載：https://rbancase.com/x {link}", 100)).toBe(
      "下載：https://rbancase.com/x"
    );
  });
});

describe("FAQ prompts", () => {
  it("puts the knowledge base in its own block and the history in order", () => {
    expect(buildFaqContextBlock("  Q: 多少錢\nA: 免費  ")).toBe(
      "KNOWLEDGE BASE (the only source you may use):\n\nQ: 多少錢\nA: 免費"
    );
    const user = buildFaqUserPrompt({
      question: "怎麼拿到檔案？",
      history: [
        { role: "user", text: "嗨" },
        { role: "assistant", text: "你好！" },
      ],
      tone: "friendly",
      maxChars: 200,
    });
    expect(user).toContain("User: 嗨\nYou: 你好！");
    expect(user.endsWith("New message from the user:\n怎麼拿到檔案？")).toBe(true);
    expect(user).toContain("Character limit: 200");
  });
});

describe("trackSent", () => {
  it("records the message id after a successful send and passes the result through", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    const set = vi.fn().mockResolvedValue("OK");
    const exists = vi.fn().mockResolvedValue(1);
    vi.doMock("@/lib/queue/client", () => ({ getRedisConnection: () => ({ set, exists }) }));
    const { trackSent, wasSentByUs } = await import("@/lib/instagram/sent-mids");

    const result = await trackSent(Promise.resolve({ message_id: "mid_1", recipient_id: "u" }));
    expect(result).toEqual({ message_id: "mid_1", recipient_id: "u" });
    await Promise.resolve();
    expect(set).toHaveBeenCalledWith("openreply:sent-mid:mid_1", "1", "EX", 900);
    expect(await wasSentByUs("mid_1")).toBe(true);
  });

  it("treats a Redis failure as 'not ours' so the bot only gets quieter", async () => {
    vi.resetModules();
    process.env.REDIS_URL = "redis://test";
    vi.doMock("@/lib/queue/client", () => ({
      getRedisConnection: () => ({
        set: vi.fn().mockRejectedValue(new Error("down")),
        exists: vi.fn().mockRejectedValue(new Error("down")),
      }),
    }));
    const { trackSent, wasSentByUs } = await import("@/lib/instagram/sent-mids");
    await expect(trackSent(Promise.resolve({ message_id: "mid_2" }))).resolves.toEqual({ message_id: "mid_2" });
    expect(await wasSentByUs("mid_2")).toBe(false);
  });
});
