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
