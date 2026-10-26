import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { isAiConfigured } from "@/lib/ai/service";
import {
  composeDmWithOpening,
  generateOpening,
  MAX_OPENING_MAX_CHARS,
  MIN_OPENING_MAX_CHARS,
} from "@/lib/ai/opening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewSchema = z.object({
  commentText: z.string().min(1).max(1000),
  commenterName: z.string().max(64).optional().nullable(),
  tone: z.enum(["friendly", "professional"]).optional().default("friendly"),
  maxChars: z
    .number()
    .int()
    .min(MIN_OPENING_MAX_CHARS)
    .max(MAX_OPENING_MAX_CHARS)
    .optional()
    .default(40),
  description: z.string().max(300).optional().nullable(),
  dmMessage: z.string().max(1000).optional().default(""),
});

/**
 * Dashboard preview for the AI opener: the owner types a fake comment and sees
 * the sentence the model would prepend. Same code path as the worker, so what
 * the preview shows is what a real commenter would get. Counts against the
 * daily call cap like any other call.
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

  const parsed = previewSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid preview request" },
      { status: 400 }
    );
  }

  const { commentText, commenterName, tone, maxChars, description, dmMessage } =
    parsed.data;

  const opening = await generateOpening(commentText, commenterName ?? null, {
    id: `preview:${context.workspaceId}`,
    workspaceId: context.workspaceId,
    aiOpeningTone: tone,
    aiOpeningMaxChars: maxChars,
    aiMatchDescription: description ?? null,
  });

  return NextResponse.json({
    success: true,
    data: {
      opening,
      preview: composeDmWithOpening(opening, dmMessage),
    },
  });
}
