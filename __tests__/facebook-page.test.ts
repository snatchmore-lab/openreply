import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/instagram/sent-mids", () => ({ trackSent: <T>(p: Promise<T>) => p }));

import { sendDirectMessage, sendCommentReply } from "@/lib/instagram/send-messages";
import { getFacebookAuthorizationUrl } from "@/lib/meta/client";

afterEach(() => vi.unstubAllGlobals());

describe("Facebook Page messaging", () => {
  it("sends a Messenger RESPONSE from the Page through graph.facebook.com", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ recipient_id: "psid_1", message_id: "m_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await sendDirectMessage({
      context: { provider: "FACEBOOK_PAGE", accessToken: "page-token", pageId: "page_123" },
      instagramAccountId: "page_123",
      userId: "psid_1",
      message: "你好 嘉義有服務喔",
    });

    expect(out).toEqual({ recipient_id: "psid_1", message_id: "m_1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/page_123\/messages$/);
    expect(init.headers.Authorization).toBe("Bearer page-token");
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: "psid_1" },
      messaging_type: "RESPONSE",
      message: { text: "你好 嘉義有服務喔" },
    });
  });

  it("refuses Instagram-only features for a Page instead of calling Instagram", async () => {
    await expect(
      sendCommentReply({
        context: { provider: "FACEBOOK_PAGE", accessToken: "t", pageId: "p" },
        commentId: "c",
        message: "hi",
      })
    ).rejects.toThrow(/not available for Facebook Pages/);
  });

  it("asks Facebook Login for the Page messaging permissions", () => {
    const url = new URL(getFacebookAuthorizationUrl("https://x.test/cb", "state1"));
    expect(url.hostname).toBe("www.facebook.com");
    expect(url.searchParams.get("config_id")).toBe("1086499857525329");
    expect(url.searchParams.get("redirect_uri")).toBe("https://x.test/cb");
  });
});

describe("Page photo messages", () => {
  const event = (message: Record<string, unknown>, object = "page") => ({
    object,
    entry: [{ id: "page1", time: 0, messaging: [{ sender: { id: "u1" }, recipient: { id: "page1" }, message: { mid: "m1", ...message } }] }],
  });

  it("turns a customer photo into a placeholder line", async () => {
    const { parseMessageEvents } = await import("@/lib/meta/webhook");
    expect(parseMessageEvents(event({ attachments: [{ type: "image" }] }))[0].messageText).toBe("(客人傳了照片)");
  });

  it("voice notes, files and shared links come through as placeholders", async () => {
    const { parseMessageEvents } = await import("@/lib/meta/webhook");
    expect(parseMessageEvents(event({ attachments: [{ type: "audio" }] }))[0].messageText).toBe("(客人傳了語音)");
    expect(parseMessageEvents(event({ attachments: [{ type: "file" }] }))[0].messageText).toBe("(客人傳了檔案)");
    expect(parseMessageEvents(event({ attachments: [{ type: "fallback" }] }))[0].messageText).toBe("(客人分享了連結)");
  });

  it("ignores stickers and Instagram media", async () => {
    const { parseMessageEvents } = await import("@/lib/meta/webhook");
    expect(parseMessageEvents(event({ attachments: [{ type: "image" }], sticker_id: 369239263222822 }))).toEqual([]);
    expect(parseMessageEvents(event({ attachments: [{ type: "image", payload: { sticker_id: 369239263222822 } }] }))).toEqual([]);
    expect(parseMessageEvents(event({ attachments: [{ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/t39.1997-6/39178562_1505197616293642_n.png" } }] }))).toEqual([]);
    expect(parseMessageEvents(event({ attachments: [{ type: "image" }] }, "instagram"))).toEqual([]);
  });
});
