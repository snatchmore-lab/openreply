/**
 * Second half of review-history.ts, runnable on its own from reviews.json:
 * merge the owner's answers into knowledge-base additions and conflicts in
 * small steps (one big merge lost almost everything), and group topics.
 *
 *   cd openreply; npx tsx scripts/sim/aggregate-history.ts <history-dir> <knowledge-base.txt>
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [dir, kbPath] = process.argv.slice(2);
if (!dir || !kbPath) throw new Error("usage: aggregate-history.ts <history-dir> <kb.txt>");
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const usage = { input: 0, output: 0, cacheRead: 0, calls: 0 };

type Block = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
interface Req { id: string; system: Block[]; user: string; maxTokens: number }

async function runBatch(reqs: Req[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!reqs.length) return out;
  const batch = await client.messages.batches.create({
    requests: reqs.map((r) => ({
      custom_id: r.id,
      params: { model: MODEL, max_tokens: r.maxTokens, output_config: { effort: "low" }, system: r.system, messages: [{ role: "user", content: r.user }] },
    })),
  });
  log(`batch ${batch.id}: ${reqs.length} requests`);
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 20_000));
  }
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type !== "succeeded") continue;
    const m = r.result.message;
    usage.input += m.usage.input_tokens;
    usage.output += m.usage.output_tokens;
    usage.cacheRead += m.usage.cache_read_input_tokens ?? 0;
    usage.calls += 1;
    if (m.stop_reason === "max_tokens") log(`  ${r.custom_id}: cut at max_tokens`);
    out.set(r.custom_id, m.content.map((c) => ("text" in c ? c.text : "")).join(""));
  }
  return out;
}

async function runBatchParsed<T>(reqs: Req[], parse: (text: string) => T | null): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let pending = reqs;
  for (let pass = 0; pass < 3 && pending.length; pass++) {
    const res = await runBatch(pending);
    const failed: Req[] = [];
    for (const r of pending) {
      const parsed = parse(res.get(r.id) ?? "");
      if (parsed) out.set(r.id, parsed);
      else failed.push({ ...r, maxTokens: Math.min(32000, r.maxTokens * 2) });
    }
    if (failed.length) log(`  ${failed.length} unparseable, retrying with more room`);
    pending = failed;
  }
  return out;
}

interface OwnerAnswer { question: string; ownerSaid: string; date: string; kbStatus: string; kbSays: string; suggestedKbLine: string }
interface Review { topics: string[]; ownerAnswers: OwnerAnswer[]; voiceLines: string[]; unanswered: string[]; outcome: string; summary: string }
interface Thread { id: string; name: string; start: string; end: string; lines: string[]; review: Review | null }
interface Merged { kbAdditions: { line: string; count: number; evidence: string[] }[]; conflicts: { topic: string; ownerSaidThen: string; when: string; kbNow: string; evidence: string[] }[] }

const SYSTEM: Block[] = [
  { type: "text", text: "You consolidate a Taiwanese bathroom-renovation shop owner's past Messenger answers against the knowledge base his bot uses now. Quote him exactly, never invent. Output JSON only, compact.", cache_control: { type: "ephemeral" } },
  { type: "text", text: `機器人現在的知識庫：\n\n${KB}`, cache_control: { type: "ephemeral" } },
];
const FORMAT = `只輸出 JSON：{"kbAdditions":[{"line":"...","count":數字,"evidence":["客人名 日期：原話"]}],"conflicts":[{"topic":"...","ownerSaidThen":"...","when":"...","kbNow":"...","evidence":["..."]}]}`;
const isMerged = (t: string) => {
  const m = parseJson<Merged>(t);
  return m && Array.isArray(m.kbAdditions) && Array.isArray(m.conflicts) ? m : null;
};

function mergeAnswers(id: string, answers: (OwnerAnswer & { who: string })[]): Req {
  return {
    id,
    system: SYSTEM,
    maxTokens: 8000,
    user: `下面是從很多段對話整理出來的師傅回答。請合併成兩份清單：
1. kbAdditions：kbStatus 是「知識庫沒有」的，把講同一件事的合併成一條可以直接加進知識庫的句子（繁體中文，不要用「。」），count 是有幾段對話提到，evidence 列 1～3 個「客人名 日期：師傅原話」。知識庫已經有的、只是某一位客人的個別報價或安排的，不要列
2. conflicts：kbStatus 是「和知識庫衝突」的，或師傅在不同時間講法不一樣的（價格、片數規則、地區有沒有跑、保固、工期），每條：topic、ownerSaidThen（師傅當時怎麼說，附日期）、when（日期範圍）、kbNow（知識庫現在怎麼寫，或「知識庫沒寫」）、evidence 1～3 個。這份是給老闆選版本的，寧可多列不要漏

師傅的回答（${answers.length} 條）：
${answers.map((a) => `- [${a.kbStatus}] ${a.who} ${a.date}｜問：${a.question}｜師傅：${a.ownerSaid}${a.kbSays ? `｜知識庫：${a.kbSays}` : ""}`).join("\n")}

${FORMAT}`,
  };
}

function mergeMerged(id: string, parts: Merged[]): Req {
  const adds = parts.flatMap((p) => p.kbAdditions);
  const confs = parts.flatMap((p) => p.conflicts);
  return {
    id,
    system: SYSTEM,
    maxTokens: 12000,
    user: `下面是分批合併後的結果，請再合併一次：講同一件事的併成一條（count 相加、evidence 合併後最多留 3 個），衝突的併同一個 topic（ownerSaidThen 把不同時間的說法都保留，用「；」分開）。不要漏掉任何一件事，只做合併和去重。依 count 排序

kbAdditions（${adds.length} 條）：
${adds.map((a) => `- ${a.line}｜count ${a.count}｜${(a.evidence ?? []).slice(0, 2).join("／")}`).join("\n")}

conflicts（${confs.length} 條）：
${confs.map((c) => `- ${c.topic}｜當時：${c.ownerSaidThen}｜${c.when}｜知識庫：${c.kbNow}｜${(c.evidence ?? []).slice(0, 2).join("／")}`).join("\n")}

${FORMAT}`,
  };
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, k) => xs.slice(k * n, (k + 1) * n));

async function main() {
  const reviews = JSON.parse(fs.readFileSync(path.join(dir, "reviews.json"), "utf8")) as Thread[];
  const answers = reviews.flatMap((r) => (r.review?.ownerAnswers ?? []).map((a) => ({ ...a, who: r.name, thread: r.id })));
  const byStatus = answers.reduce<Record<string, number>>((m, a) => ({ ...m, [a.kbStatus]: (m[a.kbStatus] ?? 0) + 1 }), {});
  log(`${reviews.length} threads, ${answers.length} owner answers`, JSON.stringify(byStatus));
  fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(answers));

  const toMerge = answers.filter((a) => a.kbStatus === "知識庫沒有" || a.kbStatus === "和知識庫衝突");
  // Level 1: 100 answers per request. Level 2+: 6 results per request, until one is left.
  let level = await runBatchParsed(chunk(toMerge, 100).map((c, k) => mergeAnswers(`l1-${k}`, c)), isMerged);
  let parts = [...level.values()];
  fs.writeFileSync(path.join(dir, "merge-l1.json"), JSON.stringify(parts));
  log(`level 1: ${parts.length} parts, ${parts.reduce((s, p) => s + p.kbAdditions.length, 0)} additions, ${parts.reduce((s, p) => s + p.conflicts.length, 0)} conflicts`);
  for (let depth = 2; parts.length > 1 && depth < 6; depth++) {
    level = await runBatchParsed(chunk(parts, 6).map((c, k) => mergeMerged(`l${depth}-${k}`, c)), isMerged);
    const next = [...level.values()];
    // A group whose merge failed keeps its unmerged parts rather than losing them.
    const failedGroups = chunk(parts, 6).filter((_, k) => !level.has(`l${depth}-${k}`)).flat();
    parts = [...next, ...failedGroups];
    fs.writeFileSync(path.join(dir, `merge-l${depth}.json`), JSON.stringify(parts));
    log(`level ${depth}: ${parts.length} parts, ${parts.reduce((s, p) => s + p.kbAdditions.length, 0)} additions, ${parts.reduce((s, p) => s + p.conflicts.length, 0)} conflicts`);
  }
  const final: Merged = parts.length === 1 ? parts[0] : { kbAdditions: parts.flatMap((p) => p.kbAdditions), conflicts: parts.flatMap((p) => p.conflicts) };

  // Topics → themes, outcomes, unanswered, voice lines.
  const topicCount = new Map<string, number>();
  const outcomeCount = new Map<string, number>();
  for (const r of reviews) {
    for (const t of r.review?.topics ?? []) topicCount.set(t.trim(), (topicCount.get(t.trim()) ?? 0) + 1);
    if (r.review?.outcome) outcomeCount.set(r.review.outcome, (outcomeCount.get(r.review.outcome) ?? 0) + 1);
  }
  const topicReq: Req = {
    id: "topics",
    system: [{ type: "text", text: "You group customer-question topics. Output JSON only, compact." }],
    maxTokens: 8000,
    user: `下面是客人問過的主題和次數，請歸成 20～30 個大類，每類附合計次數和它包含的原始主題（最多 6 個），依次數排序。繁體中文
${[...topicCount].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([t, n]) => `${t} ${n}`).join("\n")}
只輸出 JSON：{"themes":[{"name":"...","count":數字,"includes":["..."]}]}`,
  };
  const themes = (await runBatchParsed([topicReq], (t) => {
    const p = parseJson<{ themes: { name: string; count: number; includes: string[] }[] }>(t);
    return p && Array.isArray(p.themes) && p.themes.length ? p : null;
  })).get("topics")?.themes ?? [];

  const out = {
    usage,
    threads: reviews.length,
    answersByStatus: byStatus,
    kbAdditions: final.kbAdditions,
    conflicts: final.conflicts,
    themes,
    outcomes: [...outcomeCount].sort((a, b) => b[1] - a[1]),
    unanswered: reviews.flatMap((r) => (r.review?.unanswered ?? []).map((u) => ({ who: r.name, when: r.start, question: u }))),
    voice: reviews.flatMap((r) => (r.review?.voiceLines ?? []).map((line) => ({ line, who: r.name, when: r.start }))),
    perThread: reviews.map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end, outcome: r.review?.outcome ?? "", summary: r.review?.summary ?? "", topics: r.review?.topics ?? [], answers: (r.review?.ownerAnswers ?? []).length, transcript: r.lines.join("\n") })),
  };
  fs.writeFileSync(path.join(dir, "history-review.json"), JSON.stringify(out, null, 2));
  log("done", JSON.stringify(usage), `additions ${final.kbAdditions.length}, conflicts ${final.conflicts.length}, themes ${themes.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
