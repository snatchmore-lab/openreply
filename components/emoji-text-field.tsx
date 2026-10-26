"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/provider";

// A short, hand-picked set that suits creator DMs and comment replies.
const EMOJIS = [
  "😊", "🥰", "😍", "😆", "🤣", "😉", "😘", "🥹",
  "🤗", "🙏", "👏", "🙌", "💪", "👍", "✌️", "👀",
  "💌", "📩", "💬", "📌", "🎁", "🔥", "✨", "🌟",
  "🌙", "☀️", "🌈", "🌸", "🌷", "🍀", "☕", "💤",
  "😴", "🛌", "📖", "📝", "⏰", "✅", "💯", "🎉",
  "💛", "🧡", "💚", "💙", "💜", "🤍", "❤️", "🫶",
];

const FIELD_CLASS =
  "w-full rounded-lg border border-border bg-surface py-2 pl-3 pr-10 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none";

/**
 * A text box (or one-line input) with an emoji button that inserts at the
 * cursor. The owner's text is otherwise untouched: line breaks and spacing
 * stay exactly as typed.
 */
export default function EmojiTextField({
  value,
  onChange,
  multiline = false,
  rows = 3,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  maxLength?: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Where the cursor was when the field last had focus; clicking the emoji
  // button moves focus away, so read it from here.
  const caret = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const field = () => (multiline ? areaRef.current : inputRef.current);

  const rememberCaret = () => {
    const el = field();
    if (el) caret.current = { start: el.selectionStart ?? value.length, end: el.selectionEnd ?? value.length };
  };

  const insert = (emoji: string) => {
    const start = Math.min(caret.current?.start ?? value.length, value.length);
    const end = Math.min(caret.current?.end ?? value.length, value.length);
    const next = value.slice(0, start) + emoji + value.slice(end);
    if (maxLength && next.length > maxLength) return;
    onChange(next);
    const pos = start + emoji.length;
    caret.current = { start: pos, end: pos };
    requestAnimationFrame(() => {
      const el = field();
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const common = {
    value,
    placeholder,
    maxLength,
    onSelect: rememberCaret,
    onKeyUp: rememberCaret,
    onClick: rememberCaret,
    onBlur: rememberCaret,
  };

  return (
    <div ref={wrapRef} className="relative">
      {multiline ? (
        <textarea
          ref={areaRef}
          {...common}
          rows={rows}
          onChange={(e) => onChange(e.target.value)}
          className={`${FIELD_CLASS} resize-none`}
        />
      ) : (
        <input
          ref={inputRef}
          {...common}
          onChange={(e) => onChange(e.target.value)}
          className={FIELD_CLASS}
        />
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("Insert emoji")}
        aria-expanded={open}
        title={t("Insert emoji")}
        className="absolute right-2 top-1.5 rounded-md px-1.5 py-0.5 text-base leading-none opacity-70 hover:bg-white/5 hover:opacity-100"
      >
        😊
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("Insert emoji")}
          className="absolute right-0 top-full z-30 mt-1 grid w-[17rem] grid-cols-8 gap-0.5 rounded-lg border border-border bg-surface p-2 shadow-lg"
        >
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => insert(emoji)}
              className="rounded-md p-1 text-lg leading-none hover:bg-white/10"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
