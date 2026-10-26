import { NextResponse } from "next/server";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getAiModel, getDailyCallLimit, isAiConfigured } from "@/lib/ai/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tells the dashboard whether AI features can be switched on. The key itself
 * is never returned; only whether one is set.
 */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    data: {
      configured: isAiConfigured(),
      model: getAiModel(),
      dailyCallLimit: getDailyCallLimit(),
    },
  });
}
