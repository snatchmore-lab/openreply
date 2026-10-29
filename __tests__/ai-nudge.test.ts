import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: vi.fn(), FAQ_NUDGE_JOB_NAME: "faq-nudge" }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(),
  hasInstagramCredentials: vi.fn(),
  sendDirectMessage: vi.fn(),
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: vi.fn(), releaseDMSlot: vi.fn() }));

import { parseNudgeConfig, shouldNudge } from "@/lib/ai/nudge";

const kb = [
  "其他內容",
  "[追蹤訊息] 想了解淋浴拉門還是浴室整修呢😊",
  "[追蹤訊息] 方便的話可以傳張浴室照片給我們",
  "[廣告按鈕] 線上評估【淋浴空間】",
  "[廣告按鈕] 預約免費現場丈量",
].join("\n");
const config = parseNudgeConfig(kb)!;
const now = new Date("2026-10-29T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const tap = { direction: "IN", text: "線上評估【淋浴空間】", messageId: "m1", createdAt: ago(60) };
const template = { direction: "OUT_AI", text: "請問是在哪一區呢😊", messageId: null, createdAt: ago(59) };

describe("ad follow-up", () => {
  it("reads the follow-up text and buttons from the knowledge base", () => {
    expect(config.text).toBe("想了解淋浴拉門還是浴室整修呢😊\n方便的話可以傳張浴室照片給我們");
    expect(parseNudgeConfig("沒有設定")).toBeNull();
  });

  it("follows up a silent button tap once", () => {
    expect(shouldNudge({ status: "AI", messages: [tap, template] }, "m1", config, now)).toBe(true);
    const sent = { direction: "OUT_AI", text: config.text, messageId: null, createdAt: ago(1) };
    expect(shouldNudge({ status: "AI", messages: [tap, template, sent] }, "m1", config, now)).toBe(false);
  });

  it("skips anyone who typed, was handed off, or got a human reply", () => {
    const typed = { direction: "IN", text: "我在台中", messageId: "m2", createdAt: ago(30) };
    expect(shouldNudge({ status: "AI", messages: [tap, template, typed] }, "m1", config, now)).toBe(false);
    expect(shouldNudge({ status: "AI", messages: [typed, template] }, "m2", config, now)).toBe(false);
    expect(shouldNudge({ status: "NEEDS_HUMAN", messages: [tap] }, "m1", config, now)).toBe(false);
    const human = { direction: "OUT_HUMAN", text: "您好", messageId: null, createdAt: ago(10) };
    expect(shouldNudge({ status: "AI", messages: [tap, human] }, "m1", config, now)).toBe(false);
  });

  it("stays inside Messenger's 24-hour window", () => {
    const old = { ...tap, createdAt: ago(25 * 60) };
    expect(shouldNudge({ status: "AI", messages: [old] }, "m1", config, now)).toBe(false);
  });
});

describe("quiet follow-up", () => {
  it("reads the follow-up line", async () => {
    const { parseQuietFollowUp } = await import("@/lib/ai/nudge");
    expect(parseQuietFollowUp("[對話追蹤訊息] 還有什麼可以幫您的嗎😊\n[對話追蹤訊息] 第二行")).toBe("還有什麼可以幫您的嗎😊\n第二行");
    expect(parseQuietFollowUp("沒有設定")).toBeNull();
  });

  it("follows up once when the bot answered last and the person went quiet", async () => {
    const { shouldFollowUpQuiet } = await import("@/lib/ai/nudge");
    const text = "還有什麼可以幫您的嗎😊";
    const typed = { direction: "IN", text: "我在參考一下", messageId: "q1", createdAt: ago(23 * 60) };
    const bot = { direction: "OUT_AI", text: "不客氣唷", messageId: null, createdAt: ago(23 * 60 - 1) };
    expect(shouldFollowUpQuiet({ status: "AI", messages: [typed, bot] }, "q1", text, now)).toBe(true);
    const sent = { direction: "OUT_AI", text, messageId: null, createdAt: ago(1) };
    expect(shouldFollowUpQuiet({ status: "AI", messages: [typed, bot, sent] }, "q1", text, now)).toBe(false);
  });

  it("skips handed-off threads, unanswered messages, and anything past 24 hours", async () => {
    const { shouldFollowUpQuiet } = await import("@/lib/ai/nudge");
    const text = "還有什麼可以幫您的嗎😊";
    const typed = { direction: "IN", text: "好", messageId: "q1", createdAt: ago(23 * 60) };
    const bot = { direction: "OUT_AI", text: "好的", messageId: null, createdAt: ago(23 * 60 - 1) };
    expect(shouldFollowUpQuiet({ status: "NEEDS_HUMAN", messages: [typed, bot] }, "q1", text, now)).toBe(false);
    expect(shouldFollowUpQuiet({ status: "AI", messages: [typed] }, "q1", text, now)).toBe(false);
    expect(shouldFollowUpQuiet({ status: "AI", messages: [{ ...typed, createdAt: ago(25 * 60) }, bot] }, "q1", text, now)).toBe(false);
  });
});
