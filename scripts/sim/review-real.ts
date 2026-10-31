/**
 * Review every real conversation of one account: where the bot answered
 * poorly, what the owner had to answer himself, and what the knowledge base
 * is missing. Runs through the Message Batches API (promotional credit).
 *
 *   cd openreply; npx tsx scripts/sim/review-real.ts <accountId> <knowledge-base.txt> <out-dir>
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";
import { prisma } from "@/lib/db/client";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [accountId, kbPath, outDir] = process.argv.slice(2);
if (!accountId || !kbPath || !outDir) throw new Error("usage: review-real.ts <accountId> <kb.txt> <out-dir>");
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
fs.mkdirSync(outDir, { recursive: true });
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });

type Block = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
interface Req { id: string; system: Block[]; user: string; maxTokens: number }
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function runBatch(reqs: Req[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!reqs.length) return out;
  const batch = await client.messages.batches.create({
    requests: reqs.map((r) => ({
      custom_id: r.id,
      params: {
        model: MODEL,
        max_tokens: r.maxTokens,
        output_config: { effort: "low" },
        system: r.system,
        messages: [{ role: "user", content: r.user }],
      },
    })),
  });
  log(`batch ${batch.id}: ${reqs.length} requests`);
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type === "succeeded") {
      out.set(r.custom_id, r.result.message.content.map((c) => ("text" in c ? c.text : "")).join(""));
      fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
      fs.writeFileSync(path.join(outDir, "raw", `${r.custom_id}.txt`), out.get(r.custom_id) ?? "");
    }
    else log(`  ${r.custom_id}: ${r.result.type}`);
  }
  return out;
}


/** Run a batch, then re-send every request whose output is empty or unparseable, up to two more times. */
async function runBatchParsed<T>(reqs: Req[], parse: (text: string) => T | null): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let pending = reqs;
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const res = await runBatch(pending);
    const failed: Req[] = [];
    for (const r of pending) {
      const parsed = parse(res.get(r.id) ?? "");
      if (parsed) out.set(r.id, parsed);
      else failed.push(r);
    }
    if (failed.length) log(`  ${failed.length} unparseable, retrying`);
    pending = failed;
  }
  return out;
}

interface Review {
  botProblems: { turn: number; severity: "high" | "medium" | "low"; note: string }[];
  ownerAnswers: { question: string; ownerSaid: string; suggestedKbLine: string }[];
  unanswered: string[];
  summary: string;
}

async function main() {
  const conversations = await prisma.conversation.findMany({
    where: { instagramAccountId: accountId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      senderName: true,
      status: true,
      messages: { orderBy: { createdAt: "asc" }, select: { direction: true, text: true, createdAt: true, aiMeta: true } },
    },
  });
  await prisma.$disconnect();
  log(`${conversations.length} conversations`);

  const who = (d: string, meta: unknown) => {
    if (d === "IN") return "客人";
    if (d === "OUT_HUMAN") return "師傅本人";
    const m = meta as { automation?: boolean; nudge?: string } | null;
    if (m?.automation) return "Meta自動回覆";
    if (m?.nudge) return "機器人（追蹤訊息）";
    return "機器人";
  };
  const transcripts = conversations.map((c) => ({
    id: c.id,
    name: c.senderName ?? "（未知）",
    status: c.status,
    text: c.messages
      .map((m, i) => `${i + 1}. [${new Date(m.createdAt.getTime() + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ")}] ${who(m.direction, m.aiMeta)}：${m.text.replace(/\n/g, " ⏎ ")}`)
      .join("\n"),
  }));

  const system: Block[] = [
    { type: "text", text: "You audit a bathroom-renovation shop's Messenger bot against its knowledge base and the owner's own replies. Be concrete. Output JSON only.", cache_control: { type: "ephemeral" } },
    { type: "text", text: `知識庫（機器人唯一的資料來源）：\n\n${KB}`, cache_control: { type: "ephemeral" } },
  ];
  const reqs: Req[] = transcripts.map((t, i) => ({
    id: `conv-${i}`,
    system,
    maxTokens: 4000,
    user: `下面是一段真實對話（客人 ${t.name}）。請做三件事：
1. botProblems：機器人哪幾則回得不好（捏造、答非所問、重複、該轉師傅沒轉、不該轉卻轉、語氣不像店家、用了「。」、一行太長），每則一句話
2. ownerAnswers：師傅本人親自回答的內容裡，哪些是知識庫沒有或寫得不夠清楚的，請用師傅的原話整理成可以直接加進知識庫的句子（suggestedKbLine，繁體中文，不要用「。」）
3. unanswered：客人問了但沒有人好好回答的問題

對話：
${t.text}

只輸出 JSON：{"botProblems":[{"turn":編號,"severity":"high|medium|low","note":"..."}],"ownerAnswers":[{"question":"客人問什麼","ownerSaid":"師傅原話","suggestedKbLine":"建議加進知識庫的句子"}],"unanswered":["..."],"summary":"一句話總評"}`,
  }));
  const res = await runBatchParsed(reqs, (t) => {
    const r = parseJson<Review>(t);
    return r && Array.isArray(r.botProblems) && typeof r.summary === "string" ? r : null;
  });
  const reviews = transcripts.map((t, i) => ({ ...t, review: res.get(`conv-${i}`) ?? null }));

  const digest = reviews
    .map((r) => `【${r.name}】${r.review?.summary ?? ""}\n機器人問題：${JSON.stringify(r.review?.botProblems ?? [])}\n師傅補充：${JSON.stringify(r.review?.ownerAnswers ?? [])}\n沒人回答：${JSON.stringify(r.review?.unanswered ?? [])}`)
    .join("\n\n");
  type Aggregate = { kbAdditions: { line: string; from: string }[]; botFixes: { severity: string; fix: string }[]; patterns: string[]; goodSigns: string[] };
  const agg = await runBatchParsed<Aggregate>([
    {
      id: "aggregate",
      system,
      maxTokens: 6000,
      user: `以下是 ${reviews.length} 段真實對話的逐段審查結果。請整合成給店家老闆看的建議，繁體中文，不要用「。」：
1. kbAdditions：建議加進知識庫的句子，去除重複，依重要性排序，每條附上是哪位客人的對話來的
2. botFixes：機器人回覆規則該改的地方（不是知識庫內容，而是行為），依嚴重程度排序
3. patterns：客人常問但知識庫沒涵蓋的主題
4. goodSigns：機器人做得好的地方（簡短）

審查結果：
${digest}

只輸出 JSON：{"kbAdditions":[{"line":"...","from":"客人名"}],"botFixes":[{"severity":"high|medium|low","fix":"..."}],"patterns":["..."],"goodSigns":["..."]}`,
    },
  ], (t) => {
    const a = parseJson<Aggregate>(t);
    return a && Array.isArray(a.kbAdditions) && Array.isArray(a.botFixes) ? a : null;
  });
  const aggregate = agg.get("aggregate") ?? null;
  fs.writeFileSync(path.join(outDir, "real-review.json"), JSON.stringify({ reviews, aggregate }, null, 2));

  const md: string[] = [`# 御本粉專 真實對話審查（${new Date().toISOString().slice(0, 10)}）`, "", `共 ${reviews.length} 段對話，由 AI 依知識庫逐段審查，再整合成建議。審查者是 AI，內容請你自己判斷再採用`, ""];
  if (aggregate) {
    md.push("## 一、建議加進知識庫的句子", "", ...aggregate.kbAdditions.map((k, i) => `${i + 1}. ${k.line}　（來源：${k.from}）`), "");
    md.push("## 二、機器人行為該改的地方", "", ...aggregate.botFixes.map((f) => `- **${f.severity}**：${f.fix}`), "");
    md.push("## 三、客人常問但知識庫沒涵蓋的主題", "", ...aggregate.patterns.map((p) => `- ${p}`), "");
    md.push("## 四、做得好的地方", "", ...aggregate.goodSigns.map((g) => `- ${g}`), "");
  }
  md.push("## 五、逐段審查", "");
  for (const r of reviews) {
    md.push(`### ${r.name}（${r.status}）`, "", r.review?.summary ?? "（審查失敗）", "");
    for (const p of r.review?.botProblems ?? []) md.push(`- 第 ${p.turn} 則 **${p.severity}**：${p.note}`);
    for (const o of r.review?.ownerAnswers ?? []) md.push(`- 師傅補充：「${o.ownerSaid}」→ 建議知識庫：${o.suggestedKbLine}`);
    for (const u of r.review?.unanswered ?? []) md.push(`- 沒人回答：${u}`);
    md.push("", "<details><summary>對話全文</summary>", "", "```", r.text, "```", "", "</details>", "");
  }
  fs.writeFileSync(path.join(outDir, "real-review.md"), md.join("\n"));
  log("done");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
