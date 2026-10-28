"use client";

import { useI18n } from "@/lib/i18n/provider";
import type { AiConversationItem } from "@/app/api/ai/conversations/route";

/**
 * Inbox for a Facebook Page. Instagram's thread list cannot read Pages, so
 * this lists the conversations the FAQ bot has seen, each with its state and
 * a button to take over or hand the thread back to the bot. Replying itself
 * happens in Messenger / Meta Business Suite.
 */
export function PageAiThreads({
  threads,
  busy,
  onAction,
  badge: Badge,
}: {
  threads: AiConversationItem[];
  busy: boolean;
  onAction: (conversationId: string, action: "takeover" | "resume") => void;
  badge: (props: { status: AiConversationItem["status"] }) => React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded border border-border">
      <p className="border-b border-border px-4 py-3 text-xs text-muted">
        {t("Reply to Facebook Page customers in Messenger or Meta Business Suite. Here you can see each conversation's bot status and hand it back to the AI.")}
      </p>
      {threads.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted">{t("No conversations yet")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {threads.map((thread) => (
            <li key={thread.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {thread.senderName || thread.senderId}
                  </span>
                  <Badge status={thread.status} />
                </div>
                {thread.lastText && (
                  <p className="mt-0.5 truncate text-xs text-muted">{thread.lastText}</p>
                )}
                {thread.lastMessageAt && (
                  <p className="text-[10px] text-muted">{new Date(thread.lastMessageAt).toLocaleString()}</p>
                )}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => onAction(thread.id, thread.status === "AI" ? "takeover" : "resume")}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface-hover disabled:opacity-50"
              >
                {thread.status === "AI" ? t("Take over") : t("Hand back to AI")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
