import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AiConversationItem {
  id: string;
  senderId: string;
  senderName: string | null;
  status: "AI" | "NEEDS_HUMAN" | "HUMAN";
  aiReplyCount: number;
  lastMessageAt: string | null;
  needsHumanAt: string | null;
  /** The person's latest message, for lists that have no other preview. */
  lastText: string | null;
}

/**
 * Bot-tracked conversations for one account, keyed by the other side's IGSID
 * so the inbox can decorate Instagram's own thread list.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const instagramAccountId = request.nextUrl.searchParams.get("instagramAccountId");
  const rows = await prisma.conversation.findMany({
    where: {
      workspaceId: context.workspaceId,
      ...(instagramAccountId ? { instagramAccountId } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
    select: {
      id: true,
      senderId: true,
      senderName: true,
      status: true,
      aiReplyCount: true,
      lastMessageAt: true,
      needsHumanAt: true,
      messages: {
        where: { direction: "IN" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { text: true },
      },
    },
  });

  const data: AiConversationItem[] = rows.map(({ messages, ...r }) => ({
    ...r,
    lastText: messages[0]?.text ?? null,
    lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
    needsHumanAt: r.needsHumanAt?.toISOString() ?? null,
  }));
  return NextResponse.json({ success: true, data });
}
