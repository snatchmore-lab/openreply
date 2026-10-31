import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockSend, mockComplete, mockEmail, mockTakeAnswer } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    conversation: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    conversationMessage: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  mockSend: vi.fn(),
  mockComplete: vi.fn(),
  mockEmail: vi.fn(),
  mockTakeAnswer: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/instagram/provider", () => ({
  createInstagramContext: vi.fn().mockResolvedValue({}),
  hasInstagramCredentials: vi.fn().mockReturnValue(true),
  sendDirectMessage: mockSend,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: vi.fn().mockResolvedValue({ allowed: true, reserved: true }),
  releaseDMSlot: vi.fn(),
}));
vi.mock("@/lib/ai/service", () => ({ completeJson: mockComplete }));
vi.mock("@/lib/instagram/sent-mids", () => ({
  isLatestInboundMessage: async () => true,
  rememberAutomatedAnswer: vi.fn(),
  takeAutomatedAnswer: mockTakeAnswer,
}));
vi.mock("@/lib/notify/email", () => ({
  isValidEmail: (v: unknown) => typeof v === "string" && v.includes("@"),
  sendThrottledNotifyEmail: mockEmail,
}));

import { handleFaqMessage } from "@/lib/ai/faq";

function setup(status: "AI" | "NEEDS_HUMAN" | "HUMAN", answerAfterHandoff: boolean) {
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    id: "acc",
    instagramId: "ig",
    username: "rban.case",
    workspaceId: "ws",
    aiSettings: {
      faqEnabled: true,
      knowledgeBase: "能力盤點免費",
      handoffMessage: "轉給本人",
      hourlyLimitPerUser: 8,
      tone: "friendly",
      maxReplyChars: 300,
      notifyEmail: "me@example.com",
      answerAfterHandoff,
    },
    workspace: { aiSettings: null },
  });
  mockPrisma.conversationMessage.findUnique.mockResolvedValue(null);
  mockPrisma.conversation.upsert.mockResolvedValue({ id: "conv", status });
  mockPrisma.conversation.findUnique.mockResolvedValue({ status });
  mockPrisma.conversationMessage.create.mockResolvedValue({});
  mockPrisma.conversationMessage.count.mockResolvedValue(0);
  mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockResolvedValue([]);
  mockEmail.mockResolvedValue(undefined);
  mockSend.mockResolvedValue({});
  mockTakeAnswer.mockResolvedValue(null);
}

const answer = (text: string) => ({
  ok: true,
  cached: false,
  model: "m",
  result: { answer: text, confident: true, crisis: false },
});
const unsure = { ok: true, cached: false, model: "m", result: { answer: "", confident: false, crisis: false } };
const msg = { instagramAccountId: "ig", senderId: "fan", messageId: "mid", messageText: "能力盤點要錢嗎" };

beforeEach(() => vi.clearAllMocks());

describe("answer after handoff", () => {
  it("answers a knowledge-base question in a handed-off thread when enabled", async () => {
    setup("NEEDS_HUMAN", true);
    mockComplete.mockResolvedValue(answer("能力盤點免費喔"));

    const out = await handleFaqMessage(msg);

    expect(out).toMatchObject({ kind: "answered" });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ message: "能力盤點免費喔" }));
  });

  it("never sends the handoff message twice in a row", async () => {
    setup("NEEDS_HUMAN", true);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "轉給本人", messageId: null, createdAt: new Date() },
      { direction: "IN", text: "有框的是什麼", messageId: "m0", createdAt: new Date(Date.now() - 600_000) },
    ]);
    mockComplete.mockResolvedValue(unsure);

    const out = await handleFaqMessage(msg);

    expect(out).toEqual({ kind: "silent", reason: "not-ai-state" });
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockEmail).not.toHaveBeenCalled();
  });

  it("hands off again when the bot has answered other things since", async () => {
    setup("NEEDS_HUMAN", true);
    // Newest first, as the query returns them.
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "有框是玻璃外面有框架的款式", messageId: null, createdAt: new Date() },
      { direction: "IN", text: "有框的是什麼", messageId: "m1", createdAt: new Date(Date.now() - 300_000) },
      { direction: "OUT_AI", text: "轉給本人", messageId: null, createdAt: new Date(Date.now() - 600_000) },
    ]);
    mockComplete.mockResolvedValue(unsure);

    const out = await handleFaqMessage({ ...msg, messageText: "可以預約現場嗎" });

    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ message: "轉給本人" }));
  });

  it("right after the handoff, sends the owner's pass-on line once", async () => {
    setup("NEEDS_HUMAN", true);
    const acct = await mockPrisma.instagramAccount.findUnique.mock.results[0]?.value;
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      ...(acct ?? {}),
      id: "acc", instagramId: "ig", username: "yuben", workspaceId: "ws",
      aiSettings: {
        faqEnabled: true, knowledgeBase: "[固定回覆:再轉交] 好的~我一起請師傅回覆您唷", handoffMessage: "轉給本人",
        hourlyLimitPerUser: 8, tone: "friendly", maxReplyChars: 300, notifyEmail: null, answerAfterHandoff: true,
      },
      workspace: { aiSettings: null },
    });
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "轉給本人", messageId: null, createdAt: new Date() },
    ]);
    mockComplete.mockResolvedValue(unsure);

    const out = await handleFaqMessage({ ...msg, messageText: "三片跟兩片差多少" });
    expect(out).toMatchObject({ kind: "handoff", text: "好的~我一起請師傅回覆您唷" });

    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "好的~我一起請師傅回覆您唷", messageId: null, createdAt: new Date() },
    ]);
    expect(await handleFaqMessage({ ...msg, messageId: "mid2", messageText: "？" })).toEqual({ kind: "silent", reason: "not-ai-state" });
  });

  it("stays silent after a handoff when the setting is off", async () => {
    setup("NEEDS_HUMAN", false);

    const out = await handleFaqMessage(msg);

    expect(out).toEqual({ kind: "silent", reason: "not-ai-state" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("always stays silent once the owner has replied", async () => {
    setup("HUMAN", true);

    const out = await handleFaqMessage(msg);

    expect(out).toEqual({ kind: "silent", reason: "not-ai-state" });
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("Meta's Page FAQ answered first", () => {
  it("does not answer a button tap Meta already answered, and keeps Meta's text", async () => {
    setup("AI", false);
    mockTakeAnswer.mockResolvedValue("傳幾張您的【浴室照片】");

    const out = await handleFaqMessage({ ...msg, messageText: "我有浴室整修需求" });

    expect(out).toEqual({ kind: "silent", reason: "auto-answered" });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.conversationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ direction: "OUT_AI", text: "傳幾張您的【浴室照片】", aiMeta: { automation: true } }),
    });
  });

  it("stays quiet when Meta's answer lands while the model is writing", async () => {
    setup("AI", false);
    mockTakeAnswer.mockResolvedValueOnce(null).mockResolvedValueOnce("傳幾張您的【浴室照片】");
    mockComplete.mockResolvedValue(answer("好的想做哪些項目呢"));

    const out = await handleFaqMessage({ ...msg, messageText: "我有浴室整修需求" });

    expect(out).toEqual({ kind: "silent", reason: "auto-answered" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("out-of-area requests", () => {
  const kb = [
    "[沒服務地區] 台北 新北 新竹 台南 宜蘭",
    "[服務地區] 台中 彰化 雲林",
    "[固定回覆:沒服務] 哇…目前還沒有服務到那邊🥹",
  ].join(String.fromCharCode(10));
  const withKb = () => {
    setup("AI", false);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "acc",
      instagramId: "ig",
      username: "yuben",
      workspaceId: "ws",
      aiSettings: {
        faqEnabled: true,
        knowledgeBase: kb,
        handoffMessage: "轉給本人",
        hourlyLimitPerUser: 8,
        tone: "friendly",
        maxReplyChars: 300,
        notifyEmail: null,
        answerAfterHandoff: false,
      },
      workspace: { aiSettings: null },
    });
  };

  it("answers 沒服務 for an unserved city without asking the model", async () => {
    withKb();
    const out = await handleFaqMessage({ ...msg, messageText: "請問臺北，拆浴缸，防水，重貼磁磚，可以處理嗎" });

    expect(out).toMatchObject({ kind: "answered", text: "哇…目前還沒有服務到那邊🥹" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("leaves it to the model when a served city is named too", async () => {
    withKb();
    mockComplete.mockResolvedValue(answer("台中可以唷"));
    const out = await handleFaqMessage({ ...msg, messageText: "以前住台北 現在房子在台中" });

    expect(out).toMatchObject({ kind: "answered", text: "台中可以唷" });
    expect(mockComplete).toHaveBeenCalled();
  });

  it("says 沒服務 once; later messages go to the model", async () => {
    withKb();
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "哇…目前還沒有服務到那邊🥹", messageId: null, createdAt: new Date() },
    ]);
    mockComplete.mockResolvedValue(answer("不好意思~可能要麻煩您自己找找看"));
    const out = await handleFaqMessage({ ...msg, messageText: "那台北有推薦的師傅嗎" });

    expect(mockComplete).toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "answered" });
  });
});

describe("per-person hourly cap", () => {
  it("hands the thread to the owner once instead of going quiet", async () => {
    setup("AI", false);
    mockPrisma.conversationMessage.count.mockResolvedValue(8);

    const out = await handleFaqMessage(msg);

    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ message: "轉給本人" }));
  });

  it("stays quiet once the thread is already the owner's", async () => {
    setup("NEEDS_HUMAN", true);
    mockPrisma.conversationMessage.count.mockResolvedValue(8);

    const out = await handleFaqMessage(msg);

    expect(out).toEqual({ kind: "silent", reason: "hourly-limit" });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("catch-up after an outage", () => {
  it("leaves a message older than 30 minutes to the owner instead of answering it", async () => {
    setup("AI", false);

    const out = await handleFaqMessage({ ...msg, receivedAt: Date.now() - 31 * 60 * 1000 });

    expect(out).toEqual({ kind: "silent", reason: "stale" });
    expect(mockComplete).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_HUMAN" }) })
    );
  });

  it("answers a fresh message as usual", async () => {
    setup("AI", false);
    mockComplete.mockResolvedValue(answer("能力盤點免費喔"));

    const out = await handleFaqMessage({ ...msg, receivedAt: Date.now() - 20 * 1000 });

    expect(out).toMatchObject({ kind: "answered" });
  });
});

describe("same answer twice", () => {
  it("hands off instead of repeating the identical reply", async () => {
    setup("AI", false);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "能力盤點免費喔", messageId: null, createdAt: new Date(Date.now() - 60_000) },
      { direction: "IN", text: "能力盤點要錢嗎", messageId: "m0", createdAt: new Date(Date.now() - 90_000) },
    ]);
    mockComplete.mockResolvedValue(answer("能力盤點免費喔"));

    const out = await handleFaqMessage({ ...msg, messageText: "所以到底要不要錢" });

    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ message: "轉給本人" }));
  });

  it("still answers when the reply is new", async () => {
    setup("AI", false);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "能力盤點免費喔", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(answer("要留言「能力」就可以囉"));

    const out = await handleFaqMessage({ ...msg, messageText: "怎麼做" });

    expect(out).toMatchObject({ kind: "answered" });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe("rules shared with the simulation", () => {
  const kb = [
    "[固定回覆:沒服務] 哇…目前還沒有服務到那邊🥹",
    "[沒服務地區] 台北",
    "[服務地區] 台中",
    "[偏遠鄉鎮] 泰安 阿里山",
    "[固定回覆:回覆時間] 師傅看到會盡快回覆您",
    "[固定回覆:先問配件] 浴室的龍頭、馬桶或配件",
    "[固定回覆:先問配件] 有沒有想一起換呢😊",
  ].join(String.fromCharCode(10));
  function setupKb(status: "AI" | "NEEDS_HUMAN", answerAfterHandoff: boolean) {
    setup(status, answerAfterHandoff);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "acc",
      instagramId: "ig",
      username: "yuben",
      workspaceId: "ws",
      aiSettings: {
        faqEnabled: true,
        knowledgeBase: kb,
        handoffMessage: "轉給本人",
        hourlyLimitPerUser: 8,
        tone: "friendly",
        maxReplyChars: 300,
        notifyEmail: null,
        answerAfterHandoff,
      },
      workspace: { aiSettings: null },
    });
  }

  it("hands a remote town to the owner without asking the model", async () => {
    setupKb("AI", true);
    const out = await handleFaqMessage({ ...msg, messageText: "我在泰安 想做拉門" });
    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("answers 回覆時間 once to a person waiting on the owner, then stays quiet", async () => {
    setupKb("NEEDS_HUMAN", true);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "轉給本人", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    const first = await handleFaqMessage({ ...msg, messageText: "師傅多久會回阿" });
    expect(first).toMatchObject({ kind: "answered", text: "師傅看到會盡快回覆您" });
    expect(mockComplete).not.toHaveBeenCalled();

    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "轉給本人", messageId: null, createdAt: new Date(Date.now() - 120_000) },
      { direction: "OUT_AI", text: "師傅看到會盡快回覆您", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    const second = await handleFaqMessage({ ...msg, messageId: "mid2", messageText: "還沒回嗎" });
    expect(second).toMatchObject({ kind: "silent" });
  });

  it("asks about fixtures instead of photos the first time in a shower-door thread", async () => {
    setupKb("AI", false);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "IN", text: "我想做淋浴拉門", messageId: "m0", createdAt: new Date(Date.now() - 90_000) },
      { direction: "OUT_AI", text: "好的~請問是在哪一區呢", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(answer("好的~" + String.fromCharCode(10) + "方便傳幾張浴室照片給師傅看看嗎"));
    const out = await handleFaqMessage({ ...msg, messageText: "台中" });
    expect(out).toMatchObject({ kind: "answered", text: "好的~" + String.fromCharCode(10) + "浴室的龍頭、馬桶或配件" + String.fromCharCode(10) + "有沒有想一起換呢😊" });
  });

  it("asks for photos as written once fixtures were covered", async () => {
    setupKb("AI", false);
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "IN", text: "我想做淋浴拉門", messageId: "m0", createdAt: new Date(Date.now() - 90_000) },
      { direction: "OUT_AI", text: "浴室的龍頭、馬桶或配件有沒有想一起換呢", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(answer("方便傳幾張浴室照片給師傅看看嗎"));
    const out = await handleFaqMessage({ ...msg, messageText: "不用" });
    const text = out.kind === "answered" ? out.text : "";
    expect(text).toContain("照片");
    expect(text).not.toContain("龍頭");
  });
});

describe("renovation price and repeated text", () => {
  const kb = [
    "[固定回覆:整修報價] 整修的部分要看現場範圍",
    "[固定回覆:整修報價] 請問是在哪個縣市/哪一區呢😊",
    "[固定回覆:整修報價-已知地區] 整修的部分要看現場範圍",
    "[固定回覆:整修報價-已知地區] 方便先傳幾張浴室照片給師傅看看嗎😊",
    "[服務地區] 台中 彰化",
  ].join(String.fromCharCode(10));
  function setupKb() {
    setup("AI", false);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "acc", instagramId: "ig", username: "yuben", workspaceId: "ws",
      aiSettings: { faqEnabled: true, knowledgeBase: kb, handoffMessage: "轉給本人", hourlyLimitPerUser: 8, tone: "friendly", maxReplyChars: 300, notifyEmail: null, answerAfterHandoff: true },
      workspace: { aiSettings: null },
    });
  }

  it("answers a renovation price question with the fixed reply instead of handing off", async () => {
    setupKb();
    mockComplete.mockResolvedValue(unsure);
    const out = await handleFaqMessage({ ...msg, messageText: "拆浴缸改乾濕分離大概多少" });
    expect(out).toMatchObject({ kind: "answered", text: "整修的部分要看現場範圍" + String.fromCharCode(10) + "請問是在哪個縣市/哪一區呢😊" });
  });

  it("uses the known-area version when the person already said where they are", async () => {
    setupKb();
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "IN", text: "我在彰化", messageId: "m0", createdAt: new Date(Date.now() - 90_000) },
      { direction: "OUT_AI", text: "好的~", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(unsure);
    const out = await handleFaqMessage({ ...msg, messageText: "整間翻新預算大概多少" });
    expect(out).toMatchObject({ kind: "answered", text: "整修的部分要看現場範圍" + String.fromCharCode(10) + "方便先傳幾張浴室照片給師傅看看嗎😊" });
  });

  it("hands off the second time the same price question comes", async () => {
    setupKb();
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "整修的部分要看現場範圍" + String.fromCharCode(10) + "請問是在哪個縣市/哪一區呢😊", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(unsure);
    const out = await handleFaqMessage({ ...msg, messageText: "我就想知道整修大概多少錢" });
    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
  });

  it("hands off when the same answer was given earlier in the thread, not only last", async () => {
    setupKb();
    mockPrisma.conversationMessage.findMany.mockResolvedValue([
      { direction: "OUT_AI", text: "保固 2 年唷", messageId: null, createdAt: new Date(Date.now() - 180_000) },
      { direction: "IN", text: "好", messageId: "m1", createdAt: new Date(Date.now() - 120_000) },
      { direction: "OUT_AI", text: "不客氣~", messageId: null, createdAt: new Date(Date.now() - 60_000) },
    ]);
    mockComplete.mockResolvedValue(answer("保固 2 年唷"));
    const out = await handleFaqMessage({ ...msg, messageText: "所以保固多久" });
    expect(out).toMatchObject({ kind: "handoff", text: "轉給本人" });
  });
});
