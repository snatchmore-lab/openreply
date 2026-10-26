"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

interface AiSettingsData {
  faqEnabled: boolean;
  knowledgeBase: string;
  handoffMessage: string;
  hourlyLimitPerUser: number;
  tone: string;
  maxReplyChars: number;
}

/**
 * Workspace-level FAQ bot settings on the Settings page. Greyed out with a
 * hint when the server has no AI_API_KEY, so the switch cannot be turned on
 * for a bot that could not run.
 */
export function AiSettings({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [data, setData] = useState<AiSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/ai/status").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/ai/settings").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([status, settings]) => {
        if (cancelled) return;
        setConfigured(Boolean(status?.data?.configured));
        if (settings?.data) setData(settings.data as AiSettingsData);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!data) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          tone: data.tone === "professional" ? "professional" : "friendly",
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error("save failed");
      setData(json.data as AiSettingsData);
      setNotice(t("AI settings saved."));
    } catch {
      setNotice(t("Could not save AI settings."));
    } finally {
      setSaving(false);
    }
  }

  if (!data) return null;
  const disabled = !canManage || configured === false;

  return (
    <section className="panel rounded p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t("AI FAQ bot")}</h2>
        <p className="mt-1 text-sm text-muted">
          {t(
            "Answers follow-up DMs from the knowledge base below. Anything it cannot answer gets your handoff message and the conversation is flagged for you."
          )}
        </p>
        {configured === false && (
          <p className="mt-2 text-xs text-warning">
            {t("Set AI_API_KEY on the server to enable AI features.")}
          </p>
        )}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
        <span className="text-sm text-foreground">{t("Enable FAQ bot")}</span>
        <input
          type="checkbox"
          checked={data.faqEnabled && configured !== false}
          disabled={disabled}
          onChange={(e) => setData({ ...data, faqEnabled: e.target.checked })}
          className="h-4 w-4 accent-accent"
        />
      </label>

      <div className="space-y-1">
        <label className="text-sm font-medium text-foreground">
          {t("Knowledge base (plain text)")}
        </label>
        <textarea
          value={data.knowledgeBase}
          disabled={disabled}
          onChange={(e) => setData({ ...data, knowledgeBase: e.target.value })}
          rows={10}
          maxLength={20000}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
        />
        <p className="text-xs text-muted">
          {t(
            "Write what the bot may answer: prices, how to get the file, shipping, your usual questions. It never answers outside this text."
          )}
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-foreground">{t("Handoff message")}</label>
        <input
          value={data.handoffMessage}
          disabled={disabled}
          onChange={(e) => setData({ ...data, handoffMessage: e.target.value })}
          maxLength={500}
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
        />
        <p className="text-xs text-muted">
          {t(
            'Sent once when the bot cannot answer. The conversation is then marked "needs a human" and the bot stays quiet.'
          )}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted">
          {t("Max bot replies per person per hour")}
          <input
            type="number"
            min={1}
            max={20}
            value={data.hourlyLimitPerUser}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setData({ ...data, hourlyLimitPerUser: Math.min(20, Math.max(1, Math.round(n))) });
              }
            }}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
          />
        </label>
        <label className="space-y-1 text-xs text-muted">
          {t("Max reply length")}
          <input
            type="number"
            min={50}
            max={1000}
            value={data.maxReplyChars}
            disabled={disabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setData({ ...data, maxReplyChars: Math.min(1000, Math.max(50, Math.round(n))) });
              }
            }}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
          />
        </label>
        <label className="space-y-1 text-xs text-muted">
          {t("Friendly tone")} / {t("Professional tone")}
          <select
            value={data.tone === "professional" ? "professional" : "friendly"}
            disabled={disabled}
            onChange={(e) => setData({ ...data, tone: e.target.value })}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
          >
            <option value="friendly">{t("Friendly tone")}</option>
            <option value="professional">{t("Professional tone")}</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={disabled || saving}
          className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? t("Sending…") : t("Save AI settings")}
        </button>
        {notice && <span className="text-xs text-muted">{notice}</span>}
      </div>
    </section>
  );
}
