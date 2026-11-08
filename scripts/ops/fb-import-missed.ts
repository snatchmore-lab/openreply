// Store customer messages the webhook never delivered (outage) so later replies land in the right thread.
// Usage: npx tsx scripts/ops/fb-import-missed.ts <missed.json> <sinceISO> <customerId>...
import "dotenv/config";
import { readFileSync } from "fs";
import { Client } from "pg";
import { randomUUID } from "crypto";

const ACCOUNT = "cmvrz7leg000007l9l620pg40";
(async () => {
  const [file, sinceIso, ...ids] = process.argv.slice(2);
  const since = new Date(sinceIso);
  const threads = JSON.parse(readFileSync(file, "utf-8"));
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const ws = (await c.query(`select "workspaceId" from "InstagramAccount" where id=$1`, [ACCOUNT])).rows[0].workspaceId;
  for (const id of ids) {
    const t = threads.find((x: any) => x.customerId === id);
    if (!t) { console.log("missing", id); continue; }
    const inbound = t.msgs.filter((m: any) => !m.fromPage && new Date(m.at) >= since);
    const last = inbound[inbound.length - 1];
    const conv = (await c.query(
      `insert into "Conversation" (id,"workspaceId","instagramAccountId","senderId","senderName",status,"lastInboundAt","lastMessageAt","createdAt","updatedAt")
       values ($1,$2,$3,$4,$5,'AI',$6,$6,now(),now())
       on conflict ("instagramAccountId","senderId") do update set "senderName"=coalesce("Conversation"."senderName",excluded."senderName"), "lastInboundAt"=excluded."lastInboundAt", "lastMessageAt"=excluded."lastMessageAt"
       returning id,status`,
      ["c" + randomUUID().replace(/-/g, "").slice(0, 24), ws, ACCOUNT, id, t.customer, new Date(last.at)]
    )).rows[0];
    for (const m of inbound) {
      const text = m.text === "(附件)" ? "(客人傳了照片)" : m.text;
      const dup = (await c.query(`select 1 from "ConversationMessage" where "conversationId"=$1 and direction='IN' and text=$2 and "createdAt"=$3`, [conv.id, text, new Date(m.at)])).rowCount;
      if (!dup) await c.query(`insert into "ConversationMessage" (id,"conversationId",direction,text,"createdAt") values ($1,$2,'IN',$3,$4)`, ["c" + randomUUID().replace(/-/g, "").slice(0, 24), conv.id, text, new Date(m.at)]);
    }
    console.log(t.customer, conv.id, conv.status, inbound.length, "msgs");
  }
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
