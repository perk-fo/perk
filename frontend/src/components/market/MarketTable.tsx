"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { LaunchSummary } from "@/lib/api-types";
import { progressBpsOf } from "@/lib/api-adapters";
import { Pill, launchStatusPill } from "@/components/ui/Pill";
import { formatAmount, formatNumber, formatPrice, signedPct } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";

/**
 * The market as a dense table (DEX-style): one row per launch, whole row clickable to its trading page.
 * Columns narrow away on small screens (price and 24h stay).
 */
export function MarketTable({ items, startRank = 1 }: { items: LaunchSummary[]; startRank?: number }) {
  const { t, locale } = useT();
  const router = useRouter();
  return (
    <div className="panel overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-[13px]">
          <thead>
            <tr className="eyebrow border-b border-line text-left text-[10px]">
              <th className="w-10 py-3 pl-5 pr-2 font-bold">#</th>
              <th className="px-2 py-3 font-bold">{t("trade.col.token")}</th>
              <th className="px-2 py-3 text-right font-bold">{t("trade.col.price")}</th>
              <th className="px-2 py-3 text-right font-bold">{t("trade.col.change")}</th>
              <th className="hidden px-2 py-3 text-right font-bold md:table-cell">{t("trade.col.volume")}</th>
              <th className="hidden px-2 py-3 text-right font-bold lg:table-cell">{t("trade.col.mcap")}</th>
              <th className="hidden px-2 py-3 text-right font-bold lg:table-cell">{t("trade.col.holders")}</th>
              <th className="hidden py-3 pl-2 pr-5 text-right font-bold sm:table-cell">{t("trade.col.stage")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => {
              const m = item.market;
              const change = signedPct(m.change24hBps, locale);
              const pill = launchStatusPill(item.status, t);
              const progress = Number(progressBpsOf(item)) / 100;
              const href = `/meme/${item.meme}`;
              return (
                <tr
                  key={item.meme}
                  onClick={() => router.push(href)}
                  className="group cursor-pointer border-b border-line transition-colors duration-fast last:border-0 hover:bg-yolk/[0.09]"
                >
                  <td className="num py-3 pl-5 pr-2 text-subtle">{startRank + i}</td>
                  <td className="px-2 py-3">
                    <Link href={href} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                      <LaunchAvatar hash={item.configHash} image={item.metadata?.image} status={item.status} size={38} title={item.name} />
                      <span className="min-w-0">
                        <span className="block max-w-[180px] truncate text-[14px] font-bold text-bone">{item.name || "…"}</span>
                        <span className="num flex items-center gap-1.5 text-xs text-subtle">
                          {item.symbol}
                          <span className="text-faint">/</span>
                          {item.quoteSymbol}
                          {item.lpGrantEnabled && <span className="rounded-full bg-amber/15 px-1.5 text-[11px] text-amber">LP Grant</span>}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="num px-2 py-3 text-right">
                    {m.lastPrice !== null && m.lastPrice > 0 ? <Subscripted text={formatPrice(m.lastPrice, locale)} /> : <span className="text-faint">—</span>}
                  </td>
                  <td
                    className={`num px-2 py-3 text-right ${
                      change.tone === "verdigris" ? "text-verdigris" : change.tone === "rose" ? "text-rose" : "text-subtle"
                    }`}
                  >
                    {m.tradeCount > 0 ? change.text : "—"}
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-bone md:table-cell">
                    {formatAmount(BigInt(m.volume24hQuote), item.quoteDecimals, { locale, maxFrac: 4 })}
                    <span className="ml-1 text-xs text-subtle">{item.quoteSymbol}</span>
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-bone lg:table-cell">
                    {m.marketCapQuote ? (
                      <>
                        {formatAmount(BigInt(m.marketCapQuote), item.quoteDecimals, { locale, maxFrac: 2 })}
                        <span className="ml-1 text-xs text-subtle">{item.quoteSymbol}</span>
                      </>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className="num hidden px-2 py-3 text-right text-muted lg:table-cell">
                    {formatNumber(m.holderCount, locale)}
                  </td>
                  <td className="hidden py-3 pl-2 pr-5 text-right sm:table-cell">
                    {item.status === 1 ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-20 overflow-hidden rounded-full bg-raised">
                          <span className="block h-full rounded-full bg-gradient-to-r from-yolk to-tangerine" style={{ width: `${Math.min(100, progress)}%` }} />
                        </span>
                        <span className="num w-10 text-right text-[13px] font-bold text-bone">{progress.toFixed(0)}%</span>
                      </span>
                    ) : (
                      <Pill tone={pill.tone}>{pill.label}</Pill>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
