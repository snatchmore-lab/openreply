import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { isAiConfigured } from "@/lib/ai/service";
import { previewFaqAnswer } from "@/lib/ai/faq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  question: z.string().min(1).max(1000),
  knowledgeBase: z.string().max(20000),
  handoffMessage: z.string().max(500).optional().default(""),
  tone: z.enum(["friendly", "professional"]).optional().default("friendly"),
  maxReplyChars: z.number().int().min(50).max(1000).optional().default(300),
});

/**
 * Knowledge-base test bench: ask the FAQ bot a question against the settings
 * currently in the form (saved or not). Nothing is sent to Instagram and no
 * conversation is recorded; it counts as one AI call against the daily cap.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isAiConfigured()) {
    return NextResponse.json(
      { success: false, error: "AI is not configured on this server" },
      { status: 400 }
    );
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }
  const { question, ...settings } = parsed.data;
  const result = await previewFaqAnswer({
    workspaceId: context.workspaceId,
    question,
    settings,
  });
  return NextResponse.json({ success: true, data: result });
}
