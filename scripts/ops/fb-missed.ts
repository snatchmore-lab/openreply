// Read-only: Messenger threads on 御本衛浴 updated since the bot went dark,
// with their recent messages, from the Graph API (the webhook never delivered them).
// Usage: npx tsx scripts/ops/fb-missed.ts [sinceISO]
import "dotenv/config";
import { Client } from "pg";
import { writeFileSync } from "fs";
import { decryptToken } from "@/lib/meta/oauth";

const ACCOUNT = "cmvrz7leg000007l9l620pg40";
const since = new Date(process.argv[2] || "2026-11-06T06:00:00Z");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const a = (await c.query(`select "accessToken","instagramId" from "InstagramAccount" where id=$1`, [ACCOUNT])).rows[0];
  const known = (await c.query(`select "senderId","senderName",status from "Conversation" where "instagramAccountId"=$1`, [ACCOUNT])).rows;
  await c.end();
  const tok = decryptToken(a.accessToken);
  const pageId = a.instagramId;
  const out: any[] = [];
  let url: string | null =
    `https://graph.facebook.com/v21.0/${pageId}/conversations?platform=messenger&limit=50&fields=updated_time,participants,messages.limit(15){message,from,created_time,attachments}&access_token=${encodeURIComponent(tok)}`;
  while (url) {
    const r = await fetch(url);
    const j: any = await r.json();
    if (j.error) { console.log("error", JSON.stringify({ code: j.error.code, message: j.error.message })); break; }
    let older = false;
    for (const t of j.data ?? []) {
      if (new Date(t.updated_time) < since) { older = true; continue; }
      const customer = (t.participants?.data ?? []).find((p: any) => p.id !== pageId);
      const msgs = (t.messages?.data ?? []).map((m: any) => ({
        at: m.created_time,
        fromPage: m.from?.id === pageId,
        text: m.message || (m.attachments?.data?.length ? "(附件)" : ""),
      })).reverse();
      const k = known.find((x) => x.senderId === customer?.id);
      out.push({ customer: customer?.name, customerId: customer?.id, updated: t.updated_time, dbStatus: k?.status ?? "NEW", msgs });
    }
    url = older ? null : j.paging?.next ?? null;
  }
  writeFileSync(process.argv[3] || "missed.json", JSON.stringify(out, null, 1));
  for (const t of out) {
    const last = t.msgs[t.msgs.length - 1];
    console.log(`${t.updated.slice(5, 16)} ${t.customer} [${t.dbStatus}] last=${last?.fromPage ? "PAGE" : "CUSTOMER"} ${JSON.stringify((last?.text || "").slice(0, 30))}`);
  }
  console.log("threads:", out.length);
})().catch((e) => { console.error(e.message); process.exit(1); });
