import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  exchangeFacebookCode,
  getFacebookPages,
  subscribeFacebookPage,
} from "@/lib/meta/client";
import { encryptToken, verifyOAuthState } from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

/**
 * Facebook Login callback: store every Page the owner granted as an account
 * with provider FACEBOOK_PAGE (Page id in instagramId, Page token encrypted),
 * and subscribe each Page's messages to the app webhook.
 */
export async function GET(request: NextRequest) {
  const baseUrl = getBaseUrl();
  const code = request.nextUrl.searchParams.get("code");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));

  if (request.nextUrl.searchParams.get("error")) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=denied`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) return NextResponse.redirect(`${baseUrl}/login`);
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId: state.workspaceId, userId: session.user.id },
  });
  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?facebook=forbidden`);
  }

  try {
    const userToken = await exchangeFacebookCode(code, `${baseUrl}/api/facebook/callback`);
    const pages = await getFacebookPages(userToken);
    if (pages.length === 0) {
      return NextResponse.redirect(`${baseUrl}/settings?facebook=no_pages`);
    }

    let connected = 0;
    for (const page of pages) {
      const allowed = await canConnectInstagramAccount({
        workspaceId: state.workspaceId,
        instagramId: page.id,
      });
      if (!allowed.allowed) continue;

      let webhookSubscribed = false;
      try {
        webhookSubscribed = await subscribeFacebookPage(page.id, page.access_token);
      } catch (error) {
        console.warn("[Facebook Callback] Page subscription failed:", error);
      }

      const data = {
        username: page.name,
        name: page.name,
        accessToken: encryptToken(page.access_token),
        tokenExpiresAt: null,
        webhookSubscribed,
      };
      const existing = await prisma.instagramAccount.findUnique({ where: { instagramId: page.id } });
      if (existing) {
        await prisma.instagramAccount.updateMany({
          where: { id: existing.id, workspaceId: state.workspaceId, provider: "FACEBOOK_PAGE" },
          data,
        });
      } else {
        await prisma.instagramAccount.create({
          data: { ...data, workspaceId: state.workspaceId, instagramId: page.id, provider: "FACEBOOK_PAGE" },
        });
      }
      connected += 1;
    }

    return NextResponse.redirect(`${baseUrl}/settings?facebook=connected&pages=${connected}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Facebook Callback] Error:", err);
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Facebook Page connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});
    return NextResponse.redirect(
      `${baseUrl}/settings?facebook=failed&reason=${encodeURIComponent(message.slice(0, 200))}`
    );
  }
}
