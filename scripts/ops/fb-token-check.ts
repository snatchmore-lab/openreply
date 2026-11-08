// Read-only: does the 御本衛浴 Page token still work, and is the Page still subscribed to the app?
// Prints Graph API results only, never the token.
import "dotenv/config";
import { Client } from "pg";
import { decryptToken } from "@/lib/meta/oauth";
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const a = (await c.query(`select "accessToken","instagramId","tokenExpiresAt" from "InstagramAccount" where id='cmvrz7leg000007l9l620pg40'`)).rows[0];
  await c.end();
  console.log("tokenExpiresAt", a.tokenExpiresAt);
  const tok = decryptToken(a.accessToken);
  const get = async (path: string) => {
    const r = await fetch(`https://graph.facebook.com/v21.0/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(tok)}`);
    const j: any = await r.json();
    console.log(path.split("?")[0], r.status, JSON.stringify(j.error ? { code: j.error.code, subcode: j.error.error_subcode, type: j.error.type, message: j.error.message } : j));
  };
  await get("me?fields=id,name");
  await get(`${a.instagramId}/subscribed_apps`);
})().catch((e) => { console.error(e.message); process.exit(1); });
