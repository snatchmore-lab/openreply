import { describe, it, expect, vi, afterEach } from "vitest";
import { sendPageMessage } from "@/lib/meta/client";

afterEach(() => vi.unstubAllGlobals());

function captureBody() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ recipient_id: "u1", message_id: "m1" }), { status: 200, headers: { "Content-Type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  return () => JSON.parse(fetchMock.mock.calls[0][1].body as string) as { messaging_type: string; message: { text: string } };
}

describe("Messenger messaging_type", () => {
  it("marks a reply as RESPONSE", async () => {
    const body = captureBody();
    await sendPageMessage("token", "page1", "u1", "好的~");
    expect(body().messaging_type).toBe("RESPONSE");
  });

  it("marks a follow-up as UPDATE", async () => {
    const body = captureBody();
    await sendPageMessage("token", "page1", "u1", "哈囉~ 剛剛的訊息有看到嗎", true);
    expect(body()).toMatchObject({ messaging_type: "UPDATE", message: { text: "哈囉~ 剛剛的訊息有看到嗎" } });
  });
});
