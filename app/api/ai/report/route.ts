import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getAiReport } from "@/lib/reports/ai-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const raw = Number(request.nextUrl.searchParams.get("days"));
  const days = [7, 30, 90].includes(raw) ? raw : 30;
  const data = await getAiReport(context.workspaceId, days);
  return NextResponse.json({ success: true, data });
}
