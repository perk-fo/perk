"use client";

import type { ButtonHTMLAttributes } from "react";
import type { Tx } from "@/lib/hooks";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/i18n/provider";

export type ButtonVariant = "primary" | "ghost" | "danger";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  ghost: "btn-ghost",
  danger:
    "rounded-xl border border-rose/50 bg-surface text-rose transition-[background-color,transform] duration-fast hover:-translate-y-0.5 hover:bg-rose/10 disabled:border-line disabled:text-faint disabled:hover:translate-y-0 disabled:hover:bg-transparent",
};

/**
 * Primary (flare) / ghost / danger button. Pass `tx` for a button that sends a transaction: while it is in flight
 * the button is disabled and says what is happening ("Pre-checking…", "Confirm in your wallet", "Confirming on
 * chain…") with a spinner. `pending` alone keeps the older moving-line style.
 */
export function Button({
  variant = "primary",
  pending = false,
  tx,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; pending?: boolean; tx?: Tx }) {
  const { t } = useT();
  const busy = !!tx && (tx.phase === "preparing" || tx.phase === "signing" || tx.phase === "confirming");
  return (
    <button
      type="button"
      className={`w-full px-4 py-3 text-sm font-bold disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${
        pending || busy ? "btn-pending" : ""
      } ${className ?? ""}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? (
        <span className="inline-flex items-center justify-center gap-2">
          <Spinner size={14} />
          {t(`tx.phase.${tx!.phase}`)}
        </span>
      ) : (
        children
      )}
    </button>
  );
}
