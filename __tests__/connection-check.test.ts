import { describe, it, expect } from "vitest";
import { interpretInstagramCheck, interpretPageCheck } from "@/lib/ops/connection-check";

describe("connection check", () => {
  it("a Page is fine while our app is subscribed to its messages", () => {
    const body = { data: [{ id: "app1", subscribed_fields: ["messages", "message_echoes"] }] };
    expect(interpretPageCheck(true, body, "app1")).toEqual({ ok: true });
  });

  it("reports Meta's reason when the app is blocked", () => {
    const body = { error: { message: "API access\n   blocked.", code: 200 } };
    expect(interpretPageCheck(false, body, "app1")).toEqual({ ok: false, reason: "API access blocked." });
  });

  it("reports a Page that no longer sends our app its messages", () => {
    expect(interpretPageCheck(true, { data: [{ id: "other", subscribed_fields: ["messages"] }] }, "app1")).toMatchObject({
      ok: false,
    });
    expect(interpretPageCheck(true, { data: [{ id: "app1", subscribed_fields: ["feed"] }] }, "app1")).toMatchObject({
      ok: false,
    });
  });

  it("an Instagram account is fine when Meta answers", () => {
    expect(interpretInstagramCheck(true, { user_id: "1" })).toEqual({ ok: true });
    expect(interpretInstagramCheck(false, null)).toEqual({ ok: false, reason: "沒有說明原因" });
  });
});
