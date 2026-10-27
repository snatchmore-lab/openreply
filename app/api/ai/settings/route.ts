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
  notifyEmail: null as string | null,
  answerAfterHandoff: false,
};

const updateSchema = z.object({
  faqEnabled: z.boolean().optional(),
  knowledgeBase: z.string().max(20000).optional(),
  handoffMessage: z.string().min(1).max(500).optional(),
  hourlyLimitPerUser: z.number().int().min(1).max(20).optional(),
  tone: z.enum(["friendly", "professional"]).optional(),
  maxReplyChars: z.number().int().min(50).max(1000).optional(),
  // Empty string clears it.
  notifyEmail: z.union([z.string().email().max(200), z.literal("")]).optional().nullable(),
  answerAfterHandoff: z.boolean().optional(),
});

type SettingsFields = typeof DEFAULTS;

function pick(row: SettingsFields & Record<string, unknown>): SettingsFields {
  return {
    faqEnabled: row.faqEnabled,
    knowledgeBase: row.knowledgeBase,
    handoffMessage: row.handoffMessage,
    hourlyLimitPerUser: row.hourlyLimitPerUser,
    tone: row.tone,
    maxReplyChars: row.maxReplyChars,
    notifyEmail: row.notifyEmail ?? null,
    answerAfterHandoff: row.answerAfterHandoff ?? false,
  };
}

/** The account must belong to the caller's workspace, or it is ignored. */
async function resolveAccount(workspaceId: string, instagramAccountId: string | null) {
  if (!instagramAccountId) return null;
  return prisma.instagramAccount.findFirst({
    where: { id: instagramAccountId, workspaceId },
    select: { id: true },
  });
}

/**
 * GET ?instagramAccountId=… returns that account's settings, or the
 * workspace defaults flagged `inherited: true` when the account has none.
 * Without the parameter it returns the workspace defaults.
 */
export async function GET(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const account = await resolveAccount(
    context.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  const workspaceRow = await prisma.workspaceAiSettings.findUnique({
    where: { workspaceId: context.workspaceId },
  });
  const workspaceSettings = workspaceRow ? pick(workspaceRow) : DEFAULTS;

  if (!account) {
    return NextResponse.json({
      success: true,
      data: { ...workspaceSettings, scope: "workspace", inherited: false },
    });
  }

  const accountRow = await prisma.instagramAccountAiSettings.findUnique({
    where: { instagramAccountId: account.id },
  });
  return NextResponse.json({
    success: true,
    data: accountRow
      ? { ...pick(accountRow), scope: "account", inherited: false }
      : { ...workspaceSettings, scope: "account", inherited: true },
  });
}

/**
 * PUT ?instagramAccountId=… saves an account-specific row (creating it from
 * the submitted values plus workspace defaults). Without the parameter it
 * saves the workspace defaults.
 */
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

  const update = {
    ...parsed.data,
    ...(parsed.data.notifyEmail !== undefined
      ? { notifyEmail: parsed.data.notifyEmail?.trim() || null }
      : {}),
  };

  const account = await resolveAccount(
    context.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );

  if (account) {
    const workspaceRow = await prisma.workspaceAiSettings.findUnique({
      where: { workspaceId: context.workspaceId },
    });
    const base = workspaceRow ? pick(workspaceRow) : DEFAULTS;
    const row = await prisma.instagramAccountAiSettings.upsert({
      where: { instagramAccountId: account.id },
      create: { instagramAccountId: account.id, ...base, ...update },
      update,
    });
    return NextResponse.json({
      success: true,
      data: { ...pick(row), scope: "account", inherited: false },
    });
  }

  const row = await prisma.workspaceAiSettings.upsert({
    where: { workspaceId: context.workspaceId },
    create: { workspaceId: context.workspaceId, ...DEFAULTS, ...update },
    update,
  });
  return NextResponse.json({
    success: true,
    data: { ...pick(row), scope: "workspace", inherited: false },
  });
}

/** DELETE ?instagramAccountId=… removes the account row so it inherits again. */
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  const account = await resolveAccount(
    context.workspaceId,
    request.nextUrl.searchParams.get("instagramAccountId")
  );
  if (!account) {
    return NextResponse.json({ success: false, error: "Account required" }, { status: 400 });
  }
  await prisma.instagramAccountAiSettings
    .delete({ where: { instagramAccountId: account.id } })
    .catch(() => {});
  return NextResponse.json({ success: true });
}
