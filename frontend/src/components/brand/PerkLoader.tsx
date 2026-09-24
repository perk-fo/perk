"use client";

import { PerkChick } from "./PerkChick";
import { useT } from "@/i18n/provider";

/**
 * The loading state for a page or a large panel: the chick hatching on a loop. It announces itself to screen readers
 * once ("Loading"), and holds a steady height so the page does not jump when the content arrives.
 */
export function PerkLoader({
  label,
  size = 72,
  className,
  minHeight = 260,
}: {
  label?: string;
  size?: number;
  className?: string;
  minHeight?: number;
}) {
  const { t } = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center gap-3 text-center ${className ?? ""}`}
      style={{ minHeight }}
    >
      <PerkChick size={size} mode="loading" />
      <span className="eyebrow">{label ?? t("common.loading")}</span>
    </div>
  );
}
