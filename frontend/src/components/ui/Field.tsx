"use client";

import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

const CONTROL_CLASS =
  "block w-full rounded-[10px] border border-bone/15 bg-transparent px-3 py-2 text-sm outline-none transition-colors duration-fast placeholder:text-bone/30 focus:border-flare/60";

/**
 * Labelled input with a hairline border; `mono` for hashes/addresses/amounts, `hint` under the control.
 * Layout: the muted label sits in a fixed `w-28` right-aligned column on ≥ sm, stacked full-width below.
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
