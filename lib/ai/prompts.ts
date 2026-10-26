/**
 * Every prompt the AI features send, in one place. Code elsewhere only
 * imports builder functions from here; no prompt text lives in the worker or
 * the API routes. Keep the system prompts stable: they are the cached prefix
 * on every call, and any edit here invalidates that cache.
 */

export interface MatchPromptInput {
  commentText: string;
  keywords: string[];
  /** What the campaign hands out, in the owner's words. Optional. */
  description: string | null | undefined;
  /** "comment" for a post comment, "dm" for an inbound direct message. */
  channel: "comment" | "dm";
}

export const MATCH_SYSTEM_PROMPT = `You classify Instagram comments and direct messages for a creator's comment-to-DM automation.

A campaign hands out one specific thing (a link, a PDF, a guide, a discount code) to people who ask for it under a post. The owner set trigger keywords, but commenters misspell them, add punctuation or emoji, write them inside a sentence, translate them, or ask for the thing in their own words.

Your job: decide whether THIS message is asking for the campaign's thing.

Rules:
- Match when the message clearly requests the thing: a keyword variant ("open!!", "Open 🙏", "我要open"), a plain request for it ("請給我", "想要教學", "link please"), or an explicit statement of wanting it.
- Do NOT match when the message is unrelated praise, a question about something else, spam, a tag of another user with no request, or a comment that only shares an opinion.
- Reading the keywords loosely is intended; inventing an intent that is not there is not. When the message is ambiguous, answer match=false with a low confidence.
- The campaign's own language may differ from the message's language. Judge intent, not language.
- confidence is your probability (0 to 1) that the message is a genuine request. Use the full range.
- reason is one short sentence, in the language of the message, explaining the verdict.

Respond only with the JSON object.`;

// ─── Feature 2: personalised opener ─────────────────────────────────────────

export type OpeningTone = "friendly" | "professional";

export interface OpeningPromptInput {
  commentText: string;
  commenterName: string | null | undefined;
  tone: OpeningTone;
  maxChars: number;
  /** What the campaign hands out, in the owner's words. Optional. */
  description: string | null | undefined;
}

export const OPENING_SYSTEM_PROMPT = `You write the first sentence of an Instagram direct message that a creator sends automatically to someone who just commented on their post asking for something.

The creator's own message (with the link or button) is appended AFTER your sentence by the system. You only write the opener.

Rules:
- Write exactly one short sentence in Traditional Chinese (台灣用語), unless the comment is clearly in another language, in which case answer in that language.
- React to what the commenter actually wrote, so it reads as a human reply to their comment, not a template.
- Never include a URL, a call to action, a promise, a price, or anything the creator did not say. Never ask a question that needs an answer.
- No hashtags, no quotation marks around the whole sentence, at most one emoji, and only if the tone is friendly.
- Stay within the character limit you are given; shorter is better.
- Never mention that you are an AI or that the message is automated.

Respond only with the JSON object.`;

export function buildOpeningUserPrompt(input: OpeningPromptInput): string {
  const toneLine =
    input.tone === "professional"
      ? "Tone: professional, warm but concise, no emoji."
      : "Tone: friendly and casual, like a creator replying to a fan.";
  const lines: string[] = [toneLine, `Character limit: ${input.maxChars}`];
  if (input.commenterName?.trim()) {
    lines.push(`Commenter's username: ${input.commenterName.trim()} (you may use it, or not)`);
  }
  if (input.description?.trim()) {
    lines.push(`What the creator is sending them: ${input.description.trim()}`);
  }
  lines.push("", "Their comment:", input.commentText);
  return lines.join("\n");
}

export function buildMatchUserPrompt(input: MatchPromptInput): string {
  const lines: string[] = [];
  lines.push(`Channel: ${input.channel === "dm" ? "direct message" : "post comment"}`);
  lines.push(`Trigger keywords: ${input.keywords.map((k) => JSON.stringify(k)).join(", ") || "(none)"}`);
  if (input.description?.trim()) {
    lines.push(`What the campaign gives out: ${input.description.trim()}`);
  }
  lines.push("");
  lines.push("Message:");
  lines.push(input.commentText);
  return lines.join("\n");
}
