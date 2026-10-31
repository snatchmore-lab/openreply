/**
 * Multi-turn conversation simulation for the 御本衛浴 FAQ bot.
 *
 * Runs through the Message Batches API so it draws on the promotional
 * credit (which covers Batch API but not plain Messages) and costs half.
 * Nothing touches the live database or Messenger: the bot side is the same
 * prompt and decision code as production, driven locally.
 *
 *   cd openreply; npx tsx scripts/sim/run-sim.ts <knowledge-base.txt> <out-dir> [count]
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";
import { FAQ_SYSTEM_PROMPT, buildFaqContextBlock, buildFaqUserPrompt } from "@/lib/ai/prompts";
import { applyReplyRules, decideFaqReply, knowledgeBaseFixedReplies, preReplyRule, HISTORY_TURNS } from "@/lib/ai/faq";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [kbPath, outDir, countArg] = process.argv.slice(2);
if (!kbPath || !outDir) throw new Error("usage: run-sim.ts <kb.txt> <out-dir> [count]");
const COUNT = Number(countArg ?? 100);
const MAX_BOT_TURNS = 4;
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
const SETTINGS = {
  knowledgeBase: KB,
  handoffMessage: "這個我請師傅回覆您\n稍等一下喔 🙏",
  tone: "friendly",
  maxReplyChars: 300,
  maxLineWidth: 16,
};
fs.mkdirSync(outDir, { recursive: true });
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });
const usage = { input: 0, output: 0, cacheRead: 0, calls: 0 };

type Block = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
interface Req { id: string; system: Block[]; user: string; maxTokens: number }

function log(...a: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

async function runBatch(reqs: Req[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (reqs.length === 0) return out;
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
  const started = Date.now();
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    if (Date.now() - started > 2 * 60 * 60 * 1000) throw new Error("batch timed out");
    await new Promise((r) => setTimeout(r, 20_000));
  }
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type !== "succeeded") {
      log(`  ${r.custom_id}: ${r.result.type}`);
      continue;
    }
    const m = r.result.message;
    usage.input += m.usage.input_tokens;
    usage.output += m.usage.output_tokens;
    usage.cacheRead += m.usage.cache_read_input_tokens ?? 0;
    usage.calls += 1;
    out.set(r.custom_id, m.content.map((c) => ("text" in c ? c.text : "")).join(""));
    fs.mkdirSync(path.join(outDir, "raw"), { recursive: true });
    fs.writeFileSync(path.join(outDir, "raw", `${r.custom_id}.txt`), out.get(r.custom_id) ?? "");
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

// ─── 1. personas ──────────────────────────────────────────────────────────
interface Persona { id: number; area: string; need: string; style: string; opener: string; goal: string }

// SIM_THEMES (a JSON array) replaces the list for a run that targets weak
// spots; SIM_FOCUS=1 makes nine in ten customers follow the theme.
const THEMES: string[] = process.env.SIM_THEMES ? (JSON.parse(process.env.SIM_THEMES) as string[]) : [
  "淋浴拉門的款式、尺寸、片數、玻璃或 PS 板",
  "浴缸拆掉改乾濕分離、防水、地磚",
  "整間浴室翻新、預算和工期",
  "衛浴設備：馬桶、臉盆、龍頭、浴櫃、鏡櫃",
  "不服務的地區，會追問為什麼、以後會不會開放、能不能推薦別家",
  "偏遠鄉鎮或一開始不說地點，地點講得很模糊",
  "長輩客人：錯字、注音、簡體字、句子很長",
  "急著要價格、殺價、比價、嫌貴",
  "一開始就傳照片、要約時間、要留電話或 LINE",
  "閒聊、懷疑是不是機器人、問知識庫沒有的服務（廚房、陽台、漏水、水電）",
];

const personaPrompt = (count: number, theme: string, part: string) => `你要設計 ${count} 位會在 Facebook 私訊「御本衛浴」（苗栗到嘉義的浴室整修、淋浴拉門、衛浴設備店家）的台灣客人，用來測試自動回覆機器人。

這是${part}，請讓這批客人側重：${theme}（${process.env.SIM_FOCUS ? "約九成客人跟這個主題有關，其他一成" : "約六成客人跟這個主題有關，其他四成"}自由發揮，避免每位都一樣）

每位客人一個 JSON 物件：
- id：1 到 ${count}
- area：客人所在地，要具體到鄉鎮市區。約 65% 在苗栗、台中、彰化、南投、雲林、嘉義（要包含偏遠鄉鎮，例如 南投仁愛、嘉義阿里山、苗栗泰安、台中和平、雲林口湖），約 25% 在不服務的地方（台北、新北、桃園、新竹、台南、高雄、宜蘭、花蓮、屏東、基隆、金門），約 10% 一開始不說地點
- need：想做的事，分布要平均：淋浴拉門（各種款式、尺寸、浴簾換拉門）、浴缸拆掉改乾濕分離、整間浴室翻新、浴櫃或鏡櫃、馬桶臉盆龍頭、玻璃隔屏、還有少數知識庫可能沒有的（廚房、陽台、水電漏水、防水、無障礙扶手、老屋管線）
- style：打字風格和個性，要多樣：急著要報價、很客氣、話很多愛閒聊、殺價、長輩打字有錯字或注音、一次問很多問題、只回很短、懷疑是不是機器人、要求推薦別家、問之後會不會開放服務、直接要約時間、要求電話聯絡、不耐煩、先問價格再問地區
- opener：第一句話，要像真人在 Messenger 打字，繁體中文台灣用語，長短不一。約 30% 直接用這些廣告按鈕的文字其中一句：「我有浴室整修需求」「預約免費到府丈量」「線上評估淋浴拉門」「傳浴室照片給師傅看看」「想了解費用怎麼算」「淋浴拉門款式」。約 10% 的 opener 是「(客人傳了照片)」代表直接傳照片。其他是自己打的句子，有的會先講地點，有的不會
- goal：這位客人在後續 2～3 句對話裡想達成或會追問的事，一句話描述

只輸出 JSON 陣列，不要其他文字。`;

async function makePersonas(): Promise<Persona[]> {
  const cache = path.join(outDir, "personas.json");
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8")) as Persona[];
  // 50 per request (100 overran the output limit and the JSON got cut); each
  // chunk leans on a different theme so 1000 customers do not repeat. Chunks
  // that come back short or unparseable are made up for in another pass.
  const CHUNK = 50;
  const personas: Persona[] = [];
  for (let pass = 0; pass < 4 && personas.length < COUNT; pass++) {
    const chunks = Math.ceil((COUNT - personas.length) / CHUNK);
    const reqs: Req[] = Array.from({ length: chunks }, (_, k) => ({
      id: `personas-${pass}-${k}`,
      system: [{ type: "text", text: "You design realistic test customers. Output JSON only." }],
      user: personaPrompt(CHUNK, THEMES[(k + pass) % THEMES.length], `第 ${k + 1} 批（共 ${chunks} 批）`),
      maxTokens: 12000,
    }));
    const res = await runBatch(reqs);
    for (let k = 0; k < chunks; k++) {
      const part = parseJson<Persona[]>(res.get(`personas-${pass}-${k}`) ?? "") ?? [];
      for (const p of part) if (p?.opener) personas.push({ ...p, id: personas.length + 1 });
    }
    log(`personas so far: ${personas.length}`);
  }
  if (personas.length < COUNT * 0.9) throw new Error(`persona generation failed: got ${personas.length}`);
  fs.writeFileSync(cache, JSON.stringify(personas.slice(0, COUNT), null, 2));
  return personas.slice(0, COUNT);
}

// ─── 2. conversation loop ─────────────────────────────────────────────────
interface Turn { role: "customer" | "bot"; text: string; kind?: string; model?: string }
interface Convo { persona: Persona; turns: Turn[]; ended: boolean }

const BOT_SYSTEM: Block[] = [
  { type: "text", text: FAQ_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
  { type: "text", text: buildFaqContextBlock(KB), cache_control: { type: "ephemeral" } },
];
const fixedReplies = knowledgeBaseFixedReplies(KB);
const passOn = fixedReplies.get("再轉交");
const asHistory = (t: Turn) => ({ direction: t.role === "bot" ? "OUT_AI" : "IN", text: t.text });
// Production: NEEDS_HUMAN after any handoff (御本 keeps answering what the knowledge base covers).
const waitingOnOwner = (c: Convo) => c.turns.some((t) => t.role === "bot" && t.kind === "handoff");

function botRequest(c: Convo, i: number): Req | null {
  const last = c.turns[c.turns.length - 1];
  if (!last || last.role !== "customer") return null;
  // A rule answers this one; no model call needed.
  if (preReplyRule(last.text, KB, c.turns.slice(0, -1).map(asHistory), waitingOnOwner(c))) return null;
  const earlier = c.turns.slice(0, -1);
  const history = earlier.slice(-HISTORY_TURNS).map((t) => ({ role: t.role === "customer" ? ("user" as const) : ("assistant" as const), text: t.text }));
  return {
    id: `bot-${i}`,
    system: BOT_SYSTEM,
    user: buildFaqUserPrompt({ question: last.text.slice(0, 1000), history, tone: "friendly", maxChars: 300, lineWidth: 16 }),
    maxTokens: 2000,
  };
}

function applyBotDecision(c: Convo, raw: string | undefined) {
  const last = c.turns[c.turns.length - 1];
  const earlier = c.turns.slice(0, -1).map(asHistory);
  let output: { answer: string; confident: boolean; crisis?: boolean; fixedReply?: string; images?: string[] } | null = null;
  const pre = preReplyRule(last.text, KB, earlier, waitingOnOwner(c));
  if (pre?.kind === "silent") {
    c.turns.push({ role: "bot", text: "[機器人保持沉默，等師傅回覆]", kind: "silent" });
    return;
  }
  if (pre?.kind === "result") {
    output = pre.result.result;
  } else if (raw) {
    output = parseJson(raw);
  }
  if (!output) {
    c.turns.push({ role: "bot", text: "[AI 無回應，實際會保持沉默]", kind: "ai-unavailable" });
    return;
  }
  let decision = applyReplyRules(decideFaqReply(output, SETTINGS), { question: last.text, earlier, settings: SETTINGS });
  // Production: never two handoff lines in a row; the owner's pass-on line once, then silence.
  const lastBot = [...c.turns].reverse().find((t) => t.role === "bot" && t.kind !== "silent");
  if (decision.kind === "handoff" && lastBot && lastBot.kind === "handoff") {
    if (passOn && lastBot.text !== passOn) decision = { kind: "handoff", text: passOn };
    else {
      c.turns.push({ role: "bot", text: "[機器人保持沉默，等師傅回覆]", kind: "silent" });
      return;
    }
  }
  const images = (output.images ?? []).filter((u) => KB.includes(u)).slice(0, 3);
  const text = decision.kind === "answered" && images.length ? `${decision.text}\n${images.map((u) => `[圖片] ${u}`).join("\n")}` : decision.text;
  c.turns.push({ role: "bot", text, kind: decision.kind });
}

function customerRequest(c: Convo, i: number): Req | null {
  if (c.ended) return null;
  const botTurns = c.turns.filter((t) => t.role === "bot").length;
  if (botTurns >= MAX_BOT_TURNS) return null;
  const transcript = c.turns.map((t) => `${t.role === "customer" ? "你" : "店家"}：${t.text.replace(/\n/g, " ")}`).join("\n");
  const user = `你在 Facebook Messenger 扮演這位客人，正在私訊「御本衛浴」。
你的資料：所在地 ${c.persona.area}；想做 ${c.persona.need}；個性和打字風格：${c.persona.style}；接下來想問或達成：${c.persona.goal}

目前對話（舊到新）：
${transcript}

寫出你的下一則訊息，像真人在手機上打字：繁體中文台灣用語，通常一到兩句，照你的個性來（會錯字的就錯字，急的就急）。只回應店家最後一則說的內容，不要一次把所有問題問完。如果店家說「請師傅回覆」，你可以等、可以追問、也可以先傳照片。要傳照片就只寫「(客人傳了照片)」。
如果對話自然結束了（你已經得到要的、或店家說不服務你的地區而你沒有別的要問），就結束。
只輸出 JSON：{"message": "你的訊息或空字串", "end": true或false}`;
  return { id: `cust-${i}`, system: [{ type: "text", text: "You role-play a Taiwanese customer. Output JSON only." }], user, maxTokens: 400 };
}

// ─── 3. grading ───────────────────────────────────────────────────────────
interface Issue { turn: number; severity: "high" | "medium" | "low"; type: string; note: string }
interface Grade { issues: Issue[]; summary: string }

function gradeRequest(c: Convo, i: number): Req {
  const transcript = c.turns.map((t, n) => `${n + 1}. ${t.role === "customer" ? "客人" : "機器人"}：${t.text.replace(/\n/g, " ⏎ ")}`).join("\n");
  const user = `下面是機器人和客人的一段對話。客人所在地：${c.persona.area}。請只檢查「機器人」的回覆是否符合知識庫和規則，列出問題。

檢查項目（type 用這些代號）：
- 捏造事實：價格、工期、保固、日期、地址、電話等知識庫沒有的內容
- 地區錯誤：客人在不服務的縣市卻沒有用「沒服務」固定句，或在服務縣市卻說沒服務；服務範圍是苗栗、台中、彰化、南投、雲林、嘉義，偏遠鄉鎮知識庫說要轉師傅確認
- 該轉沒轉：估價、約時間、知識庫沒有的項目、客人傳照片後，應該轉給師傅卻自己回答
- 不該轉卻轉：知識庫有答案卻轉給師傅
- 重複：同一段對話裡重複講地區、照片、丈量、價格區間，或重複問客人已經回答過的事
- 順序錯誤：客人說要做淋浴拉門之後的下一則回覆，應先問「浴室的龍頭、馬桶或配件有沒有想一起換呢」，不該先請傳照片
- 要個資：主動要電話、地址
- 答非所問：沒回應客人問的事，或語氣太制式、不像店家
- 自稱機器人：客人沒問卻自己說是自動回覆
- 其他

severity：high = 會讓客人誤解或流失（捏造、地區錯誤、該轉沒轉）；medium = 體驗差（重複、順序錯誤、答非所問）；low = 小瑕疵

對話：
${transcript}

只輸出 JSON：{"issues":[{"turn":編號,"severity":"high|medium|low","type":"代號","note":"一句話說明"}],"summary":"一句話總評"}。沒問題就 issues 給空陣列。`;
  return {
    id: `grade-${i}`,
    system: [
      { type: "text", text: "You audit a customer-service bot's replies against its knowledge base. Be strict and specific. Output JSON only.", cache_control: { type: "ephemeral" } },
      { type: "text", text: `知識庫：\n\n${KB}`, cache_control: { type: "ephemeral" } },
    ],
    user,
    maxTokens: 1500,
  };
}

function cjkWidth(line: string): number {
  let w = 0;
  for (const ch of line) w += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.5;
  return w;
}

function mechanicalIssues(c: Convo): Issue[] {
  const issues: Issue[] = [];
  c.turns.forEach((t, n) => {
    if (t.role !== "bot" || t.kind === "silent" || t.kind === "ai-unavailable") return;
    if (t.text.includes("。")) issues.push({ turn: n + 1, severity: "low", type: "句號", note: "用了「。」" });
    const wide = t.text.split("\n").filter((l) => !l.startsWith("[圖片]") && cjkWidth(l) > 16);
    if (wide.length) issues.push({ turn: n + 1, severity: "low", type: "行太長", note: `有 ${wide.length} 行超過 16 字` });
  });
  return issues;
}

// ─── main ─────────────────────────────────────────────────────────────────
async function main() {
  const convoCache = path.join(outDir, "convos.json");
  const gradeOnly = process.env.GRADE_ONLY === "1" && fs.existsSync(convoCache);
  const personas = gradeOnly ? [] : await makePersonas();
  log(gradeOnly ? "grade-only: reusing convos.json" : `${personas.length} personas`);
  const convos: Convo[] = gradeOnly
    ? (JSON.parse(fs.readFileSync(convoCache, "utf8")) as Convo[])
    : personas.map((p) => ({ persona: p, turns: [{ role: "customer", text: p.opener }], ended: false }));

  for (let round = 0; round < (gradeOnly ? 0 : MAX_BOT_TURNS); round++) {
    const botReqs = convos.map((c, i) => botRequest(c, i)).filter((r): r is Req => Boolean(r));
    log(`round ${round + 1}: ${botReqs.length} bot replies`);
    const botRes = await runBatch(botReqs);
    convos.forEach((c, i) => {
      const last = c.turns[c.turns.length - 1];
      if (last?.role === "customer") applyBotDecision(c, botRes.get(`bot-${i}`));
    });
    fs.writeFileSync(convoCache, JSON.stringify(convos, null, 2));
    if (round === MAX_BOT_TURNS - 1) break;
    const custReqs = convos.map((c, i) => customerRequest(c, i)).filter((r): r is Req => Boolean(r));
    log(`round ${round + 1}: ${custReqs.length} customer turns`);
    const custRes = await runBatch(custReqs);
    convos.forEach((c, i) => {
      const raw = custRes.get(`cust-${i}`);
      if (raw === undefined) return;
      const parsed = parseJson<{ message?: string; end?: boolean }>(raw);
      const msg = parsed?.message?.trim();
      if (!parsed || parsed.end || !msg) c.ended = true;
      else c.turns.push({ role: "customer", text: msg });
    });
    fs.writeFileSync(path.join(outDir, "convos.json"), JSON.stringify(convos, null, 2));
  }

  log("grading");
  const grades = await runBatchParsed(convos.map((c, i) => gradeRequest(c, i)), (t) => {
    const g = parseJson<Grade>(t);
    return g && Array.isArray(g.issues) && typeof g.summary === "string" ? g : null;
  });
  const results = convos.map((c, i) => {
    const g = grades.get(`grade-${i}`) ?? { issues: [], summary: "（評分失敗）" };
    return { ...c, grade: { ...g, issues: [...g.issues, ...mechanicalIssues(c)] } };
  });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ usage, model: MODEL, results }, null, 2));
  log("done", JSON.stringify(usage));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
