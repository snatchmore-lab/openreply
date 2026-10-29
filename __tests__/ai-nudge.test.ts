import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: vi.fn(), FAQ_NUDGE_JOB_NAME: "faq-nudge" }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn(),
  hasInstagramCredentials: vi.fn(),
  sendDirectMessage: vi.fn(),
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: vi.fn(), releaseDMSlot: vi.fn() }));
vi.mock("@/lib/ai/service", () => ({ completeJson: vi.fn() }));

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
    expect(config.texts).toEqual(["想了解淋浴拉門還是浴室整修呢😊\n方便的話可以傳張浴室照片給我們"]);
    expect(parseNudgeConfig("沒有設定")).toBeNull();
  });

  it("follows up a silent button tap once", () => {
    expect(shouldNudge({ status: "AI", messages: [tap, template] }, "m1", config, now)).toBe(true);
    const sent = { direction: "OUT_AI", text: config.texts[0], messageId: null, createdAt: ago(1) };
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

describe("follow-up variants and personalised text", () => {
  it("groups numbered [追蹤訊息:N] lines into separate variants", async () => {
    const { parseNudgeConfig } = await import("@/lib/ai/nudge");
    const c = parseNudgeConfig(["[追蹤訊息:1] Hello~", "[追蹤訊息:1] 第二行", "[追蹤訊息:2] 哈囉~", "[廣告按鈕] 線上評估"].join("\n"))!;
    expect(c.texts).toEqual(["Hello~\n第二行", "哈囉~"]);
  });

  it("does not follow up an ad tap twice, whichever variant went out", async () => {
    const { parseNudgeConfig, shouldNudge } = await import("@/lib/ai/nudge");
    const c = parseNudgeConfig(["[追蹤訊息:1] A", "[追蹤訊息:2] B", "[廣告按鈕] 線上評估【淋浴空間】"].join("\n"))!;
    const sent = { direction: "OUT_AI", text: "B", messageId: null, createdAt: ago(1), aiMeta: { nudge: "ad" } };
    expect(shouldNudge({ status: "AI", messages: [tap, sent] }, "m1", c, now)).toBe(false);
  });

  it("drops a personalised line that invents a number", async () => {
    const { safeQuietText } = await import("@/lib/ai/nudge");
    const transcript = "客人：白框PS板三片式多少\n回覆：價格在8500左右~";
    expect(safeQuietText("Hello~ 白框PS板三片式\n還有想了解的嗎😊", transcript, 17)).toContain("白框PS板三片式");
    expect(safeQuietText("Hello~ 現在只要7999唷", transcript, 17)).toBeNull();
    expect(safeQuietText("Hello~ 8500的款式還有興趣嗎", transcript, 17)).not.toBeNull();
  });
});

describe("personalised follow-up guard", () => {
  it("drops lines that claim progress the owner never made", async () => {
    const { safeQuietText } = await import("@/lib/ai/nudge");
    expect(safeQuietText("Hello~ 週末的時間\n我已經幫您排囉", "客人：週末可以嗎", 17)).toBeNull();
    expect(safeQuietText("Hello~ L型無框內推門\n師傅還在確認中", "客人：L型", 17)).toBeNull();
  });
});

describe("quiet follow-up and service area", () => {
  it("skips customers already told we do not serve their area", async () => {
    const { shouldFollowUpQuiet } = await import("@/lib/ai/nudge");
    const typed = { direction: "IN", text: "高雄鳳山", messageId: "q1", createdAt: ago(23 * 60) };
    const no = { direction: "OUT_AI", text: "哇…目前還沒有服務到那邊🥹", messageId: null, createdAt: ago(23 * 60 - 1) };
    expect(shouldFollowUpQuiet({ status: "AI", messages: [typed, no] }, "q1", "fallback", now, ["哇…目前還沒有服務到那邊🥹"])).toBe(false);
  });
});
