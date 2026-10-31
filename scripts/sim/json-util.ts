/** Lenient JSON extraction for model output: code fences, surrounding prose, raw line breaks in strings, trailing commas. */
export function parseJson<T>(text: string): T | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const tryParse = (x: string): T | null => {
    try {
      return JSON.parse(x) as T;
    } catch {
      return null;
    }
  };
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  const a = t.indexOf("["), z = t.lastIndexOf("]");
  const candidates = [s >= 0 && e > s ? t.slice(s, e + 1) : "", a >= 0 && z > a ? t.slice(a, z + 1) : ""].filter(Boolean);
  for (const c of candidates) {
    const r = tryParse(c) ?? tryParse(repairJson(c));
    if (r) return r;
  }
  return null;
}

/** Models sometimes put literal line breaks inside JSON strings or leave trailing commas. */
export function repairJson(c: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of c) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === "\\") {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        out += ch;
        inStr = false;
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        // drop
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}
