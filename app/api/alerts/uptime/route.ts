import { NextResponse, type NextRequest } from "next/server";
import { pushLineMessage } from "@/lib/notify/line";

/**
 * Webhook for an external uptime monitor (UptimeRobot) watching /api/health.
 * The daily cron is the only other thing that notices a dead worker, so this
 * turns the monitor's down/up alerts into LINE messages within minutes.
 *
 * Configure the monitor's webhook as
 *   https://<host>/api/alerts/uptime?key=<CRON_SECRET>&type=*alertType*&name=*monitorFriendlyName*&details=*alertDetails*
 * UptimeRobot fills the *…* placeholders: alertType 1 = down, 2 = up.
 */
export const dynamic = "force-dynamic";

async function handle(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl;
  const secret = process.env.CRON_SECRET;
  if (!secret || url.searchParams.get("key") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
  } catch {
    // GET without a body
  }
  const field = (name: string, alt: string) =>
    String(url.searchParams.get(name) ?? body[name] ?? body[alt] ?? "").trim();
  const type = field("type", "alertType");
  const name = field("name", "monitorFriendlyName") || "OpenReply";
  const details = field("details", "alertDetails");

  const text =
    type === "2"
      ? `✅ ${name} 恢復正常了，機器人應該又能回覆`
      : [
          `⚠️ ${name} 沒有回應，機器人可能停了`,
          details ? `監測回報：${details.slice(0, 200)}` : "",
          "請到 railway.com 看 openreply 服務有沒有在跑、額度夠不夠",
        ]
          .filter(Boolean)
          .join("\n");
  const sent = await pushLineMessage(text);
  return NextResponse.json({ ok: true, sent });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
