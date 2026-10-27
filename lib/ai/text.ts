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

// ICU's dictionary-based word breaker: knows that 免費, 能力, 一下 are words,
// so a line never splits inside one. Absent on runtimes without full ICU.
const WORDS =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;

/**
 * Split into units that must stay together: Chinese words (2–4 characters),
 * ASCII words, emoji sequences, and single characters for everything else.
 */
function units(line: string): string[] {
  const out: string[] = [];
  const pieces = WORDS ? Array.from(WORDS.segment(line), (s) => s.segment) : [line];
  for (const piece of pieces) {
    if (/^\p{Script=Han}{2,4}$/u.test(piece)) {
      out.push(piece);
      continue;
    }
    pushChars(out, piece);
  }
  return out;
}

function pushChars(out: string[], text: string): void {
  for (const ch of text) {
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
}

const SOFT_BREAK = /^[，,；;]$/;
const DROP_AT_BREAK = /^[，,]$/;

const EMOJI = /\p{Extended_Pictographic}/u;
const isHanger = (unit: string) => /^\s$/.test(unit) || EMOJI.test(unit);

/** Width of a line, not counting a closing emoji (it may hang past the limit). */
function textWidth(line: string): number {
  return displayWidth(line.replace(/[\s\p{Extended_Pictographic}‍️]+$/u, ""));
}

/** Characters that must never start a line (they belong to the line before). */
const NO_LINE_START = /^[，、。,.：:；;！!？?」』）)》〉】…～~]$/;

const widthOf = (us: string[]) => displayWidth(us.join(""));

// Good places to end a line: after a sentence particle or a closing bracket.
const BREAK_AFTER = /^[喔唷呢吧嗎啊呀耶囉啦哦後話》」』）)]$/;
// Good places to start a line: before an opening bracket or a function word.
const BREAK_BEFORE = /^[《「『（(可就或和跟再也都讓把被從給用先還只由]$/;
// Characters that read badly at the start of a line (they end a word).
const WEAK_LINE_START = /^[的了著過們己見下]$/;

/** True when a break before index `i` would fall inside 「…」, 《…》 or （…）. */
function insideBrackets(us: string[], i: number): boolean {
  let depth = 0;
  for (let k = 0; k < i; k += 1) {
    if (/^[《「『（(]$/.test(us[k])) depth += 1;
    else if (/^[》」』）)]$/.test(us[k])) depth = Math.max(0, depth - 1);
  }
  return depth > 0;
}

/**
 * Split a phrase that is too long into lines no wider than `max`, aiming for
 * even lengths (12 characters → 6 + 6, not 10 + a stranded 2) and preferring
 * to break after particles or brackets rather than inside a word.
 */
function splitBalanced(us: string[], max: number): string[][] {
  const chunks: string[][] = [];
  let rest = us;
  while (widthOf(rest) > max) {
    const total = widthOf(rest);
    const target = total / Math.ceil(total / max);
    let best = -1;
    let bestScore = -Infinity;
    let width = 0;
    for (let i = 1; i < rest.length; i += 1) {
      width += displayWidth(rest[i - 1]);
      if (width > max) break;
      if (width < 2 || NO_LINE_START.test(rest[i])) continue;
      let score = -Math.abs(width - target);
      if (BREAK_AFTER.test(rest[i - 1])) score += 2.5;
      if (BREAK_BEFORE.test(rest[i])) score += 2;
      // Never split a bracketed name like 「訊息請求」 when it can be avoided.
      if (/^[《「『（(]$/.test(rest[i]) || /^[》」』）)]$/.test(rest[i - 1])) score += 1.5;
      if (insideBrackets(rest, i)) score -= 2;
      if (WEAK_LINE_START.test(rest[i])) score -= 1.5;
      if (widthOf(rest.slice(i)) < 2) score -= 5; // no stranded tail
      // On a tie, take the later break: it keeps more of the phrase together.
      if (score >= bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) best = 1; // a single unit wider than a line (a long URL)
    chunks.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/**
 * Break one line into lines no wider than `max`. Every comma starts a new
 * line (house style: one phrase per line); a phrase longer than `max` is
 * split evenly. Spaces are not break points, so "點 bio 連結" stays together.
 * A closing emoji stays on the last line.
 */
function wrapLine(line: string, max: number): string[] {
  if (textWidth(line) <= max) return [line];

  const all = units(line);
  // Peel off a closing emoji (and spaces) so it can hang on the last line.
  let end = all.length;
  while (end > 0 && isHanger(all[end - 1])) end -= 1;
  const tail = all.slice(end).join("").trim();

  // Phrases, each with the separator that followed it ("，" or " " or "").
  const phrases: { us: string[]; sep: string }[] = [];
  let cur: string[] = [];
  for (const unit of all.slice(0, end)) {
    if (SOFT_BREAK.test(unit)) {
      if (DROP_AT_BREAK.test(unit)) {
        if (cur.length > 0) phrases.push({ us: cur, sep: unit });
      } else {
        cur.push(unit); // 、：； stay with their phrase
        phrases.push({ us: cur, sep: "" });
      }
      cur = [];
    } else {
      cur.push(unit);
    }
  }
  if (cur.length > 0) phrases.push({ us: cur, sep: "" });

  const lines: string[] = [];
  for (const { us } of phrases) {
    for (const chunk of splitBalanced(us, max)) {
      const text = chunk.join("").trim();
      if (text) lines.push(text);
    }
  }

  if (tail) {
    if (lines.length === 0) lines.push(tail);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${tail}`;
  }
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
    // A comma left dangling at the end of a line reads as a typo.
    .map((line) => line.replace(/[，,、]+$/, "").trim())
    .filter(Boolean)
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
