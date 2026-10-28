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
