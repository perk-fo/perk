"use client";

import { useT } from "@/i18n/provider";

const SPLITS: ReadonlyArray<readonly [string, number]> = [
  ["Dev", 50],
  ["Quote Rewards", 25],
  ["LP Grant", 15],
  ["Treasury", 5],
  ["Protocol", 5],
];

/** The 1.00% total fee as a segmented hairline bar: 50 / 25 / 15 / 5 / 5. */
export function FeeSplitBar() {
  const { t } = useT();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="label">{t("fees.total")}</span>
        <span className="num text-sm">1.00%</span>
      </div>
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-bone/10" role="img" aria-label={t("fees.aria")}>
        {SPLITS.map(([label, pct]) => (
          <div
            key={label}
            className="border-r border-ink bg-bone/35 last:border-r-0"
            style={{ width: `${pct}%` }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {SPLITS.map(([label, pct]) => (
          <span key={label} className="label-en inline-flex items-baseline gap-1.5">
            {label}
            <span className="num text-[11px] text-bone/70">{pct}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
