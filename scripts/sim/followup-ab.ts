/**
 * A/B test of the one-hour follow-up line. Takes simulated conversations
 * that stopped after a bot answer (from a run-sim results.json), shows each
 * customer every variant an hour later, and asks whether they would reply
 * and how it felt. Simulated customers only estimate a trend; the numbers
 * are not real reply rates.
 *
 *   cd openreply; npx tsx scripts/sim/followup-ab.ts <results.json> <out-dir> [count]
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [resultsPath, outDir, countArg] = process.argv.slice(2);
if (!resultsPath || !outDir) throw new Error("usage: followup-ab.ts <results.json> <out-dir> [count]");
const COUNT = Number(countArg ?? 500);
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
fs.mkdirSync(outDir, { recursive: true });
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** The three lines in the knowledge base today, plus two new ones to compare against. */
const VARIANTS: Record<string, string> = {
  "A 現在的第1則": "Hello~ 不好意思打擾一下😊\n方便的話回覆我一下\n師傅好幫您安排唷",
  "B 現在的第2則": "哈囉~ 剛剛的訊息有看到嗎^_^\n有空回我一下\n再幫您接著處理",
  "C 現在的第3則": "您好~ 如果還有想了解的\n隨時跟我說唷😊\n師傅可以免費到府丈量討論",
  "D 新：給好處": "對了~ 師傅到府丈量是免費的\n現場可以直接看樣式、報價\n要幫您安排嗎😊",
  "E 新：接著問": "剛剛的問題有幫到您嗎😊\n有想再問的隨時說\n不急的話也沒關係唷",
};

interface Turn { role: "customer" | "bot"; text: string; kind?: string }
interface Convo { persona: { id: number; area: string; need: string; style: string; goal: string }; turns: Turn[] }
interface Verdict { reply: boolean; message: string; annoyed: number; reason: string }

async function main() {
  const data = JSON.parse(fs.readFileSync(resultsPath, "utf8")) as { results: Convo[] };
  // Threads whose last bot turn was a real answer (not a handoff or 沒服務):
  // the ones the nudge is for.
  const eligible = data.results.filter((c) => {
    const lastBot = [...c.turns].reverse().find((t) => t.role === "bot");
    return lastBot && lastBot.kind === "answered" && !lastBot.text.includes("還沒有服務到那邊") && c.turns.length >= 2;
  });
  const sample = eligible.slice(0, COUNT);
  log(`${eligible.length} eligible, using ${sample.length}`);

  const requests = sample.flatMap((c, i) =>
    Object.entries(VARIANTS).map(([key, text]) => ({
      custom_id: `${i}|${key.slice(0, 1)}`,
      params: {
        model: MODEL,
        max_tokens: 300,
        output_config: { effort: "low" as const },
        system: [{ type: "text" as const, text: "You role-play a Taiwanese customer honestly. Output JSON only." }],
        messages: [{
          role: "user" as const,
          content: `你在 Facebook Messenger 私訊「御本衛浴」。你的資料：所在地 ${c.persona.area}；想做 ${c.persona.need}；個性 ${c.persona.style}；原本想達成 ${c.persona.goal}

剛才的對話（舊到新）：
${c.turns.map((t) => `${t.role === "customer" ? "你" : "店家"}：${t.text.replace(/\n/g, " ")}`).join("\n")}

你看完最後一則後沒有再回，去忙別的了。一個小時後店家傳來這則：
「${text.replace(/\n/g, " ")}」

請誠實依你的個性判斷：你會不會回？會回什麼？這則訊息讓你感覺如何（1=很自然不打擾，5=很煩想封鎖）？
只輸出 JSON：{"reply":true或false,"message":"你會回的話或空字串","annoyed":1到5,"reason":"一句話"}`,
        }],
      },
    }))
  );

  const batch = await client.messages.batches.create({ requests });
  log(`batch ${batch.id}: ${requests.length} requests`);
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  const verdicts = new Map<string, Verdict>();
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type !== "succeeded") continue;
    const text = r.result.message.content.map((c) => ("text" in c ? c.text : "")).join("");
    const v = parseJson<Verdict>(text);
    if (v && typeof v.reply === "boolean") verdicts.set(r.custom_id, v);
  }

  const rows = Object.keys(VARIANTS).map((key) => {
    const k = key.slice(0, 1);
    const vs = sample.map((_, i) => verdicts.get(`${i}|${k}`)).filter((v): v is Verdict => Boolean(v));
    const replies = vs.filter((v) => v.reply).length;
    const annoyed = vs.reduce((s, v) => s + (Number(v.annoyed) || 0), 0) / Math.max(1, vs.length);
    const veryAnnoyed = vs.filter((v) => Number(v.annoyed) >= 4).length;
    return { key, text: VARIANTS[key], n: vs.length, replies, replyRate: replies / Math.max(1, vs.length), annoyed, veryAnnoyed };
  });
  // By customer style, for the winner and the current first line.
  const byStyle = new Map<string, Map<string, { n: number; replies: number }>>();
  sample.forEach((c, i) => {
    const style = c.persona.style.slice(0, 12);
    for (const key of Object.keys(VARIANTS)) {
      const v = verdicts.get(`${i}|${key.slice(0, 1)}`);
      if (!v) continue;
      const m = byStyle.get(key) ?? new Map();
      const cur = m.get(style) ?? { n: 0, replies: 0 };
      cur.n += 1;
      cur.replies += v.reply ? 1 : 0;
      m.set(style, cur);
      byStyle.set(key, m);
    }
  });

  fs.writeFileSync(path.join(outDir, "followup-ab.json"), JSON.stringify({ rows, verdicts: [...verdicts], sample: sample.map((c) => c.persona) }, null, 2));
  const md = [
    `# 1 小時追蹤訊息 A/B 模擬（${new Date().toISOString().slice(0, 10)}）`,
    "",
    `${sample.length} 位模擬客人，每位都看過 5 個版本，問「會不會回、感覺多打擾」。模擬客人只能估趨勢，不是真實回覆率`,
    "",
    "| 版本 | 內容 | 會回的比例 | 平均打擾感 (1~5) | 覺得很煩 (4~5) |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.key} | ${r.text.replace(/\n/g, " / ")} | ${(r.replyRate * 100).toFixed(0)}%（${r.replies}/${r.n}） | ${r.annoyed.toFixed(2)} | ${r.veryAnnoyed} |`),
    "",
    "## 客人會回什麼（每個版本挑 5 句）",
    "",
  ];
  for (const key of Object.keys(VARIANTS)) {
    const k = key.slice(0, 1);
    const said = sample.map((_, i) => verdicts.get(`${i}|${k}`)).filter((v): v is Verdict => Boolean(v?.reply && v.message)).slice(0, 5);
    md.push(`**${key}**`, "", ...said.map((v) => `- 「${v.message.replace(/\n/g, " ")}」（${v.reason}）`), "");
  }
  md.push("## 不回的理由（最常見）", "");
  const reasons = new Map<string, number>();
  for (const v of verdicts.values()) if (!v.reply) reasons.set(v.reason.slice(0, 30), (reasons.get(v.reason.slice(0, 30)) ?? 0) + 1);
  md.push(...[...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([r, n]) => `- ${r}（${n}）`), "");
  fs.writeFileSync(path.join(outDir, "followup-ab.md"), md.join("\n"));
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
