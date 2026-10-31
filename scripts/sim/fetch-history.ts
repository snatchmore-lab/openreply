/**
 * Pull a Page's whole Messenger history (read only) so the years before the
 * bot can be reviewed too. One Graph API request every few seconds, progress
 * saved after every page so a stopped run resumes where it was.
 *
 *   cd openreply; npx tsx scripts/sim/fetch-history.ts <accountId> <out-dir>
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";

dotenv.config({ path: path.join(process.cwd(), ".env"), quiet: true });

const [accountId, outDir] = process.argv.slice(2);
if (!accountId || !outDir) throw new Error("usage: fetch-history.ts <accountId> <out-dir>");
fs.mkdirSync(outDir, { recursive: true });
const VERSION = "v21.0";
const PAUSE_MS = 2500;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Msg { id: string; message?: string; created_time: string; from?: { id: string; name?: string }; attachments?: { data: { mime_type?: string; name?: string }[] } }
interface Conv { id: string; updated_time: string; participants?: { data: { id: string; name?: string }[] }; messages?: { data: Msg[]; paging?: { next?: string } } }

let token = "";
async function graph(url: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.includes("access_token=") ? url : `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return body;
    const err = body.error as { code?: number; message?: string } | undefined;
    // 4 / 17 / 32 / 613: rate limits. Back off for minutes, not seconds.
    if (err && [4, 17, 32, 613].includes(err.code ?? 0)) {
      const wait = (attempt + 1) * 5 * 60_000;
      log(`rate limited (${err.code}), waiting ${wait / 60000} min`);
      await sleep(wait);
      continue;
    }
    throw new Error(`Graph ${res.status}: ${err?.message ?? JSON.stringify(body).slice(0, 200)}`);
  }
  throw new Error("gave up after repeated rate limits");
}

async function main() {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { instagramId: true, accessToken: true } });
  await prisma.$disconnect();
  if (!account) throw new Error("no account");
  token = decryptToken(account.accessToken);
  const pageId = account.instagramId;

  const file = path.join(outDir, "conversations.json");
  const stateFile = path.join(outDir, "state.json");
  const conversations: Conv[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Conv[]) : [];
  const seen = new Set(conversations.map((c) => c.id));
  let next: string | null = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, "utf8")) as { next: string | null }).next : null;
  if (conversations.length && !next) {
    log(`already complete: ${conversations.length} conversations`);
    return;
  }
  let url: string =
    next ??
    `https://graph.facebook.com/${VERSION}/${pageId}/conversations?platform=messenger&limit=50&fields=id,updated_time,participants,messages.limit(100){id,message,created_time,from,attachments{mime_type,name}}`;
  let calls = 0;
  for (;;) {
    const page = (await graph(url)) as { data?: Conv[]; paging?: { next?: string } };
    calls += 1;
    for (const c of page.data ?? []) {
      if (seen.has(c.id)) continue;
      // A long thread: follow its own message pages (oldest messages last).
      let more = c.messages?.paging?.next;
      while (more) {
        await sleep(PAUSE_MS);
        const chunk = (await graph(more)) as { data?: Msg[]; paging?: { next?: string } };
        calls += 1;
        c.messages!.data.push(...(chunk.data ?? []));
        more = chunk.paging?.next;
      }
      if (c.messages) delete c.messages.paging;
      conversations.push(c);
      seen.add(c.id);
    }
    const oldest = conversations[conversations.length - 1]?.updated_time;
    log(`${conversations.length} conversations, ${calls} calls, oldest ${oldest}`);
    fs.writeFileSync(file, JSON.stringify(conversations));
    const nextUrl = page.paging?.next ?? null;
    fs.writeFileSync(stateFile, JSON.stringify({ next: nextUrl }));
    if (!nextUrl) break;
    url = nextUrl;
    await sleep(PAUSE_MS);
  }
  const messages = conversations.reduce((s, c) => s + (c.messages?.data.length ?? 0), 0);
  log(`done: ${conversations.length} conversations, ${messages} messages, ${calls} calls`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
