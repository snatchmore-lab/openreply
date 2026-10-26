"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";
import type { AccountOption } from "@/components/account-select";

interface AiSettingsData {
  faqEnabled: boolean;
  knowledgeBase: string;
  handoffMessage: string;
  hourlyLimitPerUser: number;
  tone: string;
  maxReplyChars: number;
  notifyEmail: string | null;
  scope: "workspace" | "account";
  inherited: boolean;
}

const WORKSPACE = "__workspace__";

/**
 * FAQ bot settings on the Settings page. The selector switches between the
 * workspace defaults and each connected Instagram account; an account with
 * no row of its own shows the defaults with an "inherits" note and gets its
 * own row the first time it is saved. Greyed out with a hint when the server
 * has no AI_API_KEY.
 */
export function AiSettings({ canManage }: { canManage: boolean }) {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [target, setTarget] = useState<string>(WORKSPACE);
  const [data, setData] = useState<AiSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [testQuestion, setTestQuestion] = useState("");
  const [testResult, setTestResult] = useState<{ kind: string; text?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  async function runTest() {
    if (!data || !testQuestion.trim()) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/faq-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: testQuestion.trim(),
          knowledgeBase: data.knowledgeBase,
          handoffMessage: data.handoffMessage,
          tone: data.tone === "professional" ? "professional" : "friendly",
          maxReplyChars: data.maxReplyChars,
        }),
      });
      const json = await res.json().catch(() => null);
      setTestResult(res.ok && json?.success ? json.data : { kind: "unavailable" });
    } catch {
      setTestResult({ kind: "unavailable" });
    } finally {
      setTesting(false);
    }
  }

  const load = useCallback(async (which: string) => {
    const qs = which === WORKSPACE ? "" : `?instagramAccountId=${encodeURIComponent(which)}`;
    const res = await fetch(`/api/ai/settings${qs}`);
    const json = await res.json().catch(() => null);
    if (res.ok && json?.data) setData(json.data as AiSettingsData);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/ai/status").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/instagram/accounts").then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([status, acc]) => {
        if (cancelled) return;
        setConfigured(Boolean(status?.data?.configured));
        const list: AccountOption[] = acc?.data?.instagramAccounts ?? [];
        setAccounts(list);
        // Default to the first account: that is what the bot actually uses.
        const first = list[0]?.id ?? WORKSPACE;
        setTarget(first);
        void load(first);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  function switchTarget(next: string) {
    setTarget(next);
    setNotice(null);
    setData(null);
    void load(next);
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    setNotice(null);
    try {
      const qs = target === WORKSPACE ? "" : `?instagramAccountId=${encodeURIComponent(target)}`;
      const res = await fetch(`/api/ai/settings${qs}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          faqEnabled: data.faqEnabled,
          knowledgeBase: data.knowledgeBase,
          handoffMessage: data.handoffMessage,
          hourlyLimitPerUser: data.hourlyLimitPerUser,
          tone: data.tone === "professional" ? "professional" : "friendly",
          maxReplyChars: data.maxReplyChars,
          notifyEmail: data.notifyEmail?.trim() ?? "",
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

  async function resetToWorkspace() {
    if (target === WORKSPACE) return;
    setSaving(true);
    setNotice(null);
    try {
      await fetch(`/api/ai/settings?instagramAccountId=${encodeURIComponent(target)}`, {
        method: "DELETE",
      });
      await load(target);
      setNotice(t("AI settings saved."));
    } finally {
      setSaving(false);
    }
  }

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

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-muted">{t("Settings for")}</label>
        <select
          value={target}
          onChange={(e) => switchTarget(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.username}
            </option>
          ))}
          <option value={WORKSPACE}>{t("Workspace defaults")}</option>
        </select>
        {data?.scope === "account" && data.inherited && (
          <span className="text-xs text-muted">
            {t("This account has no settings of its own yet and uses the workspace defaults. Saving creates its own.")}
          </span>
        )}
        {data?.scope === "account" && !data.inherited && canManage && (
          <button
            type="button"
            onClick={() => void resetToWorkspace()}
            disabled={saving}
            className="text-xs text-muted underline hover:text-foreground disabled:opacity-50"
          >
            {t("Use workspace defaults instead")}
          </button>
        )}
      </div>

      {!data ? (
        <p className="text-sm text-muted">{t("Loading…")}</p>
      ) : (
        <>
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

          <div className="space-y-1">
            <label className="text-sm font-medium text-foreground">{t("Email me when a human is needed")}</label>
            <input
              type="email"
              value={data.notifyEmail ?? ""}
              disabled={disabled}
              placeholder="name@example.com"
              onChange={(e) => setData({ ...data, notifyEmail: e.target.value })}
              maxLength={200}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
            />
            <p className="text-xs text-muted">
              {t("One email each time the bot hands a conversation to you, with the question. Leave empty for no email.")}
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

          <div className="space-y-2 rounded-lg border border-border p-3">
            <span className="text-sm font-medium text-foreground">{t("Test the bot")}</span>
            <p className="text-xs text-muted">
              {t("Ask a question to see how the bot would answer with the knowledge base above, saved or not. Nothing is sent to Instagram.")}
            </p>
            <div className="flex items-center gap-2">
              <input
                value={testQuestion}
                onChange={(e) => setTestQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runTest();
                }}
                maxLength={300}
                placeholder={t("e.g. Is the diary free?")}
                disabled={configured === false}
                className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => void runTest()}
                disabled={configured === false || testing || !testQuestion.trim()}
                className="shrink-0 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-surface disabled:opacity-50"
              >
                {testing ? t("Generating…") : t("Ask")}
              </button>
            </div>
            {testResult && (
              <div className="rounded-lg bg-surface px-3 py-2 text-sm">
                {testResult.kind === "unavailable" ? (
                  <span className="text-warning">{t("Preview failed. Check the server's AI settings and try again.")}</span>
                ) : (
                  <>
                    <span className={`mr-2 text-xs font-medium ${testResult.kind === "handoff" ? "text-warning" : "text-accent"}`}>
                      {testResult.kind === "handoff" ? t("Hands off to you") : t("Answers")}
                    </span>
                    <span className="text-foreground">{testResult.text}</span>
                  </>
                )}
              </div>
            )}
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
        </>
      )}
    </section>
  );
}
