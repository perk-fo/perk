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
    <div className="border-b border-honey/60 bg-yolk/30" role="status">
      <div className="mx-auto flex w-full max-w-page items-center gap-2.5 px-4 py-2 text-sm font-semibold text-bone sm:px-8">
        <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-tangerine" aria-hidden />
        {t("pause.banner", { areas })}
      </div>
    </div>
  );
}
