import { describe, it, expect } from "vitest";
import { foldChineseScript, matchKeywords } from "@/lib/utils/keyword-matcher";

describe("Traditional / Simplified Chinese keywords", () => {
  it("matches a Simplified comment against a Traditional keyword", () => {
    expect(matchKeywords("我想问它", ["問它"], false)).toEqual({
      matched: true,
      matchedKeyword: "問它",
    });
  });

  it("matches a Traditional comment against a Simplified keyword", () => {
    expect(matchKeywords("我想問他！", ["问他"], false).matched).toBe(true);
  });

  it("works with whole-word matching too", () => {
    expect(matchKeywords("睡眠日记", ["睡眠日記"], true).matched).toBe(true);
  });

  it("does not create false matches between different words", () => {
    expect(matchKeywords("问题很多", ["問它"], false).matched).toBe(false);
  });

  it("leaves non-Chinese text untouched", () => {
    expect(foldChineseScript("Open Link")).toBe("Open Link");
    expect(matchKeywords("send the LINK please", ["link"], true).matched).toBe(true);
  });

  it("folds Taiwan forms consistently on both sides", () => {
    expect(foldChineseScript("發現")).toBe(foldChineseScript("发现"));
    expect(foldChineseScript("裡面")).toBe(foldChineseScript("里面"));
  });
});
