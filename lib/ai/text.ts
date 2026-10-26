/**
 * House style for any text the AI writes that reaches a recipient:
 *  - no Chinese full stop 「。」;
 *  - one phrase per line, never a space standing in for a line break;
 *  - every line at most MAX_LINE_WIDTH wide, so it never wraps on a phone.
 * The prompts ask for this too; this is the guarantee.
 */

/** Widest line, in Chinese characters. Two ASCII letters/digits count as one. */
export const MAX_LINE_WIDTH = 10;

const ZERO_WIDTH = /[‍︎️]|[\u{1f3fb}-\u{1f3ff}]/u;

/** How wide a string looks: CJK and emoji 1, ASCII 0.5, joiners 0. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    if (ZERO_WIDTH.test(ch)) continue;
    const code = ch.codePointAt(0) ?? 0;
    width += code < 0x7f ? 0.5 : 1;
  }
  return width;
}

/**
 * Remove 「。」. One at the end (or before a closing quote) disappears; one
 * between sentences becomes a line break.
 */
export function stripFullStops(text: string): string {
  return text
    .replace(/。+(?=\s*$)/g, "") // trailing
    .replace(/。+\s*(?=\p{Extended_Pictographic}[\p{Extended_Pictographic}‍️\s]*$)/gu, " ") // before a closing emoji
    .replace(/。+(\s*[」』”"）)])/g, "$1") // before a closing bracket/quote
    .replace(/。+\s*/g, "\n") // between sentences
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const HAN = /\p{Script=Han}/u;
const ASCII = /^[\x21-\x7e]$/;

/** Split into units that must stay together: ASCII words, emoji sequences, single characters. */
function units(line: string): string[] {
  const out: string[] = [];
  for (const ch of line) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ASCII.test(ch) && /[\x21-\x7e]$/.test(prev)) {
      out[out.length - 1] = prev + ch;
    } else if (prev !== undefined && ZERO_WIDTH.test(ch)) {
      out[out.length - 1] = prev + ch;
    } else if (prev !== undefined && prev.endsWith("‍")) {
      out[out.length - 1] = prev + ch;
    } else {
      out.push(ch);
    }
  }
  return out;
}

const SOFT_BREAK = /^[，、,：:；;\s]$/;
const DROP_AT_BREAK = /^[，,\s]$/;

const EMOJI = /\p{Extended_Pictographic}/u;
const isHanger = (unit: string) => /^\s$/.test(unit) || EMOJI.test(unit);

/** Width of a line, not counting a closing emoji (it may hang past the limit). */
function textWidth(line: string): number {
  return displayWidth(line.replace(/[\s\p{Extended_Pictographic}‍️]+$/u, ""));
}

/**
 * Break one line into lines no wider than `max`, preferring commas and spaces.
 * A closing emoji stays on the last line instead of sitting alone.
 */
function wrapLine(line: string, max: number): string[] {
  if (textWidth(line) <= max) return [line];
  const lines: string[] = [];
  let current: string[] = [];
  let width = 0;
  const flush = () => {
    const text = current.join("").trim();
    if (text) lines.push(text);
    current = [];
    width = 0;
  };
  const all = units(line);
  for (let u = 0; u < all.length; u += 1) {
    const unit = all[u];
    const w = displayWidth(unit);
    const closing = all.slice(u).every(isHanger);
    if (width + w > max && current.length > 0 && !closing) {
      // Prefer the last comma/space in the second half of the line.
      let cut = -1;
      let acc = 0;
      for (let i = 0; i < current.length; i += 1) {
        acc += displayWidth(current[i]);
        if (SOFT_BREAK.test(current[i]) && acc >= max / 2) cut = i;
      }
      if (cut >= 0) {
        const rest = current.slice(cut + 1);
        current = DROP_AT_BREAK.test(current[cut]) ? current.slice(0, cut) : current.slice(0, cut + 1);
        flush();
        current = rest;
        width = displayWidth(rest.join(""));
        while (current.length > 0 && /^\s$/.test(current[0])) current.shift();
      } else {
        flush();
      }
    }
    if (current.length === 0 && /^\s$/.test(unit)) continue;
    current.push(unit);
    width += w;
  }
  flush();
  return lines;
}

/**
 * Apply the house style to AI text: no 「。」, a new line for each phrase,
 * and no line wider than `max`.
 */
export function formatAiText(text: string, max = MAX_LINE_WIDTH): string {
  const chars = [...stripFullStops(text)];
  // A space between two phrases (Chinese or emoji on the left, Chinese on the
  // right) is a line break the model wrote as a space.
  let joined = "";
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === " " && i > 0) {
      const before = chars[i - 1];
      const after = chars[i + 1] ?? "";
      if (!ASCII.test(before) && HAN.test(after)) {
        joined += "\n";
        continue;
      }
    }
    // Sentence enders followed by more Chinese also start a new line.
    joined += ch;
    if (/[！？!?]/.test(ch) && HAN.test(chars[i + 1] ?? "")) joined += "\n";
  }
  return joined
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .flatMap((line) => wrapLine(line, max))
    .join("\n");
}

/** Keep whole lines while the text, line breaks included, fits `maxChars`. */
export function capByLines(text: string, maxChars: number): string {
  const kept: string[] = [];
  let total = 0;
  for (const line of text.split("\n")) {
    const len = [...line].length + (kept.length > 0 ? 1 : 0);
    if (total + len > maxChars) {
      if (kept.length === 0) kept.push([...line].slice(0, maxChars).join("").trimEnd());
      break;
    }
    kept.push(line);
    total += len;
  }
  return kept.join("\n").trim();
}
