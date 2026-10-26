import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";
import { DEFAULT_HANDOFF_MESSAGE } from "@/lib/ai/faq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS = {
  faqEnabled: false,
  knowledgeBase: "",
  handoffMessage: DEFAULT_HANDOFF_MESSAGE,
  hourlyLimitPerUser: 3,
  tone: "friendly",
  maxReplyChars: 300,
};

const updateSchema = z.object({
  faqEnabled: z.boolean().optional(),
  knowledgeBase: z.string().max(20000).optional(),
  handoffMessage: z.string().min(1).max(500).optional(),
  hourlyLimitPerUser: z.number().int().min(1).max(20).optional(),
  tone: z.enum(["friendly", "professional"]).optional(),
  maxReplyChars: z.number().int().min(50).max(1000).optional(),
});

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const row = await prisma.workspaceAiSettings.findUnique({
    where: { workspaceId: context.workspaceId },
  });
  const { createdAt, updatedAt, workspaceId, ...rest } = row ?? {
    ...DEFAULTS,
    workspaceId: context.workspaceId,
    createdAt: null,
    updatedAt: null,
  };
  void createdAt;
  void updatedAt;
  void workspaceId;
  return NextResponse.json({ success: true, data: rest });
}

export async function PUT(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Invalid settings" }, { status: 400 });
  }

  const row = await prisma.workspaceAiSettings.upsert({
    where: { workspaceId: context.workspaceId },
    create: { workspaceId: context.workspaceId, ...DEFAULTS, ...parsed.data },
    update: parsed.data,
  });
  const { createdAt, updatedAt, workspaceId, ...rest } = row;
  void createdAt;
  void updatedAt;
  void workspaceId;
  return NextResponse.json({ success: true, data: rest });
}
