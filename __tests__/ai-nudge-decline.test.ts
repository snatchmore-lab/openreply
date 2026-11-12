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

import { declinedFollowUp } from "@/lib/ai/nudge";

const said = (text: string) => ({ direction: "IN", text });
const bot = (text: string) => ({ direction: "OUT_AI", text });

describe("no follow-up after the person opts out", () => {
  it("honours a clear request to stop", () => {
    for (const t of ["不要再傳了", "請不要再傳訊息給我", "別再傳了 很煩", "不用再聯絡了", "我已經找別家了", "不需要了 謝謝", "沒興趣"]) {
      expect(declinedFollowUp([said("淋浴拉門"), bot("請問是在哪個縣市呢"), said(t)]), t).toBe(true);
    }
  });

  it("treats a closing 不用了 / 再考慮看看 as a no", () => {
    for (const t of ["不用了", "不用了謝謝", "先不用", "我再考慮看看", "再看看", "那先不用了 謝謝😊"]) {
      expect(declinedFollowUp([said("無框多少"), bot("目前沒有提供線上報價唷"), said(t)]), t).toBe(true);
    }
  });

  it("does not mistake an answer to the bot's own question", () => {
    const asked = bot("浴室的龍頭、馬桶或配件" + String.fromCharCode(10) + "有沒有想一起換呢😊");
    expect(declinedFollowUp([said("想裝拉門"), asked, said("不用")])).toBe(false);
    expect(declinedFollowUp([said("想裝拉門"), asked, said("不用了")])).toBe(false);
  });

  it("leaves ordinary messages alone", () => {
    for (const t of ["不用拆浴缸可以嗎", "我想裝拉門", "台中北屯", "好的謝謝", "不要太貴的款式"]) {
      expect(declinedFollowUp([said(t)]), t).toBe(false);
    }
    expect(declinedFollowUp([bot("不要再傳了")])).toBe(false);
  });
});
