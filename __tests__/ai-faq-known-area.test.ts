import { describe, it, expect, vi } from "vitest";

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

import { applyReplyRules, decideFaqReply, preReplyRule, remembersPlace } from "@/lib/ai/faq";
import { buildFaqUserPrompt } from "@/lib/ai/prompts";

const nl = String.fromCharCode(10);
const kb = [
  "[固定回覆:線上評估] 好的😊",
  "[固定回覆:線上評估] 方便傳幾張浴室照片給師傅看看嗎",
  "[固定回覆:線上評估] 另外請問是在哪個縣市/哪一區呢",
  "[固定回覆:預約] 好的~幫您預約師傅免費到府丈量討論~",
  "[固定回覆:預約] 請問是在哪個縣市/哪一區呢?",
  "[固定回覆:預約問項目] 好的~請問浴室想做哪些項目呢?",
  "[固定回覆:整修問項目] 好的~",
  "[固定回覆:整修問項目] 請問想做哪些項目呢?",
  "[固定回覆:整修問地區] 好的~",
  "[固定回覆:整修問地區] 請問是住在哪個縣市/哪一區呢😊",
  "[固定回覆:整修請傳照片] {地區}可以～",
  "[固定回覆:整修請傳照片] 可以先傳幾張現場照片",
  "[固定回覆:北部先傳照片] 台北、新北也有做唷~",
  "[固定回覆:北部先傳照片] 麻煩先傳幾張浴室照片",
  "[固定回覆:沒服務] 哇…目前還沒有服務到那邊🥹",
  "[服務地區] 苗栗 台中 彰化 南投 台北 新北",
  "[北部地區] 台北 新北 新店",
  "[沒服務地區] 新竹 台南",
  "[偏遠鄉鎮] 魚池",
].join(nl);
const settings = { handoffMessage: "轉給本人", knowledgeBase: kb, maxReplyChars: 300, maxLineWidth: 17 };
const fixedReply = (name: string) => decideFaqReply({ answer: "", confident: true, fixedReply: name }, settings);
const said = (text: string) => ({ direction: "IN", text });

describe("the area a person already gave is not asked again", () => {
  it("drops the area line of the photo button's reply (王世昌, 11/11)", () => {
    const earlier = [said("拆浴缸"), said("新北新店")];
    expect(applyReplyRules(fixedReply("線上評估"), { question: "傳浴室照片給師傅看看", earlier, settings })).toEqual({
      kind: "answered",
      text: "好的😊" + nl + "方便傳幾張浴室照片給師傅看看嗎",
    });
  });

  it("still asks when no area was ever given, or only one we do not serve", () => {
    const full = "好的😊" + nl + "方便傳幾張浴室照片給師傅看看嗎" + nl + "另外請問是在哪個縣市/哪一區呢";
    expect(applyReplyRules(fixedReply("線上評估"), { question: "傳浴室照片給師傅看看", earlier: [], settings })).toEqual({ kind: "answered", text: full });
    expect(applyReplyRules(fixedReply("線上評估"), { question: "傳浴室照片給師傅看看", earlier: [said("新竹")], settings })).toEqual({ kind: "answered", text: full });
  });

  it("moves a booking on to the work question", () => {
    const earlier = [said("我在台中北屯")];
    expect(applyReplyRules(fixedReply("預約"), { question: "預約免費到府丈量", earlier, settings })).toEqual({
      kind: "answered",
      text: "好的~請問浴室想做哪些項目呢?",
    });
  });

  it("asks for photos instead of the area after the renovation button", () => {
    const earlier = [said("彰化員林"), said("我有浴室整修需求"), { direction: "OUT_AI", text: "好的~" + nl + "請問想做哪些項目呢?" }];
    const pre = preReplyRule("整間翻新", kb, earlier, false);
    expect(pre).toMatchObject({ kind: "result", result: { model: "rule:reno-area" } });
    const decided = decideFaqReply((pre as { result: { result: { answer: string; confident: boolean; fixedReply: string } } }).result.result, settings);
    expect(applyReplyRules(decided, { question: "整間翻新", earlier, settings })).toEqual({
      kind: "answered",
      text: "彰化員林可以～" + nl + "可以先傳幾張現場照片",
    });
  });

  it("goes to the owner once photos are in, and for towns he confirms himself", () => {
    const withPhoto = [said("台中大里"), said("(客人傳了照片)")];
    expect(applyReplyRules(fixedReply("整修問地區"), { question: "想換浴櫃", earlier: withPhoto, settings })).toEqual({ kind: "handoff", text: "轉給本人" });
    expect(applyReplyRules(fixedReply("整修問地區"), { question: "想換浴櫃", earlier: [said("南投 魚池")], settings })).toEqual({ kind: "handoff", text: "轉給本人" });
  });

  it("uses the north photo line for 台北 / 新北", () => {
    expect(applyReplyRules(fixedReply("整修問地區"), { question: "想換浴櫃", earlier: [said("新北新店")], settings })).toEqual({
      kind: "answered",
      text: "台北、新北也有做唷~" + nl + "麻煩先傳幾張浴室照片",
    });
  });

  it("trims the model's own repeat, and keeps a district follow-up", () => {
    const earlier = [said("我住台中")];
    const repeat = { kind: "answered" as const, text: "有做淋浴拉門唷~" + nl + "請問是在哪個縣市/哪一區呢😊" };
    expect(applyReplyRules(repeat, { question: "有做拉門嗎", earlier, settings })).toEqual({ kind: "answered", text: "有做淋浴拉門唷~" });
    const district = { kind: "answered" as const, text: "苗栗這邊有服務唷" + nl + "請問是苗栗哪一區呢😊" };
    expect(applyReplyRules(district, { question: "苗栗", earlier: [], settings })).toEqual(district);
  });

  it("remembers served places and the owner's towns only", () => {
    expect(remembersPlace("新北新店", kb)).toBe(true);
    expect(remembersPlace("南投 魚池", kb)).toBe(true);
    expect(remembersPlace("新竹", kb)).toBe(false);
    expect(remembersPlace("想換浴櫃", kb)).toBe(false);
  });

  it("tells the model what is already known", () => {
    const prompt = buildFaqUserPrompt({ question: "還在嗎", history: [], tone: "friendly", maxChars: 300, knownPlace: "新北新店" });
    expect(prompt).toContain("新北新店");
    expect(prompt).toContain("Do not ask which county or district again");
    expect(buildFaqUserPrompt({ question: "還在嗎", history: [], tone: "friendly", maxChars: 300 })).not.toContain("Already known");
  });
});
