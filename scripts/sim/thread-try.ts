// Replay a scripted customer thread through the production prompt + rules (Batch API, promo credit).
// usage (from openreply dir): npx tsx <this> <kb.txt> "客人1" "客人2" ...
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";
import { FAQ_SYSTEM_PROMPT, buildFaqContextBlock, buildFaqUserPrompt } from "@/lib/ai/prompts";
import { applyReplyRules, decideFaqReply, preReplyRule, HISTORY_TURNS } from "@/lib/ai/faq";
dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });
const [kbPath, ...customer] = process.argv.slice(2);
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const SETTINGS = { knowledgeBase: KB, handoffMessage: "這個我請師傅回覆您\n稍等一下喔 🙏", tone: "friendly", maxReplyChars: 300, maxLineWidth: 16 } as any;
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });
type T = { role: "customer" | "bot"; text: string; kind?: string };
const turns: T[] = [];
const hist = () => turns.map((t) => ({ direction: t.role === "bot" ? "OUT_AI" : "IN", text: t.text })) as any;
const waiting = () => turns.some((t) => t.role === "bot" && t.kind === "handoff");
async function ask(q: string): Promise<string> {
  const history = turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role === "customer" ? ("user" as const) : ("assistant" as const), text: t.text }));
  const batch = await client.messages.batches.create({
    requests: [{ custom_id: "t", params: { model: MODEL, max_tokens: 2000, output_config: { effort: "low" } as any,
      system: [{ type: "text", text: FAQ_SYSTEM_PROMPT }, { type: "text", text: buildFaqContextBlock(KB) }],
      messages: [{ role: "user", content: buildFaqUserPrompt({ question: q, history, tone: "friendly", maxChars: 300, lineWidth: 16 }) }] } }],
  });
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
  }
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type === "succeeded") return r.result.message.content.map((c: any) => c.text ?? "").join("");
    throw new Error(JSON.stringify(r.result));
  }
  throw new Error("no result");
}
(async () => {
  for (const q of customer) {
    const earlier = hist();
    turns.push({ role: "customer", text: q });
    console.log("客人：" + q);
    const pre = preReplyRule(q, KB, earlier, waiting());
    let out: any;
    if (pre?.kind === "silent") { console.log("機器人：[沉默]"); turns.push({ role: "bot", text: "[沉默]", kind: "silent" }); continue; }
    if (pre?.kind === "result") out = pre.result.result;
    else out = parseJson(await ask(q));
    const decision = applyReplyRules(decideFaqReply(out, SETTINGS), { question: q, earlier, settings: SETTINGS } as any);
    console.log(`機器人(${decision.kind}${out?.fixedReply ? ", 固定:" + out.fixedReply : ""})：` + decision.text.replace(/\n/g, " / "));
    turns.push({ role: "bot", text: decision.text, kind: decision.kind });
  }
})().catch((e) => { console.error(e); process.exit(1); });
