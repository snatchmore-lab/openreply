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

import { decideFaqReply, isAskingForReply, isRenovationPriceQuestion, sanitizeAnswer, DEFAULT_HANDOFF_MESSAGE, CRISIS_MESSAGE } from "@/lib/ai/faq";
import { buildFaqUserPrompt, buildFaqContextBlock, FAQ_SYSTEM_PROMPT } from "@/lib/ai/prompts";

const settings = { handoffMessage: "我幫你轉給本人，稍等 🙏", maxReplyChars: 300 };

describe("crisis replies", () => {
  it("sends the fixed hotline message, never the model's text or the handoff", () => {
    const out = decideFaqReply({ answer: "電子書 NT$490", confident: true, crisis: true }, settings);
    expect(out).toEqual({ kind: "crisis", text: CRISIS_MESSAGE });
    expect(CRISIS_MESSAGE).toContain("1925");
  });

  it("wins even when the model was not confident", () => {
    expect(decideFaqReply({ answer: "", confident: false, crisis: true }, settings).kind).toBe("crisis");
  });

  it("is spelled out in the system prompt", () => {
    expect(FAQ_SYSTEM_PROMPT).toContain("crisis=true");
  });
});

describe("decideFaqReply", () => {
  it("sends the owner's handoff message when the model is not confident", () => {
    expect(decideFaqReply({ answer: "也許是…", confident: false }, settings)).toEqual({
      kind: "handoff",
      text: "我幫你轉給本人，稍等 🙏",
    });
  });

  it("counts the model repeating the handoff line as a handoff", () => {
    expect(decideFaqReply({ answer: "我幫你轉給本人" + String.fromCharCode(10) + "稍等🙏", confident: true }, settings)).toEqual({
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
    expect(out).toEqual({ kind: "answered", text: "檔案會在留言後\n5 分鐘內私訊給你" });
  });

  it("caps the answer length", () => {
    const long = "字".repeat(400);
    const out = decideFaqReply({ answer: long, confident: true }, settings);
    expect(out.kind).toBe("answered");
    expect([...out.text].length).toBeLessThanOrEqual(300);
    expect(out.text.split("\n").every((line) => [...line].length <= 10)).toBe(true);
  });
});

describe("sanitizeAnswer", () => {
  it("keeps URLs (the knowledge base may contain them) but strips template tokens", () => {
    expect(sanitizeAnswer("下載：https://rbancase.com/x {link}", 100)).toBe(
      "下載：\nhttps://rbancase.com/x"
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

describe("per-account line width", () => {
  it("keeps a 12-character line whole when the account allows 16", () => {
    expect(sanitizeAnswer("營業時間不特別公告唷～", 300, 16)).toBe("營業時間不特別公告唷～");
    expect(sanitizeAnswer("營業時間不特別公告唷～", 300)).toContain("\n");
  });

  it("tells the model the width", () => {
    const user = buildFaqUserPrompt({ question: "q", history: [], tone: "friendly", maxChars: 300, lineWidth: 16 });
    expect(user).toContain("Line width: 16");
  });
});

describe("knowledge-base photos", () => {
  const kb = [
    "【樣式照片】",
    "[圖片] 白框PS板一字三橫拉：https://example.test/a.jpg",
    "[圖片] 無框內推門：https://example.test/b.jpg",
    "官網 https://example.test/not-a-photo",
  ].join("\n");

  it("only sends URLs listed on [圖片] lines", async () => {
    const { pickImages } = await import("@/lib/ai/faq");
    expect(
      pickImages(["https://example.test/b.jpg", "https://evil.test/x.jpg", "https://example.test/not-a-photo"], kb)
    ).toEqual(["https://example.test/b.jpg"]);
  });

  it("caps at three and drops duplicates", async () => {
    const { pickImages } = await import("@/lib/ai/faq");
    const many = Array.from({ length: 5 }, (_, i) => `[圖片] p${i}：https://example.test/${i}.jpg`).join("\n");
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.test/${i}.jpg`);
    expect(pickImages([urls[0], urls[0], ...urls], many)).toEqual(urls.slice(0, 3));
  });
});

describe("messages sent in a row", () => {
  const now = new Date("2026-10-28T10:00:00Z");
  const at = (s: number) => new Date(now.getTime() - s * 1000);

  it("answers the person's trailing unanswered messages together", async () => {
    const { splitPendingMessages } = await import("@/lib/ai/faq");
    const { pending, history } = splitPendingMessages(
      [
        { direction: "IN", text: "你好", createdAt: at(300) },
        { direction: "OUT_AI", text: "您好😊", createdAt: at(290) },
        { direction: "IN", text: "淋浴拉門", createdAt: at(8) },
      ],
      now
    );
    expect(pending).toEqual(["淋浴拉門"]);
    expect(history).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", text: "您好😊" },
    ]);
  });

  it("leaves old unanswered messages in history", async () => {
    const { splitPendingMessages } = await import("@/lib/ai/faq");
    const { pending, history } = splitPendingMessages(
      [{ direction: "IN", text: "昨天的問題", createdAt: at(86_400) }],
      now
    );
    expect(pending).toEqual([]);
    expect(history).toEqual([{ role: "user", text: "昨天的問題" }]);
  });
});

describe("punctuation at a line start", () => {
  it("moves a leading 、 back onto the line before", async () => {
    const { formatAiText } = await import("@/lib/ai/text");
    expect(formatAiText("請問工地是在哪一縣市\n、哪一區呢😊", 16)).not.toMatch(/\n、/);
  });
});

describe("fixed replies", () => {
  const kb = [
    "[固定回覆:預約] 好的~幫您預約師傅免費到府丈量討論~",
    "[固定回覆:預約] 請問是在哪個縣市/哪一區呢?",
  ].join("\n");
  const s = { handoffMessage: "轉給師傅", maxReplyChars: 300, maxLineWidth: 10, knowledgeBase: kb };

  it("sends the owner's exact text, line breaks kept, even past the line width", () => {
    expect(decideFaqReply({ answer: "{{預約}}", confident: true }, s)).toEqual({
      kind: "answered",
      text: "好的~幫您預約師傅免費到府丈量討論~\n請問是在哪個縣市/哪一區呢?",
    });
  });

  it("hands off when the model names a fixed reply that does not exist", () => {
    expect(decideFaqReply({ answer: "{{不存在}}", confident: true }, s).kind).toBe("handoff");
  });
});

describe("fixed replies with spacing", () => {
  it("keeps a blank line the owner put inside the reply", async () => {
    const { knowledgeBaseFixedReplies } = await import("@/lib/ai/faq");
    const kb = ["[固定回覆:門市] 目前門市在雲林斗六~", "[固定回覆:門市]", "[固定回覆:門市] 想看樣式的話"].join("\n");
    expect(knowledgeBaseFixedReplies(kb).get("門市")).toBe("目前門市在雲林斗六~\n\n想看樣式的話");
  });
});

describe("fixedReply field", () => {
  const kb = "[固定回覆:線上報價] 目前沒有提供線上報價~";
  const s = { handoffMessage: "轉給師傅", maxReplyChars: 300, maxLineWidth: 17, knowledgeBase: kb };
  it("sends the named fixed reply even when the answer text is empty", () => {
    expect(decideFaqReply({ answer: "", confident: true, fixedReply: "線上報價" }, s)).toEqual({ kind: "answered", text: "目前沒有提供線上報價~" });
    expect(decideFaqReply({ answer: "", confident: false, fixedReply: "線上報價" }, s).kind).toBe("answered");
  });
  it("hands off when the name is unknown and the model was unsure", () => {
    expect(decideFaqReply({ answer: "", confident: false, fixedReply: "不存在" }, s).kind).toBe("handoff");
  });
});

describe("owner replies in a thread the bot has not seen", () => {
  it("starts the thread as the owner's", async () => {
    const { prisma } = (await import("@/lib/db/client")) as unknown as { prisma: Record<string, unknown> };
    const upserts: Array<{ create: { status: string }; update: { status: string } }> = [];
    const messages: Array<{ data: { direction: string; text: string } }> = [];
    Object.assign(prisma, {
      instagramAccount: {
        findUnique: async () => ({ id: "acc", workspaceId: "ws", provider: "INSTAGRAM", aiSettings: null, workspace: { aiSettings: null } }),
      },
      conversation: {
        findFirst: async () => null,
        upsert: async (args: (typeof upserts)[number]) => {
          upserts.push(args);
          return { id: "conv", senderName: null };
        },
      },
      conversationMessage: { create: async (args: (typeof messages)[number]) => { messages.push(args); return {}; } },
    });
    const { handleHumanEcho } = await import("@/lib/ai/faq");
    const outcome = await handleHumanEcho({
      instagramAccountId: "ig_1",
      recipientId: "user_1",
      messageId: "m_1",
      messageText: "待會見～",
    });
    expect(outcome).toBe("taken-over");
    expect(upserts[0].create.status).toBe("HUMAN");
    expect(upserts[0].update.status).toBe("HUMAN");
    expect(messages[0].data).toMatchObject({ direction: "OUT_HUMAN", text: "待會見～" });
  });
});

describe("Meta's own follow-up echoes", () => {
  it("recognises the default template follow-up and owner-listed phrases", async () => {
    const { isMetaAutomationText } = await import("@/lib/ai/faq");
    expect(isMetaAutomationText("王道明，你好！來向你打聲招呼，你有任何問題想問嗎？", "")).toBe(true);
    expect(isMetaAutomationText("Hello~ 想幫你家浴室做哪些改變呢", "[Meta自動訊息] 想幫你家浴室做哪些改變呢")).toBe(true);
    expect(isMetaAutomationText("明天下午兩點方便過去嗎", "")).toBe(false);
  });
});

describe("isAskingForReply", () => {
  it("recognises a person waiting on the owner", () => {
    for (const t of ["師傅多久會回", "還沒回嗎", "有人在嗎", "怎麼沒人理我", "什麼時候會回覆", "在嗎?", "已讀不回喔", "要等多久"]) {
      expect(isAskingForReply(t), t).toBe(true);
    }
  });
  it("leaves ordinary questions alone", () => {
    for (const t of ["工期多久", "可以現在嗎", "多少錢", "我在台中", "門檻多久會裝好", "拉門多久能裝", "麻煩師傅有空再回我一下", "好 那我等師傅回"]) {
      expect(isAskingForReply(t), t).toBe(false);
    }
  });
  it("hears someone pressing for a reply", () => {
    for (const t of ["麻煩快一點回我", "趕快回一下喔"]) expect(isAskingForReply(t), t).toBe(true);
  });
});

describe("isRenovationPriceQuestion", () => {
  it("spots a price question about renovation work", () => {
    for (const t of ["拆浴缸改乾濕分離大概多少", "整間浴室翻新預算要多少", "換馬桶跟臉盆大概多少錢", "防水重做費用怎麼算"]) {
      expect(isRenovationPriceQuestion(t), t).toBe(true);
    }
  });
  it("leaves shower-door prices, bookings and haggling alone", () => {
    for (const t of ["無框拉門多少錢", "明天可以來看浴缸嗎", "整修可以算便宜一點嗎", "整修可以分期嗎", "我在台中"]) {
      expect(isRenovationPriceQuestion(t), t).toBe(false);
    }
  });
  it("reads the work from earlier messages when the question only asks for a range", () => {
    expect(isRenovationPriceQuestion("能不能先給我大概的價格範圍", ["我想整間浴室翻新"])).toBe(true);
    expect(isRenovationPriceQuestion("能不能先給我大概的價格範圍", ["我想做無框拉門"])).toBe(false);
    expect(isRenovationPriceQuestion("浴室照片之後再說 先講馬桶大概多少", [])).toBe(true);
  });
});
