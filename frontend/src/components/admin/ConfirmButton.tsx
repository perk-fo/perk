"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "@/i18n/provider";

/** A button that asks once more: the first press arms it for a few seconds, the second one acts. */
export function ConfirmButton({
  onConfirm,
  disabled,
  children,
  className,
}: {
  onConfirm: () => void;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
      className={`${
        armed
          ? "rounded-full border border-rose/50 text-rose transition-colors duration-fast hover:bg-rose/10"
          : "btn-ghost"
      } h-8 px-3.5 text-xs font-medium ${className ?? ""}`}
    >
      {armed ? t("admin.confirm") : children}
    </button>
  );
}
