import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("LINE notify", () => {
  it("is on only for listed accounts with credentials", async () => {
    const { lineNotifyEnabledFor } = await import("@/lib/notify/line");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "tok");
    vi.stubEnv("LINE_NOTIFY_USER_ID", "U1");
    vi.stubEnv("LINE_NOTIFY_ACCOUNT_IDS", "page1, page2");
    expect(lineNotifyEnabledFor("page2")).toBe(true);
    expect(lineNotifyEnabledFor("ig9")).toBe(false);
    vi.stubEnv("LINE_NOTIFY_USER_ID", "");
    expect(lineNotifyEnabledFor("page1")).toBe(false);
  });

  it("pushes a text message to the owner", async () => {
    const { pushLineMessage } = await import("@/lib/notify/line");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "tok");
    vi.stubEnv("LINE_NOTIFY_USER_ID", "U1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await pushLineMessage("hi")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.line.me/v2/bot/message/push");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ to: "U1", messages: [{ type: "text", text: "hi" }] });
  });
});

describe("LINE alert summary", () => {
  it("says what the customer sent, photos in words", async () => {
    const { lineAlertSummary } = await import("@/lib/ai/faq");
    expect(lineAlertSummary("可以算便宜一點嗎")).toBe("可以算便宜一點嗎");
    expect(lineAlertSummary("(客人傳了照片)\n這樣可以做嗎")).toBe("傳了照片／這樣可以做嗎");
    expect(lineAlertSummary("長".repeat(80))).toBe(`${"長".repeat(60)}…`);
  }, 30_000);
});
