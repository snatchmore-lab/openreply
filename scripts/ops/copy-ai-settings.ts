// Copy one account's AI settings (knowledge base, handoff line, limits) to another account.
// Usage: npx tsx scripts/ops/copy-ai-settings.ts <fromAccountId> <toUsername> [--enable]
// Without --enable the copy is saved with faqEnabled=false so nothing answers yet.
import "dotenv/config";
import { Client } from "pg";

(async () => {
  const [fromId, toUsername, flag] = process.argv.slice(2);
  const enable = flag === "--enable";
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const to = (await c.query(`select id,username,provider,"instagramId","tokenExpiresAt","webhookSubscribed" from "InstagramAccount" where username=$1`, [toUsername])).rows[0];
  if (!to) throw new Error("no account " + toUsername);
  const src = (await c.query(`select * from "InstagramAccountAiSettings" where "instagramAccountId"=$1`, [fromId])).rows[0];
  if (!src) throw new Error("no settings on " + fromId);
  await c.query(
    `insert into "InstagramAccountAiSettings" ("instagramAccountId","faqEnabled","knowledgeBase","handoffMessage","hourlyLimitPerUser",tone,"maxReplyChars","notifyEmail","answerAfterHandoff","maxLineWidth","createdAt","updatedAt")
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
     on conflict ("instagramAccountId") do update set "faqEnabled"=excluded."faqEnabled","knowledgeBase"=excluded."knowledgeBase","handoffMessage"=excluded."handoffMessage","hourlyLimitPerUser"=excluded."hourlyLimitPerUser",tone=excluded.tone,"maxReplyChars"=excluded."maxReplyChars","notifyEmail"=excluded."notifyEmail","answerAfterHandoff"=excluded."answerAfterHandoff","maxLineWidth"=excluded."maxLineWidth","updatedAt"=now()`,
    [to.id, enable, src.knowledgeBase, src.handoffMessage, src.hourlyLimitPerUser, src.tone, src.maxReplyChars, src.notifyEmail, src.answerAfterHandoff, src.maxLineWidth]
  );
  const after = (await c.query(`select "faqEnabled",length("knowledgeBase") kb,"handoffMessage","hourlyLimitPerUser","answerAfterHandoff","maxLineWidth","notifyEmail" from "InstagramAccountAiSettings" where "instagramAccountId"=$1`, [to.id])).rows[0];
  console.log("to:", to.username, to.provider, "id", to.id, "igId", to.instagramId, "webhook", to.webhookSubscribed);
  console.log(after);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
