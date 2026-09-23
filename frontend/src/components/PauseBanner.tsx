"use client";

import { usePauseFlags, PAUSE_ORDER } from "@/lib/pause";
import { useT } from "@/i18n/provider";

/** A slim bar under the header while any area is paused, saying what is paused and that exits still work. */
export function PauseBanner() {
  const { t } = useT();
  const pause = usePauseFlags();
  if (!pause.any) return null;
  const areas = PAUSE_ORDER.filter((a) => pause.isPaused(a))
    .map((a) => t(`pause.area.${a}`))
    .join(", ");
  return (
    <div className="border-b border-amber/25 bg-amber/[0.07]" role="status">
      <div className="mx-auto flex w-full max-w-page items-center gap-2.5 px-4 py-2 text-sm text-bone sm:px-6">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" aria-hidden />
        {t("pause.banner", { areas })}
      </div>
    </div>
  );
}
