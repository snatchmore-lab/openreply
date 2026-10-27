import { describe, it, expect } from "vitest";
import { humanDelays } from "@/lib/queue/pacing";

describe("humanDelays", () => {
  it("keeps DMs in 5–15 s and public replies in 15–30 s, public after the DM", () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const d = humanDelays(() => r);
      expect(d.dmMs).toBeGreaterThanOrEqual(5_000);
      expect(d.dmMs).toBeLessThanOrEqual(15_000);
      expect(d.publicReplyMs).toBeGreaterThanOrEqual(15_000);
      expect(d.publicReplyMs).toBeLessThanOrEqual(30_000);
      expect(d.dmMs + d.publicReplyAfterDmMs).toBeGreaterThanOrEqual(d.publicReplyMs);
    }
  });
});
