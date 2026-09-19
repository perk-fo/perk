"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useReadContract } from "wagmi";
import { isAddress, type Address } from "viem";
import { useDeployment, useTabVisible } from "@/lib/hooks";
import { useLaunchDetail } from "@/lib/api-hooks";
import { graduationManagerAbi } from "@/generated/abis";
import { Panel } from "@/components/ui/Panel";
import { Kv } from "@/components/ui/Kv";
import { Notice } from "@/components/ui/Notice";
import { Skeleton } from "@/components/ui/Skeleton";
import { HashSeal } from "@/components/art/HashSeal";
import { LiquidityPanel } from "@/components/meme/LiquidityPanel";
import type { PoolKey } from "@/lib/pool";
import { formatAmount, formatPrice } from "@/lib/format";
import { useT } from "@/i18n/provider";

/** One pool: what it is on the left, adding and managing your own liquidity on the right. */
export default function PoolDetailPage() {
  const params = useParams<{ address: string }>();
  const { t, locale } = useT();
  const visible = useTabVisible();
  const { deployment } = useDeployment();
  const valid = isAddress(params.address);
  const meme = params.address as Address;

  const detail = useLaunchDetail(valid ? meme : undefined);
  const d = detail.data;
  const graduated = d?.status === 3;

  // the pool key lives on chain with the graduation record; everything descriptive comes from the API
  const graduationOnchain = useReadContract({
    address: deployment?.graduationManager,
    abi: graduationManagerAbi,
    functionName: "graduationOf",
    args: [meme],
    query: { enabled: !!deployment && valid && graduated, refetchInterval: visible ? 30_000 : false },
  });
  const poolKey = graduationOnchain.data?.key as PoolKey | undefined;
  const seededPrice = graduationOnchain.data?.sqrtPriceX96 as bigint | undefined;

  if (!valid || detail.notFound) {
    return (
      <Notice tone="rose" title={t("pool.title")}>
        {t("meme.notFound")}
      </Notice>
    );
  }
  if (!d) {
    return (
      <Panel>
        <Skeleton size={40} lines={6} />
      </Panel>
    );
  }

  const g = d.graduation;
  const m = d.market;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <HashSeal hash={d.configHash} moduleBitmap={BigInt(d.moduleBitmap)} size={48} className="shrink-0" />
          <div>
            <h1 className="font-display text-3xl leading-none">
              {d.symbol} <span className="text-bone/30">/</span> {d.quoteSymbol}
            </h1>
            <p className="mt-1.5 text-sm text-bone/55">{d.name}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/pool" className="text-bone/55 transition-colors duration-fast hover:text-bone">
            ← {t("pool.back")}
          </Link>
          <Link href={`/meme/${meme}`} className="text-flare underline decoration-flare/40 underline-offset-4">
            {t("pool.toTrade")} →
          </Link>
        </div>
      </header>

      {!graduated ? (
        <Notice tone="amber" title={t("pool.notGraduatedTitle")}>
          {t("pool.notGraduatedBody")}{" "}
          <Link href={`/meme/${meme}`} className="underline decoration-dotted underline-offset-4">
            {t("pool.toTrade")} →
          </Link>
        </Notice>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-12">
          <div className="min-w-0 space-y-6 lg:col-span-7">
            <Panel title={t("pool.facts.title")}>
              <div className="divide-y divide-bone/6">
                <Kv
                  label={t("trade.col.price")}
                  value={
                    m.lastPrice !== null && m.lastPrice > 0 ? `${formatPrice(m.lastPrice, locale)} ${d.quoteSymbol}` : "—"
                  }
                />
                <Kv
                  label={t("trade.col.volume")}
                  value={`${formatAmount(BigInt(m.volume24hQuote), d.quoteDecimals, { locale, maxFrac: 4 })} ${d.quoteSymbol}`}
                />
                <Kv label={t("pool.col.fee")} value={d.curve ? `${(d.curve.totalFeeBps / 100).toFixed(2)}%` : "—"} />
                {g && (
                  <>
                    <Kv
                      label={t("meme.pool.memeIn")}
                      value={`${formatAmount(BigInt(g.memeToPool), d.decimals, { locale, maxFrac: 2 })} ${d.symbol}`}
                    />
                    <Kv
                      label={t("meme.pool.quoteIn")}
                      value={`${formatAmount(BigInt(g.quoteToPool), d.quoteDecimals, { locale })} ${d.quoteSymbol}`}
                    />
                  </>
                )}
              </div>
            </Panel>

            <Panel title={t("pool.how.title")}>
              <ul className="space-y-2 text-sm leading-relaxed text-bone/65">
                <li>{t("pool.how.own")}</li>
                <li>{t("pool.how.range")}</li>
                <li>{t("pool.how.risk")}</li>
              </ul>
              <p className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-bone/8 pt-4 text-sm text-bone/55">
                <span>{t("pool.how.grant")}</span>
                <Link
                  href={d.lpGrantEnabled ? `/grant/${meme}` : "/grant"}
                  className="shrink-0 text-flare underline decoration-flare/40 underline-offset-4"
                >
                  {t("nav.grant")} →
                </Link>
              </p>
            </Panel>
          </div>

          <div className="min-w-0 lg:col-span-5">
            {poolKey ? (
              <LiquidityPanel
                meme={meme}
                poolKey={poolKey}
                sqrtPriceX96={g?.sqrtPriceX96 ? BigInt(g.sqrtPriceX96) : (seededPrice ?? null)}
                memeSymbol={d.symbol}
                memeDecimals={d.decimals}
                quoteSymbol={d.quoteSymbol}
                quoteDecimals={d.quoteDecimals}
              />
            ) : (
              <Panel>
                <Skeleton size={36} lines={5} />
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
