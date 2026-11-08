// Read-only: do the Instagram (META provider) tokens still work? Prints Graph results only.
import "dotenv/config";
import { Client } from "pg";
import { decryptToken } from "@/lib/meta/oauth";
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const rows = (await c.query(`select username,"accessToken","instagramId","tokenExpiresAt" from "InstagramAccount" where provider='META'`)).rows;
  await c.end();
  for (const a of rows) {
    const tok = decryptToken(a.accessToken);
    const r = await fetch(`https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(tok)}`);
    const j: any = await r.json();
    console.log(a.username, "expires", a.tokenExpiresAt?.toISOString().slice(0, 10), "→", r.status, JSON.stringify(j.error ? { code: j.error.code, message: j.error.message } : j));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
