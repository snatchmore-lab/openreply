import { decryptToken } from "@/lib/meta/oauth";
import { prisma } from "@/lib/db/client";

export type InstagramContext =
  | { provider: "META"; accessToken: string }
  | { provider: "FACEBOOK_PAGE"; accessToken: string; pageId: string }
  | {
      provider: "ZERNIO";
      apiKey: string;
      accountId: string;
      instagramId: string;
      operationId?: string;
    };

export type ProviderAccount = {
  provider: "META" | "ZERNIO" | "FACEBOOK_PAGE";
  workspaceId: string;
  zernioAccountId: string | null;
  instagramId: string;
  accessToken: string;
};

export function hasInstagramCredentials(
  account: Pick<ProviderAccount, "provider" | "accessToken" | "zernioAccountId">
) {
  return account.provider === "ZERNIO"
    ? Boolean(account.zernioAccountId)
    : Boolean(account.accessToken);
}

export async function createInstagramContext(
  account: ProviderAccount,
  operationId?: string
): Promise<InstagramContext> {
  if (account.provider === "FACEBOOK_PAGE")
    return {
      provider: "FACEBOOK_PAGE",
      accessToken: decryptToken(account.accessToken),
      pageId: account.instagramId,
    };
  if (account.provider !== "ZERNIO")
    return { provider: "META", accessToken: decryptToken(account.accessToken) };
  if (!account.zernioAccountId)
    throw new Error("Zernio account is not connected");
  const connection = await prisma.zernioConnection.findUnique({
    where: { workspaceId: account.workspaceId },
    select: { apiKey: true },
  });
  if (!connection) throw new Error("Zernio workspace connection is missing");
  return {
    provider: "ZERNIO",
    apiKey: decryptToken(connection.apiKey),
    accountId: account.zernioAccountId,
    instagramId: account.instagramId,
    ...(operationId ? { operationId } : {}),
  };
}

export type ZernioContext = Extract<InstagramContext, { provider: "ZERNIO" }>;

/** Thrown by Instagram-only features when called for a Facebook Page. */
export class FacebookPageUnsupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not available for Facebook Pages yet`);
    this.name = "FacebookPageUnsupportedError";
  }
}
