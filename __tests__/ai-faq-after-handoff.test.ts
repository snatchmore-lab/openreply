import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockSend, mockComplete, mockEmail } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findUnique: vi.fn() },
    conversation: { upsert: vi.fn(), update: vi.fn() },
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
  mockPrisma.conversationMessage.create.mockResolvedValue({});
  mockPrisma.conversationMessage.count.mockResolvedValue(0);
  mockPrisma.conversationMessage.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockResolvedValue([]);
  mockEmail.mockResolvedValue(undefined);
  mockSend.mockResolvedValue({});
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
