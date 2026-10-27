/**
 * Human-like pacing for automated replies. Instant replies to every comment
 * and DM look like a bot; a short random wait looks like a person.
 *
 * - DMs (comment DMs, DM keyword replies, FAQ answers): 5–15 s.
 * - Public comment replies: 15–30 s after the comment, so always after the DM.
 *
 * Button taps are not paced: the person is waiting on the button.
 */

function between(minMs: number, maxMs: number, rand: () => number): number {
  return Math.round(minMs + rand() * (maxMs - minMs));
}

export function humanDelays(rand: () => number = Math.random): {
  dmMs: number;
  publicReplyMs: number;
  /** How long after the DM pass the public reply pass should run. */
  publicReplyAfterDmMs: number;
} {
  const dmMs = between(5_000, 15_000, rand);
  const publicReplyMs = between(15_000, 30_000, rand);
  return { dmMs, publicReplyMs, publicReplyAfterDmMs: Math.max(1_000, publicReplyMs - dmMs) };
}
