"use client";

import Link from "next/link";
import { useState } from "react";
import type { LaunchSummary } from "@/lib/api-types";
import { curveConfigShape, curveStateShape, progressBpsOf } from "@/lib/api-adapters";
import { CurveChart } from "@/components/art/CurveChart";
import { HashSeal } from "@/components/art/HashSeal";
import { TokenAvatar } from "@/components/meme/TokenAvatar";
import { Pill, launchStatusPill } from "@/components/ui/Pill";
import { formatAmount, formatPrice, fmtBps, shortHash } from "@/lib/format";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";

/**
 * Gallery card for one launch (home, featured, "my launches"): the token's image (or its seal), name, price, status,
 * and either the curve with its progress while bonding or the pool once graduated. The card lifts and the seal's
 * module ticks light up on hover.
 */
export function LaunchCard({ item, href }: { item: LaunchSummary; href?: string }) {
  const { t, locale } = useT();
  const pill = launchStatusPill(item.status, t);
  const [hover, setHover] = useState(false);
  const decimals = item.quoteDecimals;
  const symbol = item.quoteSymbol;
  const curveConfig = curveConfigShape(item);
  const curveState = curveStateShape(item);
  const price = item.market.lastPrice;
  const progress = Number(progressBpsOf(item));
  return (
    <Link
      href={href ?? `/meme/${item.meme}`}
      className="panel group flex h-full flex-col p-5"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-start gap-4">
        <span className="transition-transform duration-500 ease-spring group-hover:-rotate-6 group-hover:scale-105">
          <TokenAvatar
            image={item.metadata?.image}
            configHash={item.configHash}
            moduleBitmap={BigInt(item.moduleBitmap)}
            size={56}
            hover={hover}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[20px] leading-tight">{item.name || "…"}</div>
          <div className="num mt-0.5 font-mono text-[11px] tracking-wider text-subtle">{item.symbol}</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Pill tone={pill.tone}>{pill.label}</Pill>
            <Pill tone="muted">{symbol}</Pill>
            {item.lpGrantEnabled && <Pill tone="amber">LP Grant</Pill>}
          </div>
        </div>
        <div className="num shrink-0 text-right text-[13px] leading-tight text-muted">
          {price !== null && price > 0 ? (
            <>
              <div className="font-bold text-bone">
                <Subscripted text={formatPrice(price, locale)} />
              </div>
              <div className="mt-0.5 text-xs">{symbol}</div>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-5 flex-1 text-bone">
        {item.status === 1 && curveConfig && curveState ? (
          <>
            <CurveChart
              minimal
              height={64}
              virtualQuote0={curveConfig.virtualQuoteReserve}
              virtualMeme0={curveConfig.virtualMemeReserve}
              threshold={curveConfig.graduationQuoteThreshold}
              realQuote={curveState.realQuote}
              quoteSymbol={symbol}
              formatQuote={(v) => formatAmount(v, decimals, { locale })}
            />
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
              <div
                className="h-full rounded-full bg-gradient-to-r from-yolk to-tangerine transition-[width] duration-700 ease-out"
                style={{ width: `${Math.min(100, Math.max(2, progress / 100))}%` }}
              />
            </div>
            <p className="label num mt-2 flex justify-between gap-2">
              <span>
                {t("home.card.raised", {
                  raised: formatAmount(curveState.realQuote, decimals, { locale }),
                  threshold: formatAmount(curveConfig.graduationQuoteThreshold, decimals, { locale }),
                  symbol,
                })}
              </span>
              <span className="font-bold text-bone">{fmtBps(progress, locale)}</span>
            </p>
          </>
        ) : item.status === 3 && item.poolId ? (
          <div className="rounded-xl bg-raised px-3.5 py-3 text-[13px]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-subtle">Pool ID</span>
              <span className="mono text-[12px]">{shortHash(item.poolId)}</span>
            </div>
            <div className="num mt-1.5 flex items-baseline justify-between gap-3">
              <span className="text-subtle">{t("meme.market.volume24h")}</span>
              <span className="font-bold">
                {formatAmount(BigInt(item.market.volume24hQuote), decimals, { locale })} {symbol}
              </span>
            </div>
          </div>
        ) : item.status === 2 ? (
          <p className="rounded-xl bg-yolk/20 px-3.5 py-3 text-sm font-semibold">{t("home.card.pendingGrad")}</p>
        ) : null}
      </div>
      <span className="mt-4 flex items-center justify-between border-t border-line pt-3.5 text-[12px] font-bold text-muted transition-colors duration-fast group-hover:text-bone">
        {t("home.card.open")}
        <span aria-hidden className="nudge">
          ↗
        </span>
      </span>
    </Link>
  );
}

/** Placeholder while the list loads: the seal's outline and soft bars in the card's shape. */
export function LaunchCardSkeleton() {
  return (
    <div className="panel p-5" aria-hidden>
      <div className="flex items-center gap-4 text-bone">
        <HashSeal size={56} />
        <div className="flex-1 space-y-2.5">
          <div className="skel h-4 w-2/3" />
          <div className="skel h-3 w-1/3" />
        </div>
      </div>
      <div className="skel mt-6 h-16 w-full" />
      <div className="skel mt-4 h-2 w-full" />
    </div>
  );
}
