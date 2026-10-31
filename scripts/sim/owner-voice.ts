/**
 * Pull everything the owner typed himself in one account's threads and have
 * the model describe his voice: short rules, lines worth copying, and a
 * draft knowledge-base section 【師傅說話範例】 for him to approve. Nothing
 * is written to the knowledge base or the prompt here.
 *
 *   cd openreply; npx tsx scripts/sim/owner-voice.ts <accountId> <knowledge-base.txt> <out.md>
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { parseJson } from "./json-util";
import { prisma } from "@/lib/db/client";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [accountId, kbPath, outPath] = process.argv.slice(2);
if (!accountId || !kbPath || !outPath) throw new Error("usage: owner-voice.ts <accountId> <kb.txt> <out.md>");
const KB = fs.readFileSync(kbPath, "utf8").replace(/\r\n/g, "\n").trim();
const MODEL = process.env.AI_MODEL?.trim() || "claude-haiku-5-5";
const client = new Anthropic({ apiKey: process.env.AI_API_KEY });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

interface Voice {
  styleRules: string[];
  samples: { line: string; whenToUse: string; from: string }[];
  avoid: string[];
  kbSection: string[];
  botDiffers: string[];
}

async function main() {
  const conversations = await prisma.conversation.findMany({
    where: { instagramAccountId: accountId },
    orderBy: { createdAt: "asc" },
    select: {
      senderName: true,
      messages: { orderBy: { createdAt: "asc" }, select: { direction: true, text: true, aiMeta: true } },
    },
  });
  await prisma.$disconnect();

  // Owner lines with the customer line they answer, so the model sees the exchange.
  const exchanges: string[] = [];
  let ownerLines = 0;
  for (const c of conversations) {
    const name = c.senderName ?? "（未知）";
    c.messages.forEach((m, i) => {
      if (m.direction !== "OUT_HUMAN") return;
      ownerLines += 1;
      const before = c.messages.slice(Math.max(0, i - 2), i).map((p) => `${p.direction === "IN" ? "客人" : "機器人"}：${p.text.replace(/\n/g, " ⏎ ")}`);
      exchanges.push([`【${name}】`, ...before, `師傅：${m.text.replace(/\n/g, " ⏎ ")}`].join("\n"));
    });
  }
  log(`${conversations.length} conversations, ${ownerLines} owner lines`);
  if (!ownerLines) throw new Error("no owner lines");

  const batch = await client.messages.batches.create({
    requests: [{
      custom_id: "voice",
      params: {
        model: MODEL,
        max_tokens: 6000,
        output_config: { effort: "low" },
        system: [
          { type: "text", text: "You study how a Taiwanese bathroom-renovation craftsman writes to customers on Messenger, so his bot can sound like him. Output JSON only." },
          { type: "text", text: `機器人目前的知識庫（含說話風格一節）：\n\n${KB}` },
        ],
        messages: [{
          role: "user",
          content: `下面是師傅本人親自回客人的每一句話（附前面一兩句對話當脈絡）。請整理：
1. styleRules：師傅說話的特徵，寫成機器人可以照做的規則，每條一句，繁體中文，不要用「。」（例如常用哪些語尾、怎麼稱呼客人、怎麼開頭、句子多長、什麼時候用表情、怎麼說做不到的事）
2. samples：值得機器人直接照抄或套用的句子，15～25 句，每句附「什麼情況用」和「來自哪位客人的對話」。只能用師傅真的講過的句子，可以把錯字修掉，不能改意思
3. avoid：師傅從來不會這樣講、機器人卻可能會講的話（客服腔、太長、太正式）
4. botDiffers：比較知識庫【說話風格】一節和師傅實際的講法，有哪些不一樣或知識庫沒寫到的
5. kbSection：一段可以直接貼進知識庫的【師傅說話範例】，每個元素一行，第一行是「【師傅說話範例】（師傅本人講過的話，回覆時盡量用這種講法）」，之後每行「情況：句子」，10～20 行，不要用「。」

師傅的話：
${exchanges.join("\n\n")}

只輸出 JSON：{"styleRules":["..."],"samples":[{"line":"...","whenToUse":"...","from":"客人名"}],"avoid":["..."],"botDiffers":["..."],"kbSection":["..."]}`,
        }],
      },
    }],
  });
  log(`batch ${batch.id}`);
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    if (b.processing_status === "ended") break;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  let text = "";
  for await (const r of await client.messages.batches.results(batch.id)) {
    if (r.result.type === "succeeded") text = r.result.message.content.map((c) => ("text" in c ? c.text : "")).join("");
    else log(`${r.custom_id}: ${r.result.type}`);
  }
  const v = parseJson<Voice>(text);
  if (!v) {
    fs.writeFileSync(outPath + ".raw.txt", text);
    throw new Error("unparseable output, raw saved");
  }

  const md = [
    `# 師傅語氣樣本（${new Date().toISOString().slice(0, 10)}）`,
    "",
    `從 ${conversations.length} 段真實對話裡師傅親自回的 ${ownerLines} 句話整理出來。AI 整理的，請你看過再決定要不要加進知識庫；我不會自己加`,
    "",
    "## 一、建議直接貼進知識庫的一段（你批准我再加）",
    "",
    "```",
    ...v.kbSection,
    "```",
    "",
    "## 二、師傅說話的特徵",
    "",
    ...v.styleRules.map((s) => `- ${s}`),
    "",
    "## 三、值得機器人照抄的句子",
    "",
    "| 情況 | 師傅的原句 | 來源 |",
    "|---|---|---|",
    ...v.samples.map((s) => `| ${s.whenToUse} | ${s.line.replace(/\|/g, "／")} | ${s.from} |`),
    "",
    "## 四、機器人可能會講、但師傅從來不這樣講的",
    "",
    ...v.avoid.map((s) => `- ${s}`),
    "",
    "## 五、知識庫【說話風格】和師傅實際講法的差別",
    "",
    ...v.botDiffers.map((s) => `- ${s}`),
    "",
  ];
  fs.writeFileSync(outPath, md.join("\n"));
  log("done", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
