/**
 * House style for any text the AI writes that reaches a recipient: no
 * Chinese full stop 「。」. A full stop between sentences becomes a space, one
 * at the end (or before a closing quote/emoji) just disappears. The prompts
 * ask for this too; this is the guarantee.
 */
export function stripFullStops(text: string): string {
  return text
    .replace(/。+(?=\s*$)/g, "") // trailing
    .replace(/。+(\s*[」』”"）)])/g, "$1") // before a closing bracket/quote
    .replace(/。+/g, " ") // between sentences
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}
