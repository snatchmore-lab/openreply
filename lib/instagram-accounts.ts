import { prisma } from "@/lib/db/client";

export async function canConnectInstagramAccount({
  workspaceId,
  instagramId,
}: {
  workspaceId: string;
  instagramId: string;
}) {
  const existingAccount = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { workspaceId: true, provider: true },
  });

  if (existingAccount && (existingAccount.workspaceId !== workspaceId || existingAccount.provider === "ZERNIO")) {
    return {
      allowed: false,
      reason: "already_connected" as const,
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

export async function getWorkspaceInstagramAccount(
  workspaceId: string,
  instagramAccountId?: string | null
) {
  if (instagramAccountId && instagramAccountId !== "all") {
    return prisma.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId },
    });
  }

  // The default is the newest Instagram account. A Facebook Page is only used
  // when asked for by id: the Instagram analytics and inbox can't read Pages.
  return prisma.instagramAccount.findFirst({
    where: { workspaceId, provider: { not: "FACEBOOK_PAGE" } },
    orderBy: { connectedAt: "desc" },
  });
}

