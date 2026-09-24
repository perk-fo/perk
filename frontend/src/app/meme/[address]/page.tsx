"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { isAddress, type Address } from "viem";
import { feeRouterAbi, graduationManagerAbi, holderRewardDistributorAbi } from "@/generated/abis";
import { useDeployment, useTabVisible, useTx } from "@/lib/hooks";
import { useApiHolders, useApiTrades, useHealth, useLaunchDetail } from "@/lib/api-hooks";
import { API_URL, isApiUnreachable } from "@/lib/api";
import {
  curveConfigShape,
  curveStateShape,
  graduationShape,
  launchShape,
  marketStatsShape,
  progressBpsOf,
} from "@/lib/api-adapters";
import { NATIVE_QUOTE } from "@/lib/deployments";
import { templateLabel } from "@/lib/templates";
import { findQuote, useQuotes, type QuoteInfo } from "@/lib/quotes";
import { amountToNumber, tradePriceNumber } from "@/lib/trades";
import {
  formatAmount,
  formatCompact,
  formatNumber,
  formatPrice,
  fmtBps,
  fmtTime,
  shortHash,
  signedPct,
} from "@/lib/format";
import { explorerAddressUrl } from "@/lib/chains";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { LaunchTraits } from "@/components/meme/LaunchTraits";
import { CurveChart } from "@/components/art/CurveChart";
import { PriceChart } from "@/components/art/PriceChart";
import { Panel } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { Pill, launchStatusPill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { Kv } from "@/components/ui/Kv";
import { ModuleBlocks } from "@/components/ui/ModuleBlocks";
import { FeeSplitBar } from "@/components/ui/FeeSplitBar";
import { TxStatus } from "@/components/TxStatus";
import { OrderPanel, type PoolKeyShape } from "@/components/meme/OrderPanel";
import { TradeTable } from "@/components/meme/TradeTable";
import { HolderList } from "@/components/meme/HolderList";
import { RefundPanel } from "@/components/meme/RefundPanel";
import { usePauseFlags } from "@/lib/pause";
import { RoleGate } from "@/components/RoleGate";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";
import { PerkLoader } from "@/components/brand/PerkLoader";

const TRADE_PAGE = 20;

function Tile({
  label,
  value,
  tone,
  wrap,
}: {
  label: string;
  value: React.ReactNode;
  tone?: "verdigris" | "rose" | null;
  /** Let a long value (price with subscript zeros + symbol) break onto a second line instead of truncating. */
  wrap?: boolean;
}) {
  return (
    <div className="min-w-0 border-b border-r border-line px-4 py-3 lg:border-b-0">
      <div className="label truncate">{label}</div>
      <div
        className={`num mt-1 text-[16px] font-extrabold tracking-tight ${wrap ? "break-words leading-snug" : "truncate"} ${
          tone === "verdigris" ? "text-verdigris" : tone === "rose" ? "text-rose" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function MemePageSkeleton() {
  return <PerkLoader minHeight={520} />;
}

function curveSpot(
  virtualQuote: bigint | undefined,
  virtualMeme: bigint | undefined,
  quoteDecimals: number,
  memeDecimals: number,
): number | undefined {
  if (!virtualQuote || !virtualMeme || virtualMeme === 0n) return undefined;
  const q = amountToNumber(virtualQuote, quoteDecimals);
  const m = amountToNumber(virtualMeme, memeDecimals);
  if (!m) return undefined;
  return q / m;
}

export default function MemePage() {
  const params = useParams<{ address: string }>();
  const meme = params.address as Address;
  const validAddress = isAddress(meme);

  const { chainId, deployment } = useDeployment();
  const { address: account } = useAccount();
  const { quotes } = useQuotes();
  const { t, locale } = useT();
  const visible = useTabVisible();
  const [chartMode, setChartMode] = useState<"price" | "curve">("price");

  // Everything descriptive comes from the indexer in one call; the chain is only asked for per-user state.
  const detail = useLaunchDetail(validAddress ? meme : undefined);
  const health = useHealth();
  const d = detail.data;
  const launch = useMemo(() => (d ? launchShape(d) : undefined), [d]);
  const curveConfig = useMemo(() => (d ? curveConfigShape(d) : undefined), [d]);
  const curveState = useMemo(() => (d ? curveStateShape(d) : undefined), [d]);
  const progressBps = d ? progressBpsOf(d) : undefined;
  const graduation = useMemo(() => (d ? graduationShape(d) : undefined), [d]);
  const memeName = d?.name;
  const memeSymbol = d?.symbol ?? "MEME";
  const memeDecimals = d?.decimals ?? 18;
  const totalSupply = d?.totalSupply ? BigInt(d.totalSupply) : undefined;

  const { data: onchain } = useReadContracts({
    contracts: [
      { address: deployment?.feeRouter, abi: feeRouterAbi, functionName: "launchFees", args: [meme] },
      {
        address: deployment?.graduationManager,
        abi: graduationManagerAbi,
        functionName: "graduationOf",
        args: [meme],
      },
    ],
    query: { enabled: !!deployment && validAddress && !!d, refetchInterval: visible ? 15_000 : false },
  });
  const launchFees = onchain?.[0]?.result;
  const graduationOnchain = onchain?.[1]?.result;
  const graduationStage = Number((graduationOnchain as { stage?: number } | undefined)?.stage ?? 0);
  // a rescue proposed for a launch stuck before its pool: when refunds may start (0 when none is pending)
  const rescueAt = Number((graduationOnchain as { rescueExecutableAt?: bigint } | undefined)?.rescueExecutableAt ?? 0n);
  const pause = usePauseFlags();

  const quoteMeta: QuoteInfo | undefined = useMemo(() => {
    const q = findQuote(quotes, launch?.quote as Address | undefined);
    if (q || !launch) return q;
    const addr = launch.quote as Address;
    const isNative = addr.toLowerCase() === NATIVE_QUOTE.toLowerCase();
    return {
      address: addr,
      isNative,
      symbol: isNative ? "OKB" : "ERC20",
      decimals: 18,
      enabled: true,
      rewardCompatible: true,
      category: isNative ? "native" : "rwa",
      displayName: null,
      iconUrl: null,
      notice: {},
      listed: true,
      activeTemplates: null,
    };
  }, [quotes, launch]);

  const status = launch?.status ?? 0;
  const graduated = status === 3;
  const poolKey = graduated ? (graduationOnchain?.key as PoolKeyShape | undefined) : undefined;

  const { trades, isLoading: tradesLoading } = useApiTrades(validAddress && d ? meme : undefined, 200);
  const holders = useApiHolders(validAddress && d ? meme : undefined, 10);
  const stats = useMemo(() => marketStatsShape(d?.market), [d]);

  const claimable = useReadContract({
    address: deployment?.distributor,
    abi: holderRewardDistributorAbi,
    functionName: "claimableQuoteRewards",
    args: account ? [meme, account] : undefined,
    query: { enabled: !!deployment && !!account && validAddress, refetchInterval: visible ? 12_000 : false },
  });

  const graduateTx = useTx();
  const claimTx = useTx();
  const devTx = useTx();

  const quoteDecimals = quoteMeta?.decimals ?? 18;
  const quoteSymbol = quoteMeta?.symbol ?? "OKB";

  const lastPrice = useMemo(() => {
    if (stats.hasPrice && stats.lastPriceMeme > 0n) {
      const q = amountToNumber(stats.lastPriceQuote, quoteDecimals);
      const m = amountToNumber(stats.lastPriceMeme, memeDecimals);
      if (m) return q / m;
    }
    return curveSpot(curveState?.virtualQuote, curveState?.virtualMeme, quoteDecimals, memeDecimals);
  }, [stats, quoteDecimals, memeDecimals, curveState]);

  const change = signedPct(stats.changeBps, locale);
  const chartTrades = useMemo(
    () =>
      trades
        .filter((tr) => tr.timestamp > 0)
        .map((tr) => ({
          ts: tr.timestamp,
          price: tradePriceNumber(tr, quoteDecimals, memeDecimals),
          quoteVolume: amountToNumber(tr.quoteAmount, quoteDecimals),
          side: tr.side,
          mine: !!account && tr.wallet.toLowerCase() === account.toLowerCase(),
        }))
        .sort((a, b) => a.ts - b.ts),
    [trades, quoteDecimals, memeDecimals, account],
  );

  const showCurve = status === 1 || status === 2;
  const effectiveChart = graduated || !showCurve ? "price" : chartMode;

  if (!validAddress) {
    return (
      <Notice tone="rose" title={t("common.addressTitle")}>
        {t("common.invalidAddress")}
      </Notice>
    );
  }
  if (!deployment) {
    return (
      <Notice tone="amber" title={t("common.networkTitle")}>
        {t("common.noDeployment")}
      </Notice>
    );
  }
  if (isApiUnreachable(detail.error)) {
    return (
      <Notice tone="rose" title={t("home.api.downTitle")}>
        {t("home.api.downBody", { url: API_URL })}
      </Notice>
    );
  }
  if (detail.notFound) {
    const lag = health.data?.lagBlocks ?? 0;
    return (
      <Notice tone={lag > 0 ? "amber" : "rose"} title={t("meme.launchTitle")}>
        {lag > 0 ? t("meme.api.pending", { n: formatNumber(lag, locale) }) : t("meme.notFound")}
      </Notice>
    );
  }
  if (!launch || !d) return <MemePageSkeleton />;

  const statusPill = launchStatusPill(status, t);
  // two return values → viem gives a tuple [quote, quoteAmount], not an object
  const claimableAmount = (claimable.data as readonly [Address, bigint] | undefined)?.[1];
  const progressLabel =
    status === 3
      ? t("meme.market.graduatedPool", { id: shortHash(launch.poolId) })
      : fmtBps(progressBps ?? 0n, locale);
  const totalFeeBps = curveConfig?.totalFeeBps ?? 100;
  // withheld by the API while admins hide it (d.moderation)
  const media = d.metadata;
  const mediaLinks = media ? (Object.entries(media.links).filter(([, v]) => !!v) as Array<[string, string]>) : [];

  return (
    <div className="space-y-12 pt-6 sm:pt-8">
      <Link href="/trade" className="group eyebrow -mb-6 inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.2em] hover:text-bone">
        <span aria-hidden className="transition-transform duration-300 ease-spring group-hover:-translate-x-1">←</span>
        {t("nav.trade")}
      </Link>
      <header className="fade-up flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className="flex min-w-0 items-start gap-5 lg:max-w-[42%]">
          {/* the launch in its egg; until it hatches, an X-ray lens shows what is inside */}
          <div className="flex shrink-0 flex-col items-center">
            <LaunchAvatar hash={launch.configHash} image={media?.image} status={launch.status} size={104} mode="detail" title={memeName} />
            {launch.status !== 3 && (
              <p className="mt-1 max-w-[120px] text-center text-[10px] leading-tight text-subtle">{t("meme.avatar.xrayHint")}</p>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-[34px] leading-tight sm:text-[42px]">{memeName ?? "…"}</h1>
            <div className="num mt-1 font-mono text-[12px] tracking-wider text-subtle">{memeSymbol}</div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Pill tone="muted">{quoteSymbol}</Pill>
              <Pill tone={statusPill.tone}>{statusPill.label}</Pill>
              {launch.lpGrantEnabled && (
                <Link
                  href={`/grant/${meme}`}
                  className="inline-flex items-center rounded-full bg-amber/10 px-2.5 py-0.5 text-xs font-medium leading-5 text-amber transition-colors duration-fast hover:bg-amber/20"
                >
                  LP Grant →
                </Link>
              )}
            </div>
            <LaunchTraits hash={launch.configHash} hasArt={!!media?.image} className="mt-2" />
            {media?.description && (
              <p className="mt-3 line-clamp-3 max-w-prose break-words text-sm leading-relaxed text-muted" title={media.description}>
                {media.description}
              </p>
            )}
            {mediaLinks.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-1.5">
                {mediaLinks.map(([k, v]) => (
                  <a
                    key={k}
                    href={v}
                    target="_blank"
                    rel="noopener noreferrer nofollow ugc"
                    className="rounded-full bg-raised px-2.5 py-0.5 text-xs font-medium leading-5 text-muted transition-colors duration-fast hover:text-bone"
                  >
                    {t(`meme.link.${k}`)} ↗
                  </a>
                ))}
              </p>
            )}
          </div>
        </div>
        <div className="panel grid min-w-0 flex-1 grid-cols-2 overflow-hidden sm:grid-cols-3 lg:grid-cols-6 [&>*:last-child]:border-r-0">
          <Tile
            label={t("meme.market.price")}
            value={lastPrice !== undefined ? <><Subscripted text={formatPrice(lastPrice, locale)} /> {quoteSymbol}</> : "—"}
            wrap
          />
          <Tile label={t("meme.market.change24h")} value={change.text} tone={change.tone} />
          <Tile
            label={t("meme.market.mcap")}
            value={
              stats.mcapQuote > 0n
                ? `${formatAmount(stats.mcapQuote, quoteDecimals, { locale, maxFrac: 2 })} ${quoteSymbol}`
                : "—"
            }
            wrap
          />
          <Tile
            label={t("meme.market.volume24h")}
            value={`${formatAmount(stats.volume24h, quoteDecimals, { locale, maxFrac: 6 })} ${quoteSymbol}`}
            wrap
          />
          <Tile
            label={t("meme.market.holders")}
            value={holders.isLoading ? "—" : formatNumber(holders.count, locale)}
          />
          <Tile label={t("meme.market.progress")} value={progressLabel} wrap />
        </div>
      </header>

      {d.moderation && (
        <Notice tone="amber">{t(d.moderation.hidden ? "meme.moderation.hidden" : "meme.moderation.media")}</Notice>
      )}

      {status === 2 && rescueAt > 0 && (
        <Notice tone="amber">
          {t("meme.rescue.proposed", { time: fmtTime(rescueAt, locale), symbol: quoteSymbol })}
        </Notice>
      )}

      <Panel title={t("meme.facts.title")}>
        <div className="grid gap-x-10 sm:grid-cols-2">
          <div className="divide-y divide-line">
            <Kv label={t("meme.facts.template")} value={templateLabel(launch.templateId, quotes)} />
            <Kv label="Hook" value={deployment.hook} copy href={explorerAddressUrl(chainId, deployment.hook)} />
            <Kv label={t("meme.facts.hookVersion")} value={String(launch.hookVersion)} />
            <Kv label={t("meme.facts.createdAt")} value={fmtTime(launch.createdAt, locale)} />
          </div>
          <div className="divide-y divide-line">
            <Kv label="configHash" value={launch.configHash} copy />
            <Kv label={t("meme.facts.memeContract")} value={meme} copy href={explorerAddressUrl(chainId, meme)} />
            {status === 3 && (
              <Kv label="Pool ID" value={launch.poolId} copy href={explorerAddressUrl(chainId, deployment.poolManager)} />
            )}
            <div className="flex items-start justify-between gap-4 py-1.5">
              <span className="label shrink-0 pt-px">{t("common.modules")}</span>
              <ModuleBlocks bitmap={launch.moduleBitmap} />
            </div>
          </div>
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Panel className="flex h-full flex-col">
            {showCurve && (
              <div className="mb-4 flex w-fit gap-0.5 rounded-full bg-raised p-1">
                {(["price", "curve"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={effectiveChart === m}
                    onClick={() => setChartMode(m)}
                    className={`rounded-full px-3.5 py-1 text-[13px] transition-colors duration-fast ${
                      effectiveChart === m ? "bg-knob font-medium text-bone shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-bone"
                    }`}
                  >
                    {m === "price" ? t("meme.chart.price") : t("meme.chart.curve")}
                  </button>
                ))}
              </div>
            )}
            {/* both modes live in the same fixed-height block so toggling never moves the layout */}
            <div className="h-[344px]">
            {effectiveChart === "curve" && curveConfig && curveState ? (
              <div className="text-bone">
                <CurveChart
                  height={344}
                  virtualQuote0={curveConfig.virtualQuoteReserve}
                  virtualMeme0={curveConfig.virtualMemeReserve}
                  threshold={curveConfig.graduationQuoteThreshold}
                  realQuote={curveState.realQuote}
                  quoteSymbol={quoteSymbol}
                  formatQuote={(v) => formatAmount(v, quoteDecimals, { locale })}
                />
              </div>
            ) : (
              <PriceChart
                trades={chartTrades}
                height={300}
                quoteSymbol={quoteSymbol}
                labels={{
                  empty: t("chart.empty"),
                  emptyRange: t("chart.emptyRange"),
                  volume: t("chart.volume"),
                  ranges: {
                    "1h": t("chart.range.1h"),
                    "24h": t("chart.range.24h"),
                    "7d": t("chart.range.7d"),
                    all: t("chart.range.all"),
                  },
                  myBuy: t("chart.myBuy"),
                  mySell: t("chart.mySell"),
                }}
              />
            )}
            </div>

            {showCurve && curveConfig && curveState && (
              <div className="mt-auto pt-6 grid gap-x-10 gap-y-6 sm:grid-cols-3">
                <Stat
                  label={t("meme.curve.raised")}
                  value={formatAmount(curveState.realQuote, quoteDecimals, { locale })}
                  unit={quoteSymbol}
                  size="md"
                />
                <Stat
                  label={t("meme.curve.threshold")}
                  value={formatAmount(curveConfig.graduationQuoteThreshold, quoteDecimals, { locale })}
                  unit={quoteSymbol}
                  size="md"
                />
                <Stat label={t("meme.curve.progress")} value={fmtBps(progressBps ?? 0n, locale)} tone="flare" size="md" />
              </div>
            )}

            {status === 3 && graduation && (
              <div className="mt-auto pt-6 divide-y divide-line">
                <Kv label={t("meme.pool.memeIn")} value={formatAmount(graduation.memeToPool, memeDecimals, { locale })} />
                <Kv
                  label={t("meme.pool.quoteIn")}
                  value={`${formatAmount(graduation.quoteToPool, quoteDecimals, { locale })} ${quoteSymbol}`}
                />
                <div className="flex items-center justify-between py-3 text-sm">
                  <span className="text-muted">{t("pool.cta.body")}</span>
                  <Link
                    href={`/pool/${meme}`}
                    className="shrink-0 rounded-full bg-flare/10 px-3.5 py-1.5 text-[13px] font-medium text-flare transition-colors duration-fast hover:bg-flare/20"
                  >
                    {t("pool.lp.title")} →
                  </Link>
                </div>
              </div>
            )}
          </Panel>
        </div>

        <div className="min-w-0 lg:col-span-4">
          {status === 2 && (
            <Panel title={t("meme.graduate.title")} className="lg:sticky lg:top-20">
              <p className="text-sm text-muted">{t("meme.graduate.body")}</p>
              <div className="mt-4">
                <Button
                  tx={graduateTx}
                  disabled={graduateTx.isPending || graduateTx.isConfirming || pause.isPaused("graduation")}
                  onClick={() =>
                    graduateTx.write({
                      address: deployment.graduationManager,
                      abi: graduationManagerAbi,
                      functionName: "graduate",
                      args: [meme],
                      // graduate() swallows a failing stage, so the wallet's estimate only covers the path up to
                      // the failure and the last stage runs out of gas. Give it room explicitly.
                      gas: 6_000_000n,
                    })
                  }
                >
                  {pause.isPaused("graduation") ? t("pause.cta.graduation") : t("meme.graduate.cta")}
                </Button>
                <TxStatus
                  tx={graduateTx}
                  successTone={graduationStage === 4 ? "verdigris" : "amber"}
                  successText={
                    // The transaction succeeding and the launch graduating are different things: graduate() mines
                    // even when a stage fails inside it. Report the stage the chain is actually at.
                    graduationStage === 4
                      ? t("meme.graduate.success")
                      : t("meme.graduate.stalled", { n: graduationStage, of: 4 })
                  }
                />
                {graduationStage > 0 && graduationStage < 4 && (
                  <Notice tone="amber" className="mt-3 text-xs">
                    {t("meme.graduate.partial", { n: graduationStage, of: 4 })}
                  </Notice>
                )}
              </div>
            </Panel>
          )}
          {status === 4 && quoteMeta && (
            <RefundPanel
              meme={meme}
              memeSymbol={memeSymbol}
              memeDecimals={memeDecimals}
              quoteMeta={quoteMeta}
              graduationManager={deployment.graduationManager}
            />
          )}
          {(status === 1 || status === 3) && quoteMeta && (
            <OrderPanel
              meme={meme}
              memeSymbol={memeSymbol}
              memeDecimals={memeDecimals}
              quoteMeta={quoteMeta}
              curve={deployment.curve}
              status={status}
              chainId={chainId}
              poolKey={poolKey}
              virtualQuote={curveState?.virtualQuote}
              virtualMeme={curveState?.virtualMeme}
              totalFeeBps={totalFeeBps}
              lastPriceQuote={stats.lastPriceQuote}
              lastPriceMeme={stats.lastPriceMeme}
            />
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <TradeTable
            trades={trades}
            isLoading={tradesLoading}
            quoteSymbol={quoteSymbol}
            quoteDecimals={quoteDecimals}
            memeSymbol={memeSymbol}
            memeDecimals={memeDecimals}
            account={account}
            chainId={chainId}
          />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <HolderList
            holders={holders.holders}
            count={holders.count}
            circulating={holders.circulating}
            isLoading={holders.isLoading}
            memeDecimals={memeDecimals}
            account={account}
          />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Panel title={t("meme.rewards.title")}>
          <Stat
            label={t("common.claimable")}
            value={formatAmount(claimableAmount, quoteDecimals, { locale })}
            unit={quoteSymbol}
            tone="verdigris"
          />
          <p className="mt-3 text-[13px] leading-relaxed text-subtle">{t("meme.rewards.note")}</p>
          <div className="mt-4">
            <Button
              tx={claimTx}
              // nothing to claim → no button press: claimQuoteRewards pays 0 without reverting, i.e. pure gas loss
              disabled={!account || !claimableAmount || claimTx.isPending || claimTx.isConfirming}
              onClick={() =>
                claimTx.write(
                  {
                    address: deployment.distributor,
                    abi: holderRewardDistributorAbi,
                    functionName: "claimQuoteRewards",
                    args: [meme],
                  },
                  { check: (r) => ((r as readonly [unknown, bigint])[1] === 0n ? "errors.precheck.nothingToClaim" : null) },
                )
              }
            >
              {account && claimable.isSuccess && !claimableAmount ? t("common.nothingToClaim") : t("meme.rewards.cta")}
            </Button>
            <TxStatus tx={claimTx} successText={t("common.claimed")} />
          </div>
        </Panel>

        <RoleGate roles={["creator", "admin"]} meme={meme}>
        <Panel title={t("meme.dev.title")}>
          <Stat
            label={t("common.claimable")}
            value={formatAmount(launchFees?.devClaimable, quoteDecimals, { locale })}
            unit={quoteSymbol}
          />
          <div className="mt-3 divide-y divide-line">
            <Kv label={t("meme.dev.address")} value={launchFees?.dev} copy />
          </div>
          <div className="mt-4">
            <Button
              variant="ghost"
              tx={devTx}
              disabled={!account || !launchFees?.devClaimable || devTx.isPending || devTx.isConfirming}
              onClick={() =>
                devTx.write(
                  {
                    address: deployment.feeRouter,
                    abi: feeRouterAbi,
                    functionName: "claimDevFees",
                    args: [meme],
                  },
                  { check: (r) => ((r as readonly [unknown, bigint])[1] === 0n ? "errors.precheck.nothingToClaim" : null) },
                )
              }
            >
              {launchFees && !launchFees.devClaimable ? t("common.nothingToClaim") : t("meme.dev.cta")}
            </Button>
            <TxStatus tx={devTx} successText={t("common.claimed")} />
          </div>
        </Panel>
        </RoleGate>

        <Panel title={t("meme.fee.title")}>
          <FeeSplitBar />
          <p className="mt-4 text-[13px] leading-relaxed text-subtle">{t("meme.fee.note")}</p>
        </Panel>
      </div>
    </div>
  );
}
