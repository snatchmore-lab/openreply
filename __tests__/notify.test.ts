import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { redisSet } = vi.hoisted(() => ({ redisSet: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({ set: redisSet }) }));

import { isValidEmail, sendNotifyEmail, sendThrottledNotifyEmail } from "@/lib/notify/email";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.RESEND_API_KEY = "re_test";
  process.env.REDIS_URL = "redis://test";
  delete process.env.EMAIL_SERVER;
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.REDIS_URL;
});

describe("isValidEmail", () => {
  it("accepts a normal address and rejects junk", () => {
    expect(isValidEmail("miumiu1110530@gmail.com")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe("sendNotifyEmail", () => {
  it("posts to Resend with the configured sender", async () => {
    process.env.EMAIL_FROM = "OpenReply <login@rbancase.com>";
    expect(await sendNotifyEmail({ to: "a@b.co", subject: "s", text: "t" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(init.body)).toEqual({
      from: "OpenReply <login@rbancase.com>",
      to: ["a@b.co"],
      subject: "s",
      text: "t",
    });
  });

  it("never throws and reports failure when Resend errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    expect(await sendNotifyEmail({ to: "a@b.co", subject: "s", text: "t" })).toBe(false);
    fetchMock.mockRejectedValue(new Error("network"));
    expect(await sendNotifyEmail({ to: "a@b.co", subject: "s", text: "t" })).toBe(false);
  });

  it("does nothing for an invalid recipient", async () => {
    expect(await sendNotifyEmail({ to: "nope", subject: "s", text: "t" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendThrottledNotifyEmail", () => {
  it("sends once per window", async () => {
    redisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    const mail = { to: "a@b.co", subject: "s", text: "t" };
    expect(await sendThrottledNotifyEmail("k", 60, mail)).toBe(true);
    expect(await sendThrottledNotifyEmail("k", 60, mail)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(redisSet).toHaveBeenCalledWith("openreply:notify:k", "1", "EX", 60, "NX");
  });

  it("still sends when Redis is down", async () => {
    redisSet.mockRejectedValue(new Error("down"));
    expect(await sendThrottledNotifyEmail("k", 60, { to: "a@b.co", subject: "s", text: "t" })).toBe(true);
  });
});
