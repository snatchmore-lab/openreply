import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ id: string }> };

const actionSchema = z.object({
  action: z.enum(["takeover", "resume"]),
});

/** The bot's own record of one thread (inbound + bot replies). */
export async function GET(_request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, workspaceId: context.workspaceId },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 100 },
    },
  });
  if (!conversation) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: conversation });
}

/**
 * takeover: a person handles this thread from now on; the bot goes silent.
 * resume:   hand the thread back to the bot.
 */
export async function POST(request: NextRequest, { params }: RouteProps) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 });
  }

  const existing = await prisma.conversation.findFirst({
    where: { id, workspaceId: context.workspaceId },
    select: { id: true },
  });
  if (!existing) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const updated = await prisma.conversation.update({
    where: { id },
    data:
      parsed.data.action === "takeover"
        ? { status: "HUMAN", takenOverAt: new Date() }
        : { status: "AI", takenOverAt: null, needsHumanAt: null },
    select: { id: true, status: true },
  });
  return NextResponse.json({ success: true, data: updated });
}
