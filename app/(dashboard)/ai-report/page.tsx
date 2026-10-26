"use client";

/**
 * AI report: per-campaign funnel with the AI matcher's verdicts, FAQ-bot
 * conversation states, and AI usage with an estimated cost.
 */

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import StatCard from "@/components/stat-card";
import type { AiReport } from "@/lib/reports/ai-report";

const DAY_OPTIONS = [7, 30, 90] as const;

const FEATURE_LABELS = {
  match: "Smart matching",
  opening: "AI opener",
  faq: "AI FAQ bot",
  vary: "AI rewording",
} as const;

export default function AiReportPage() {
  const { t, locale } = useI18n();
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>(30);
  const [data, setData] = useState<AiReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/ai/report?days=${days}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.success) {
          setData(json.data as AiReport);
          setError(null);
        } else {
          setError(t("Failed to load the report."));
        }
      })
      .catch(() => {
        if (!cancelled) setError(t("Failed to load the report."));
      });
    return () => {
      cancelled = true;
    };
  }, [days, t]);

  const fmt = (n: number) => n.toLocaleString(locale);
  const usd = (n: number) => `US$${n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2)}`;
  const featureLabel = (feature: string) => {
    switch (feature) {
      case "match":
        return t(FEATURE_LABELS.match);
      case "opening":
        return t(FEATURE_LABELS.opening);
      case "faq":
        return t(FEATURE_LABELS.faq);
      case "vary":
        return t(FEATURE_LABELS.vary);
      default:
        return t("AI usage");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">{t("AI Report")}</h1>
        <div className="flex gap-1">
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                days === d
                  ? "border-accent bg-accent text-white"
                  : "border-border text-muted hover:text-foreground"
              }`}
            >
              {t("Last {count} days", { count: d })}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}
      {!data && !error && <p className="text-sm text-muted">{t("Loading…")}</p>}

      {data && (
        <>
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">{t("FAQ bot conversations")}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatCard label={t("Conversations")} value={fmt(data.conversations.total)} />
              <StatCard label={t("AI replying")} value={fmt(data.conversations.ai)} />
              <StatCard label={t("Needs a human")} value={fmt(data.conversations.needsHuman)} />
              <StatCard label={t("Taken over")} value={fmt(data.conversations.human)} />
              <StatCard label={t("Bot replies sent")} value={fmt(data.conversations.aiReplies)} />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">{t("Campaigns")}</h2>
            <div className="panel overflow-x-auto rounded">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2">{t("Campaign")}</th>
                    <th className="px-3 py-2 text-right">{t("Comments")}</th>
                    <th className="px-3 py-2 text-right">{t("Exact hits")}</th>
                    <th className="px-3 py-2 text-right">{t("AI hits")}</th>
                    <th className="px-3 py-2 text-right">{t("AI: no match")}</th>
                    <th className="px-3 py-2 text-right">{t("Sent")}</th>
                    <th className="px-3 py-2 text-right">{t("Failed")}</th>
                    <th className="px-3 py-2 text-right">{t("Clicks")}</th>
                    <th className="px-3 py-2 text-right">{t("CTR")}</th>
                    <th className="px-3 py-2 text-right">{t("AI openers")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-4 text-muted">
                        {t("No campaigns yet.")}
                      </td>
                    </tr>
                  )}
                  {data.campaigns.map((c) => (
                    <tr key={c.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        <div className="font-medium text-foreground">{c.name}</div>
                        <div className="text-xs text-muted">
                          @{c.accountUsername}
                          {!c.isActive && ` · ${t("Paused")}`}
                          {c.aiMatchEnabled && ` · ${t("Smart matching")}`}
                          {c.aiOpeningEnabled && ` · ${t("AI opener")}`}
                          {c.aiPublicReplyVary && ` · ${t("AI rewording")}`}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(c.comments)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.exactHits)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.aiHits)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.aiMisses)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.sent)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.failed)}</td>
                      <td className="px-3 py-2 text-right">{fmt(c.clicks)}</td>
                      <td className="px-3 py-2 text-right">{c.ctr}%</td>
                      <td className="px-3 py-2 text-right">{fmt(c.aiOpeners)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              {t(
                "Comments counts only comments that reached a campaign: exact hits, AI hits and AI misses. Comments the exact matcher rejected on a campaign without smart matching are not recorded."
              )}
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">{t("AI usage")}</h2>
            <div className="panel overflow-x-auto rounded">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2">{t("Feature")}</th>
                    <th className="px-3 py-2 text-right">{t("Calls")}</th>
                    <th className="px-3 py-2 text-right">{t("Input tokens")}</th>
                    <th className="px-3 py-2 text-right">{t("Output tokens")}</th>
                    <th className="px-3 py-2 text-right">{t("Estimated cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-muted">
                        {t("No AI calls in this period.")}
                      </td>
                    </tr>
                  )}
                  {data.usage.map((u) => (
                    <tr key={u.feature} className="border-t border-border">
                      <td className="px-3 py-2">{featureLabel(u.feature)}</td>
                      <td className="px-3 py-2 text-right">{fmt(u.calls)}</td>
                      <td className="px-3 py-2 text-right">{fmt(u.inputTokens)}</td>
                      <td className="px-3 py-2 text-right">{fmt(u.outputTokens)}</td>
                      <td className="px-3 py-2 text-right">{usd(u.estimatedUsd)}</td>
                    </tr>
                  ))}
                  {data.usage.length > 0 && (
                    <tr className="border-t border-border font-medium">
                      <td className="px-3 py-2" colSpan={4}>
                        {t("Total")}
                      </td>
                      <td className="px-3 py-2 text-right">{usd(data.usageTotalUsd)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted">
              {t("Estimated at list price for the default model; cached input is billed lower, so the real bill is at or below this.")}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
