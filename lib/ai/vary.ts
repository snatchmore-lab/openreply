/**
 * Public reply variation (feature 4).
 *
 * OpenReply already picks one of up to ten reply templates at random. With
 * `aiPublicReplyVary` on, the picked template is reworded slightly so even
 * the same template never posts twice with identical text. The rewrite must
 * keep every placeholder, URL and @mention the template had and add none;
 * anything else falls back to the template as written.
 */

import { z } from "zod";
import { completeJson } from "./service";
import { buildVaryUserPrompt, VARY_SYSTEM_PROMPT } from "./prompts";
import { stripFullStops } from "./text";

const VaryOutput = z.object({ reply: z.string().max(1200) });

const TOKEN_PATTERN = /\{[a-z_]+\}/gi;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const MENTION_PATTERN = /@[a-z0-9._]+/gi;

function sortedMatches(text: string, pattern: RegExp): string[] {
  return (text.match(pattern) ?? []).map((m) => m.toLowerCase()).sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Accept the rewrite only if it is non-empty, single-message, within 1.6x of
 * the template's length, and carries exactly the template's tokens, URLs and
 * mentions. Exposed for tests.
 */
export function acceptVariation(template: string, candidate: string): string | null {
  const text = stripFullStops(candidate).replace(/\s+/g, " ").trim();
  if (!text) return null;
  if ([...text].length > Math.max(20, Math.ceil([...template].length * 1.6))) return null;
  if (!sameSet(sortedMatches(template, TOKEN_PATTERN), sortedMatches(text, TOKEN_PATTERN))) {
    return null;
  }
  if (!sameSet(sortedMatches(template, URL_PATTERN), sortedMatches(text, URL_PATTERN))) {
    return null;
  }
  if (!sameSet(sortedMatches(template, MENTION_PATTERN), sortedMatches(text, MENTION_PATTERN))) {
    return null;
  }
  return text;
}

export async function varyPublicReply(
  template: string,
  commentText: string,
  campaign: { id: string; workspaceId: string },
  commentId: string
): Promise<string | null> {
  const trimmed = template.trim();
  if (!trimmed) return null;

  const outcome = await completeJson({
    feature: "vary",
    workspaceId: campaign.workspaceId,
    system: VARY_SYSTEM_PROMPT,
    user: buildVaryUserPrompt({ template: trimmed, commentText }),
    schema: VaryOutput,
    // One rewrite per comment: the cache key includes the comment id so a
    // retry of the same job reuses its rewrite instead of paying again, while
    // different comments get different wording.
    cacheScope: [campaign.id, commentId],
    maxTokens: 1024,
  });

  if (!outcome.ok) return null;
  return acceptVariation(trimmed, outcome.result.reply);
}
