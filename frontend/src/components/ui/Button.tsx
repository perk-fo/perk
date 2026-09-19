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
    "rounded-full border border-rose/60 text-rose transition-colors duration-fast hover:bg-rose/10 disabled:opacity-40",
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
      className={`w-full px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed ${VARIANT_CLASS[variant]} ${
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
