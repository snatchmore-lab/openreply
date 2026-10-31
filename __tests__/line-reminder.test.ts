import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ prisma: {} }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: vi.fn(), LINE_REMIND_JOB_NAME: "line-remind" }));

import { reminderText, shouldRemind } from "@/lib/notify/line-reminder";

const handoffAt = new Date("2026-10-29T10:00:00Z");
const at = (min: number) => new Date(handoffAt.getTime() + min * 60_000);

describe("LINE reminder", () => {
  it("reminds once when the thread is still waiting and nobody replied", () => {
    expect(shouldRemind({ status: "NEEDS_HUMAN", messages: [{ direction: "IN", createdAt: at(-1) }] }, handoffAt)).toBe(true);
  });

  it("stays quiet once the owner replied or handled the thread", () => {
    expect(shouldRemind({ status: "NEEDS_HUMAN", messages: [{ direction: "OUT_HUMAN", createdAt: at(20) }] }, handoffAt)).toBe(false);
    expect(shouldRemind({ status: "HUMAN", messages: [] }, handoffAt)).toBe(false);
    expect(shouldRemind({ status: "AI", messages: [] }, handoffAt)).toBe(false);
  });

  it("ignores human replies from before the handoff", () => {
    expect(shouldRemind({ status: "NEEDS_HUMAN", messages: [{ direction: "OUT_HUMAN", createdAt: at(-30) }] }, handoffAt)).toBe(true);
  });
});

describe("reminder wording", () => {
  it("says which reminder it is", () => {
    expect(reminderText({ text: "\"王小明\" 需要你回復" })).toBe("提醒：\"王小明\" 需要你回復");
    expect(reminderText({ text: "\"王小明\" 需要你回復", after: "1d" })).toBe("已經超過一天沒人回覆：\"王小明\" 需要你回復");
  });
});
