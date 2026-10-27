"use client";

import { useI18n } from "@/lib/i18n/provider";
import { useSearchParams } from "next/navigation";

/** Shows the ?facebook= result the Facebook Page connect flow redirects back with. */
export function FacebookConnectNotice() {
  const { t } = useI18n();
  const params = useSearchParams();
  const status = params.get("facebook");
  if (!status) return null;

  const ok = status === "connected";
  const message =
    status === "connected"
      ? t("Facebook Page connected. Pages connected: {count}", { count: params.get("pages") ?? "0" })
      : status === "no_pages"
        ? t("No Facebook Page was granted. Start again and tick your Page on the Facebook screen.")
        : status === "denied"
          ? t("Facebook connection cancelled.")
          : status === "failed"
            ? `${t("Facebook connection failed")}: ${params.get("reason") ?? ""}`
            : t("Facebook connection did not complete. Please try again.");

  return (
    <div
      className={`rounded border px-4 py-3 text-sm ${
        ok ? "border-success/20 bg-success/10 text-success" : "border-warning/20 bg-warning/10 text-warning"
      }`}
    >
      {message}
    </div>
  );
}
