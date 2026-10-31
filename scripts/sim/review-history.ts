/**
 * Review a Page's whole Messenger history (from fetch-history.ts) against the
 * current knowledge base: what customers ask, what the owner answered that
 * the knowledge base lacks, where his old answers conflict with what it says
 * now (for him to choose), and how he writes. Message Batches API only.
 *
 *   cd openreply; npx tsx scripts/sim/review-history.ts <history-dir> <knowledge-base.txt> <pageId>
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [dir, kbPath, pageId] = process.argv.slice(2);
if (!dir || !kbPath || !pageId) throw new Error("usage: review-history.ts <history-dir> <kb.txt> <pageId>");
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
const BOT_SINCE = Date.parse("2026-10-28T00:00:00+08:00");
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
    await new Promise((r) => setTimeout(r, 30_000));
  }
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type !== "succeeded") continue;
    const m = r.result.message;
    usage.input += m.usage.input_tokens;
    usage.output += m.usage.output_tokens;
    usage.cacheRead += m.usage.cache_read_input_tokens ?? 0;
    usage.calls += 1;
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
      else failed.push(r);
    }
    if (failed.length) log(`  ${failed.length} unparseable, retrying`);
    pending = failed;
  }
  return out;
}

// ─── 1. transcripts ───────────────────────────────────────────────────────
interface Msg { message?: string; created_time: string; from?: { id: string; name?: string }; attachments?: { data: { mime_type?: string; name?: string }[] } }
interface Conv { id: string; updated_time: string; participants?: { data: { id: string; name?: string }[] }; messages?: { data: Msg[] } }
interface Thread { id: string; name: string; start: string; end: string; lines: string[]; customerLines: number; ownerLines: number; autoLines: number }

const tpe = (iso: string) => new Date(Date.parse(iso) + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

function buildThreads(convs: Conv[]): Thread[] {
  // Page-side texts of some length that recur across many threads are
  // automation (ManyChat, Meta's ad replies), not the owner typing.
  const seenIn = new Map<string, Set<string>>();
  const norm = (t: string) => t.replace(/\s+/g, "").slice(0, 60);
  for (const c of convs) {
    for (const m of c.messages?.data ?? []) {
      if (m.from?.id !== pageId || !m.message || m.message.length < 25) continue;
      const k = norm(m.message);
      seenIn.set(k, (seenIn.get(k) ?? new Set()).add(c.id));
    }
  }
  const automated = (t: string) => t.length >= 25 && (seenIn.get(norm(t))?.size ?? 0) >= 4;

  const threads: Thread[] = [];
  for (const c of convs) {
    const msgs = [...(c.messages?.data ?? [])].sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time)).slice(-80);
    if (!msgs.length) continue;
    const customer = c.participants?.data.find((p) => p.id !== pageId);
    let customerLines = 0, ownerLines = 0, autoLines = 0;
    const lines = msgs.map((m) => {
      const att = m.attachments?.data?.length ? `(傳了${m.attachments.data.map((a) => (a.mime_type?.startsWith("image") ? "照片" : a.mime_type?.startsWith("video") ? "影片" : a.mime_type?.startsWith("audio") ? "語音" : "檔案")).join("、")})` : "";
      const text = `${m.message ?? ""} ${att}`.trim().replace(/\n/g, " ⏎ ");
      let who: string;
      if (m.from?.id !== pageId) { who = "客人"; customerLines += 1; }
      else if (automated(m.message ?? "")) { who = "自動訊息"; autoLines += 1; }
      else if (Date.parse(m.created_time) >= BOT_SINCE) { who = "粉專（機器人時期，可能是師傅也可能是機器人）"; }
      else { who = "師傅"; ownerLines += 1; }
      return `[${tpe(m.created_time)}] ${who}：${text}`;
    });
    if (!customerLines) continue;
    threads.push({ id: c.id, name: customer?.name ?? "（未知）", start: tpe(msgs[0].created_time).slice(0, 10), end: tpe(msgs[msgs.length - 1].created_time).slice(0, 10), lines, customerLines, ownerLines, autoLines });
  }
  return threads;
}

// ─── 2. per-thread review ─────────────────────────────────────────────────
interface OwnerAnswer { question: string; ownerSaid: string; date: string; kbStatus: "知識庫沒有" | "知識庫一致" | "和知識庫衝突" | "不適合放知識庫"; kbSays: string; suggestedKbLine: string }
interface Review { topics: string[]; ownerAnswers: OwnerAnswer[]; voiceLines: string[]; unanswered: string[]; outcome: string; summary: string }

const SYSTEM: Block[] = [
  { type: "text", text: "You audit years of a Taiwanese bathroom-renovation shop's Messenger threads against the knowledge base its new bot uses. Be concrete, quote the owner exactly, and never invent prices or facts. Output JSON only.", cache_control: { type: "ephemeral" } },
  { type: "text", text: `機器人現在的知識庫（判斷「知識庫沒有／一致／衝突」的依據）：\n\n${KB}`, cache_control: { type: "ephemeral" } },
];

function reviewRequest(t: Thread, i: number): Req {
  return {
    id: `t-${i}`,
    system: SYSTEM,
    maxTokens: 3000,
    user: `下面是一段真實對話（客人 ${t.name}，${t.start}～${t.end}）。「師傅」是老闆本人打的；「自動訊息」是當時的自動回覆工具發的，不算師傅說的；「粉專（機器人時期）」可能是師傅也可能是機器人，只有明顯是人在講話才當成師傅。

請整理：
1. topics：客人這段問了哪些主題，用 2～6 個字的短語（例如 拉門價格、乾濕分離、服務地區、工期、保固、門檻、浴櫃、約丈量、傳照片、發票、付款方式），最多 6 個
2. ownerAnswers：師傅親口回答的每一件「事實或做法」（價格、規格、流程、地區、工期、保固、能不能做）。每件附：
   - question：客人問什麼
   - ownerSaid：師傅原話（可修錯字，不能改意思）
   - date：那句的日期
   - kbStatus：對照上面的知識庫，是「知識庫沒有」「知識庫一致」「和知識庫衝突」還是「不適合放知識庫」（例如某一位客人的報價、地址、個人安排）
   - kbSays：知識庫現在怎麼寫（沒有就空字串）
   - suggestedKbLine：如果值得加進知識庫，寫成一行繁體中文，不要用「。」；不值得就空字串
   師傅只是回「好」「收到」「可以」這種不算
3. voiceLines：師傅講得最有他個人風格、值得機器人學的句子，最多 3 句（要原話）
4. unanswered：客人問了但沒有人回答的問題
5. outcome：這段最後怎麼了，用一個詞：約了丈量／成交／沒服務地區／只問價格就走／沒下文／其他
6. summary：一句話

對話：
${t.lines.join("\n")}

只輸出 JSON：{"topics":["..."],"ownerAnswers":[{"question":"...","ownerSaid":"...","date":"YYYY-MM-DD","kbStatus":"...","kbSays":"...","suggestedKbLine":"..."}],"voiceLines":["..."],"unanswered":["..."],"outcome":"...","summary":"..."}`,
  };
}

// ─── 3. merging ───────────────────────────────────────────────────────────
interface Merged { kbAdditions: { line: string; evidence: string[]; count: number }[]; conflicts: { topic: string; ownerSaidThen: string; when: string; kbNow: string; evidence: string[] }[]; }

function mergeRequest(id: string, answers: (OwnerAnswer & { who: string })[]): Req {
  return {
    id,
    system: SYSTEM,
    maxTokens: 8000,
    user: `下面是從很多段對話整理出來的師傅回答。請合併成兩份清單：
1. kbAdditions：kbStatus 是「知識庫沒有」的，把講同一件事的合併成一條可以直接加進知識庫的句子（繁體中文，不要用「。」），count 是有幾段對話提到，evidence 列 1～3 個「客人名 日期：師傅原話」。知識庫已經有、或只是某一位客人的個別報價和安排，不要列
2. conflicts：kbStatus 是「和知識庫衝突」的，或是師傅在不同時間講法不一樣的（例如價格區間、片數規則、地區有沒有跑），每條寫清楚：topic（哪件事）、ownerSaidThen（師傅當時怎麼說，附日期）、when（日期範圍）、kbNow（知識庫現在怎麼寫，或「知識庫沒寫」）、evidence（客人名 日期：原話，1～3 個）。這份是要給老闆選版本的，寧可多列不要漏

師傅的回答（${answers.length} 條）：
${answers.map((a) => `- [${a.kbStatus}] ${a.who} ${a.date}｜客人問：${a.question}｜師傅說：${a.ownerSaid}${a.kbSays ? `｜知識庫：${a.kbSays}` : ""}`).join("\n")}

只輸出 JSON：{"kbAdditions":[{"line":"...","count":數字,"evidence":["..."]}],"conflicts":[{"topic":"...","ownerSaidThen":"...","when":"...","kbNow":"...","evidence":["..."]}]}`,
  };
}

async function main() {
  const convs = JSON.parse(fs.readFileSync(path.join(dir, "conversations.json"), "utf8")) as Conv[];
  const threads = buildThreads(convs);
  log(`${convs.length} conversations → ${threads.length} threads with customer messages; owner lines ${threads.reduce((s, t) => s + t.ownerLines, 0)}, automated ${threads.reduce((s, t) => s + t.autoLines, 0)}`);
  fs.writeFileSync(path.join(dir, "threads.json"), JSON.stringify(threads));

  const reviewFile = path.join(dir, "reviews.json");
  let reviews: (Thread & { review: Review | null })[];
  if (fs.existsSync(reviewFile)) {
    reviews = JSON.parse(fs.readFileSync(reviewFile, "utf8"));
    log(`reusing ${reviews.length} reviews`);
  } else {
    const res = await runBatchParsed(threads.map(reviewRequest), (t) => {
      const r = parseJson<Review>(t);
      return r && Array.isArray(r.topics) && Array.isArray(r.ownerAnswers) ? r : null;
    });
    reviews = threads.map((t, i) => ({ ...t, review: res.get(`t-${i}`) ?? null }));
    fs.writeFileSync(reviewFile, JSON.stringify(reviews));
  }

  // Merge owner answers in chunks, then merge the chunk results once more.
  const answers = reviews.flatMap((r) => (r.review?.ownerAnswers ?? []).filter((a) => a.kbStatus === "知識庫沒有" || a.kbStatus === "和知識庫衝突").map((a) => ({ ...a, who: r.name })));
  log(`${answers.length} owner answers to merge`);
  const CHUNK = 120;
  const chunkReqs = Array.from({ length: Math.ceil(answers.length / CHUNK) }, (_, k) => mergeRequest(`m-${k}`, answers.slice(k * CHUNK, (k + 1) * CHUNK)));
  const merged = await runBatchParsed(chunkReqs, (t) => {
    const m = parseJson<Merged>(t);
    return m && Array.isArray(m.kbAdditions) && Array.isArray(m.conflicts) ? m : null;
  });
  let kbAdditions = [...merged.values()].flatMap((m) => m.kbAdditions);
  let conflicts = [...merged.values()].flatMap((m) => m.conflicts);
  if (merged.size > 1) {
    const finalReq: Req = {
      id: "final",
      system: SYSTEM,
      maxTokens: 12000,
      user: `下面是分批合併後的結果，請再合併一次：講同一件事的併成一條（count 相加、evidence 合併最多 3 個），衝突的也併同一個 topic。輸出格式不變，依 count 和重要性排序。

kbAdditions：
${JSON.stringify(kbAdditions)}

conflicts：
${JSON.stringify(conflicts)}

只輸出 JSON：{"kbAdditions":[{"line":"...","count":數字,"evidence":["..."]}],"conflicts":[{"topic":"...","ownerSaidThen":"...","when":"...","kbNow":"...","evidence":["..."]}]}`,
    };
    const fin = await runBatchParsed([finalReq], (t) => {
      const m = parseJson<Merged>(t);
      return m && Array.isArray(m.kbAdditions) && Array.isArray(m.conflicts) ? m : null;
    });
    const f = fin.get("final");
    if (f) { kbAdditions = f.kbAdditions; conflicts = f.conflicts; }
  }

  // Topics and outcomes: plain counting.
  const topicCount = new Map<string, number>();
  const outcomeCount = new Map<string, number>();
  const unanswered: string[] = [];
  const voice: { line: string; who: string; when: string }[] = [];
  for (const r of reviews) {
    for (const t of r.review?.topics ?? []) topicCount.set(t.trim(), (topicCount.get(t.trim()) ?? 0) + 1);
    if (r.review?.outcome) outcomeCount.set(r.review.outcome, (outcomeCount.get(r.review.outcome) ?? 0) + 1);
    unanswered.push(...(r.review?.unanswered ?? []).map((u) => `${r.name} ${r.start}：${u}`));
    voice.push(...(r.review?.voiceLines ?? []).map((line) => ({ line, who: r.name, when: r.start })));
  }
  // Group the raw topic strings into a short list of themes.
  const topicReq: Req = {
    id: "topics",
    system: [{ type: "text", text: "You group customer-question topics. Output JSON only." }],
    maxTokens: 6000,
    user: `下面是客人問過的主題和次數，請歸成 20～35 個大類，每類附合計次數和它包含的原始主題（最多 8 個），依次數排序。繁體中文。
${[...topicCount].sort((a, b) => b[1] - a[1]).slice(0, 600).map(([t, n]) => `${t} ${n}`).join("\n")}
只輸出 JSON：{"themes":[{"name":"...","count":數字,"includes":["..."]}]}`,
  };
  const themes = (await runBatchParsed([topicReq], (t) => parseJson<{ themes: { name: string; count: number; includes: string[] }[] }>(t))).get("topics")?.themes ?? [];

  fs.writeFileSync(path.join(dir, "history-review.json"), JSON.stringify({ usage, threads: reviews.length, kbAdditions, conflicts, themes, outcomes: [...outcomeCount], unanswered, voice }, null, 2));
  log("done", JSON.stringify(usage));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
