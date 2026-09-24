"use client";

import { useT } from "@/i18n/provider";

/**
 * The template's fee split (PerkTemplates: devBps 5000, rewardsBps 2500, lpBps 1500, treasuryBps 500,
 * protocolBps 500). The 15% share is liquidity in general: the pool seed while on the curve, then the pool's LP fee,
 * paid to every position including the locked initial one. It is not the LP Grant.
 */
const SPLITS: ReadonlyArray<readonly [key: string, pct: number, colour: string]> = [
  ["fees.part.dev", 50, "bg-tangerine"],
  ["fees.part.rewards", 25, "bg-yolk"],
  ["fees.part.liquidity", 15, "bg-honey"],
  ["fees.part.treasury", 5, "bg-bone"],
  ["fees.part.protocol", 5, "bg-shell"],
];

/** The 1.00% total fee as a segmented bar: 50 / 25 / 15 / 5 / 5. */
export function FeeSplitBar() {
  const { t } = useT();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">{t("fees.total")}</span>
        <span className="num text-sm font-bold">1.00%</span>
      </div>
      <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-raised" role="img" aria-label={t("fees.aria")}>
        {SPLITS.map(([key, pct, colour]) => (
          <div key={key} className={`border-r-2 border-surface last:border-r-0 ${colour}`} style={{ width: `${pct}%` }} />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {SPLITS.map(([key, pct, colour]) => (
          <span key={key} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted">
            <span className={`h-2 w-2 rounded-full ${colour}`} aria-hidden />
            {t(key)}
            <span className="num text-subtle">{pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
