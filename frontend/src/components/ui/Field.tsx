"use client";

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

// Sunken in both themes (the page tone under a panel), with a visible ring on focus.
const CONTROL_CLASS =
  "block w-full rounded-[10px] border border-line-strong bg-ink/50 px-3.5 py-2 text-sm text-bone outline-none transition-[border-color,box-shadow] duration-fast placeholder:text-faint hover:border-faint focus:border-flare focus:ring-2 focus:ring-flare/20";

/**
 * The row grid every labelled control in a form shares: a muted label in a fixed right-aligned column on >= sm,
 * stacked full width below it. Anything that is not a plain input - an image picker, a group of buttons - should
 * render through this too, otherwise it starts at the panel edge while the inputs beside it start 140px in, which
 * is what made the launch form look crooked.
 */
export function FieldRow({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  const Tag = htmlFor ? "label" : "div";
  return (
    <Tag
      {...(htmlFor ? { htmlFor } : {})}
      className={`flex flex-col gap-1.5 sm:flex-row sm:gap-3 ${className ?? ""}`}
    >
      <span className="label w-full shrink-0 whitespace-nowrap sm:w-32 sm:pt-2 sm:text-right">{label}</span>
      <span className="min-w-0 flex-1">
        {children}
        {error ? (
          <span className="mt-1 block text-xs text-rose">{error}</span>
        ) : hint ? (
          <span className="mt-1 block text-xs text-subtle">{hint}</span>
        ) : null}
      </span>
    </Tag>
  );
}

/**
 * Labelled input with a hairline border; `mono` for identifiers (hashes, addresses), `numeric` for amounts
 * (tabular figures in the text face), `hint` under the control. Laid out on the shared `FieldRow` grid.
 */
export function Field({
  label,
  hint,
  error,
  mono = false,
  numeric = false,
  textarea = false,
  className,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  numeric?: boolean;
  textarea?: boolean;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement> &
  TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={`flex flex-col gap-1.5 sm:flex-row sm:gap-3 ${className ?? ""}`}>
      <span className="label w-full shrink-0 whitespace-nowrap sm:w-32 sm:pt-2 sm:text-right">{label}</span>
      <span className="min-w-0 flex-1">
        {textarea ? (
          <textarea
            className={`${CONTROL_CLASS} h-28 resize-y ${mono ? "mono text-xs" : ""}`}
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          />
        ) : (
          <input
            className={`${CONTROL_CLASS} ${mono ? "mono text-[13px]" : numeric ? "num" : ""}`}
            {...(rest as InputHTMLAttributes<HTMLInputElement>)}
          />
        )}
        {error ? (
          <span className="mt-1 block text-xs text-rose">{error}</span>
        ) : hint ? (
          <span className="mt-1 block text-xs text-subtle">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}
