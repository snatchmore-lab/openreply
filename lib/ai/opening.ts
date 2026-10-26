/**
 * AI personalised opener (feature 2).
 *
 * Produces one short sentence that reacts to the commenter's words. The
 * worker prepends it to the owner's dmMessage; the owner's text, the {link}
 * token, the tracked links and the buttons are never passed to the model and
 * never altered. Any failure (AI off, cap reached, provider error, unusable
 * output) returns null and the DM goes out exactly as configured.
 */

import { z } from "zod";
import { completeJson } from "./service";
import { capByLines, formatAiText } from "./text";
import {
  buildOpeningUserPrompt,
  OPENING_SYSTEM_PROMPT,
  type OpeningTone,
} from "./prompts";

export const DEFAULT_OPENING_MAX_CHARS = 40;
export const MIN_OPENING_MAX_CHARS = 10;
export const MAX_OPENING_MAX_CHARS = 120;

const OpeningOutput = z.object({
  opening: z.string().max(400),
});

export interface OpeningCampaign {
  id: string;
  workspaceId: string;
  aiOpeningTone: string;
  aiOpeningMaxChars: number;
  aiMatchDescription: string | null;
}

export function normalizeTone(value: string | null | undefined): OpeningTone {
  return value === "professional" ? "professional" : "friendly";
}

export function clampMaxChars(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_OPENING_MAX_CHARS;
  }
  return Math.min(MAX_OPENING_MAX_CHARS, Math.max(MIN_OPENING_MAX_CHARS, Math.round(value)));
}

const URL_PATTERN = /https?:\/\/\S+|www\.\S+/gi;

/**
 * Last line of defence between the model and the DM: strip anything that
 * must never reach a recipient from an automated opener, lay it out in short
 * lines, and enforce the length cap. Returns null when nothing usable is left.
 */
export function sanitizeOpening(raw: string, maxChars: number): string | null {
  let text = raw
    .replace(URL_PATTERN, "")
    .replace(/\{[a-z_]+\}/gi, "") // never let the model emit template tokens
    .replace(/[#＃]\S+/g, "")
    .trim();
  // Models sometimes wrap the whole sentence in quotes despite instructions.
  text = text.replace(/^["「『“]+/, "").replace(/["」』”]+$/, "").trim();
  text = capByLines(formatAiText(text), maxChars);
  return text || null;
}

export async function generateOpening(
  commentText: string,
  commenterName: string | null | undefined,
  campaign: OpeningCampaign
): Promise<string | null> {
  const trimmed = commentText.trim();
  if (!trimmed) return null;

  const tone = normalizeTone(campaign.aiOpeningTone);
  const maxChars = clampMaxChars(campaign.aiOpeningMaxChars);

  const outcome = await completeJson({
    feature: "opening",
    workspaceId: campaign.workspaceId,
    system: OPENING_SYSTEM_PROMPT,
    user: buildOpeningUserPrompt({
      commentText: trimmed.slice(0, 1000),
      commenterName,
      tone,
      maxChars,
      description: campaign.aiMatchDescription,
    }),
    schema: OpeningOutput,
    cacheScope: [campaign.id],
    maxTokens: 1024,
  });

  if (!outcome.ok) return null;
  return sanitizeOpening(outcome.result.opening, maxChars);
}

/** The exact text the recipient sees: opener, blank line, the owner's message. */
export function composeDmWithOpening(opening: string | null, dmMessage: string): string {
  return opening ? `${opening}\n\n${dmMessage}` : dmMessage;
}
