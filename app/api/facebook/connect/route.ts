import { NextResponse } from "next/server";
import { canManageWorkspace, getCurrentWorkspaceContext } from "@/lib/workspace-access";
import { getBaseUrl } from "@/lib/env";
import { createOAuthState } from "@/lib/meta/oauth";
import { getFacebookAuthorizationUrl } from "@/lib/meta/client";

/** Start Facebook Login so the owner can grant the app their Page(s). */
export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.redirect(`${getBaseUrl()}/login`);
  if (!canManageWorkspace(context.role)) {
    return NextResponse.redirect(`${getBaseUrl()}/settings?facebook=forbidden`);
  }
  if (!process.env.FACEBOOK_APP_SECRET) {
    return NextResponse.redirect(
      `${getBaseUrl()}/settings?facebook=misconfigured&missing=FACEBOOK_APP_SECRET`
    );
  }
  const redirectUri = `${getBaseUrl()}/api/facebook/callback`;
  return NextResponse.redirect(
    getFacebookAuthorizationUrl(redirectUri, createOAuthState(context.workspaceId))
  );
}
