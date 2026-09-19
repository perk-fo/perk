"use client";

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

const CONTROL_CLASS =
  "block w-full rounded-[10px] border border-bone/15 bg-transparent px-3 py-2 text-sm outline-none transition-colors duration-fast placeholder:text-bone/30 focus:border-flare/60";

/**
 * The row grid every labelled control in a form shares: a muted label in a fixed right-aligned column on >= sm,
 * stacked full width below it. Anything that is not a plain input - an image picker, a group of buttons - should
 * render through this too, otherwise it starts at the panel edge while the inputs beside it start 124px in, which
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
      <span className="label w-full shrink-0 whitespace-nowrap sm:w-28 sm:pt-2 sm:text-right">{label}</span>
      <span className="min-w-0 flex-1">
        {children}
        {error ? (
          <span className="mt-1 block text-xs text-rose">{error}</span>
        ) : hint ? (
          <span className="mt-1 block text-xs text-bone/50">{hint}</span>
        ) : null}
      </span>
    </Tag>
  );
}

/**
 * Labelled input with a hairline border; `mono` for hashes/addresses/amounts, `hint` under the control.
 * Laid out on the shared `FieldRow` grid.
 */
export function Field({
  label,
  hint,
  error,
  mono = false,
  textarea = false,
  className,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  textarea?: boolean;
  className?: string;
} & InputHTMLAttributes<HTMLInputElement> &
  TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <label className={`flex flex-col gap-1.5 sm:flex-row sm:gap-3 ${className ?? ""}`}>
      <span className="label w-full shrink-0 whitespace-nowrap sm:w-28 sm:pt-2 sm:text-right">{label}</span>
      <span className="min-w-0 flex-1">
        {textarea ? (
          <textarea
            className={`${CONTROL_CLASS} h-28 resize-y ${mono ? "num text-xs" : ""}`}
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
          />
        ) : (
          <input className={`${CONTROL_CLASS} ${mono ? "num text-[13px]" : ""}`} {...(rest as InputHTMLAttributes<HTMLInputElement>)} />
        )}
        {error ? (
          <span className="mt-1 block text-xs text-rose">{error}</span>
        ) : hint ? (
          <span className="mt-1 block text-xs text-bone/50">{hint}</span>
        ) : null}
      </span>
    </label>
  );
}
