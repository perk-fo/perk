"use client";

import Link from "next/link";
import { useState } from "react";
import type { LaunchSummary } from "@/lib/api-types";
import { curveConfigShape, curveStateShape } from "@/lib/api-adapters";
import { HashSeal } from "@/components/art/HashSeal";
import { CurveChart } from "@/components/art/CurveChart";
import { Pill, launchStatusPill } from "@/components/ui/Pill";
import { Skeleton } from "@/components/ui/Skeleton";
import { Kv } from "@/components/ui/Kv";
import { formatAmount, formatPrice } from "@/lib/format";
import { useT } from "@/i18n/provider";

/** Gallery card for one launch (home "trending", "my launches"): seal, name, status, curve or pool summary. */
export function LaunchCard({ item, href }: { item: LaunchSummary; href?: string }) {
  const { t, locale } = useT();
  const pill = launchStatusPill(item.status, t);
  const [hover, setHover] = useState(false);
  const decimals = item.quoteDecimals;
  const symbol = item.quoteSymbol;
  const curveConfig = curveConfigShape(item);
  const curveState = curveStateShape(item);
  const price = item.market.lastPrice;
  return (
    <Link
      href={href ?? `/meme/${item.meme}`}
      className="panel block h-full p-5"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-start gap-4">
        <HashSeal hash={item.configHash} moduleBitmap={BigInt(item.moduleBitmap)} size={56} className="shrink-0" hover={hover} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-xl leading-tight">{item.name || "…"}</div>
          <div className="num mt-0.5 text-xs text-bone/50">{item.symbol}</div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Pill tone="muted">{symbol}</Pill>
            <Pill tone={pill.tone}>{pill.label}</Pill>
            {item.lpGrantEnabled && <Pill tone="muted">LP Grant</Pill>}
          </div>
        </div>
        <div className="num shrink-0 text-right text-[12px] leading-tight text-bone/60">
          {price !== null && price > 0 ? (
            <>
              <div className="text-bone">{formatPrice(price, locale)}</div>
              <div className="mt-0.5 text-[11px]">{symbol}</div>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-4 text-bone">
        {item.status === 1 && curveConfig && curveState ? (
          <>
            <CurveChart
              minimal
              height={72}
              virtualQuote0={curveConfig.virtualQuoteReserve}
              virtualMeme0={curveConfig.virtualMemeReserve}
              threshold={curveConfig.graduationQuoteThreshold}
              realQuote={curveState.realQuote}
              quoteSymbol={symbol}
              formatQuote={(v) => formatAmount(v, decimals, { locale })}
            />
            <p className="label num mt-1">
              {t("home.card.raised", {
                raised: formatAmount(curveState.realQuote, decimals, { locale }),
                threshold: formatAmount(curveConfig.graduationQuoteThreshold, decimals, { locale }),
                symbol,
              })}
            </p>
          </>
        ) : item.status === 3 && item.poolId ? (
          <>
            <Kv label="Pool ID" value={item.poolId} copy />
            <p className="label num mt-1">
              {t("meme.market.volume24h")} {formatAmount(BigInt(item.market.volume24hQuote), decimals, { locale })} {symbol}
            </p>
          </>
        ) : item.status === 2 ? (
          <p className="text-sm text-flare">{t("home.card.pendingGrad")}</p>
        ) : (
          <Skeleton size={40} lines={1} />
        )}
      </div>
    </Link>
  );
}

