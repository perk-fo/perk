"use client";

import type { Address } from "viem";
import type { HolderRow } from "@/lib/holders";
import { formatAmount, formatNumber, shortAddress } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { LIST_PANEL_H } from "./TradeTable";

export function HolderList({
  holders,
  count,
  circulating,
  isLoading,
  memeDecimals,
  account,
}: {
  holders: HolderRow[];
  count: number;
  circulating: bigint;
  isLoading: boolean;
  memeDecimals: number;
  account?: Address;
}) {
  const { t, locale } = useT();
  const mine = account?.toLowerCase();

  return (
    <section className={`panel flex flex-col p-6 ${LIST_PANEL_H}`}>
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="label">{t("meme.holders.title")}</h2>
        <span className="num text-xs text-bone/50">{t("meme.holders.total", { n: formatNumber(count, locale) })}</span>
      </header>
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex justify-between">
                <div className="h-2 w-24 rounded-full border border-bone/10" />
                <div className="h-2 w-10 rounded-full border border-bone/10" />
              </div>
              <div className="h-1.5 rounded-full border border-bone/10" />
            </div>
          ))}
        </div>
      ) : holders.length === 0 ? (
        <p className="text-sm text-bone/50">{t("meme.holders.empty")}</p>
      ) : (
        <ol className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-1">
          {holders.map((row) => {
            const shareBps = circulating > 0n ? (row.balance * 10_000n) / circulating : 0n;
            const pct = Number(shareBps) / 100;
            const isMine = mine !== undefined && row.address.toLowerCase() === mine;
            return (
              <li key={row.address}>
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className={`num text-[13px] ${isMine ? "text-flare" : "text-bone/80"}`}>
                    {shortAddress(row.address)}
                  </span>
                  <span className="num text-[12px] text-bone/50">
                    {formatAmount(row.balance, memeDecimals, { locale, maxFrac: 2 })} · {pct.toFixed(2)}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-bone/10">
                  <div
                    className={`h-full rounded-full ${isMine ? "bg-flare/80" : "bg-bone/35"}`}
                    style={{ width: `${Math.min(100, Math.max(0.4, pct))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
