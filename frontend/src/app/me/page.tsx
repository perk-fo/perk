"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { feeRouterAbi, holderRewardDistributorAbi } from "@/generated/abis";
import { useLaunchList, useWalletSummary,
  useLpPositions, useWalletTrades, useUsdRates,
} from "@/lib/api-hooks";
import { explorerTxUrl } from "@/lib/chains";
import { useDeployment, useTx } from "@/lib/hooks";
import type { LaunchSummary } from "@/lib/api-types";
import { LaunchAvatar } from "@/components/art/LaunchAvatar";
import { LaunchCard } from "@/components/LaunchCard";
import { InviteLinkRow } from "@/components/InviteLinkRow";
import { TxStatus } from "@/components/TxStatus";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Kv } from "@/components/ui/Kv";
import { Notice } from "@/components/ui/Notice";
import { Pill } from "@/components/ui/Pill";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatAmount, formatDate, formatNumber, formatPrice, formatRelativeTime, shortAddress } from "@/lib/format";
import { useRoles, ROLE_ORDER } from "@/lib/roles";
import { useNow } from "@/lib/hooks";
import { useT } from "@/i18n/provider";
import { Subscripted } from "@/components/ui/Subscripted";
import { UsdFigure } from "@/components/ui/Usd";
import { quoteAmountToUsd, quotePriceToUsd, usdRateOf } from "@/lib/usd";
import { PerkLoader } from "@/components/brand/PerkLoader";

type Claim = { kind: "rewards" | "dev"; launch: LaunchSummary; amount: bigint; payee?: Address };

/**
 * My page (from the account menu): what I can claim across every token, what I hold, every trade I made, what I
 * launched, my LP Grant positions and my invites. Claim rows only list non-zero amounts; each claim is still
 * pre-checked by useTx.
 */
export default function MePage() {
  const { t, locale } = useT();
  const { address, status: walletStatus } = useAccount();
  const { deployment } = useDeployment();
  const summary = useWalletSummary(address);
  const rates = useUsdRates();
  const roles = useRoles();
  const lp = useLpPositions(address);
  const s = summary.data;
  const names = useLaunchList({ limit: 100 });
  const nameOf = new Map((names.data?.launches ?? []).map((l) => [l.meme.toLowerCase(), `${l.name} (${l.symbol})`]));
  const holdings = s?.holdings ?? [];
  const created = s?.launches ?? [];

  // claimable across tokens: Quote Rewards for what I hold, dev fees for what I launched
  const reads = useReadContracts({
    contracts: [
      ...holdings.map((h) => ({
        address: deployment?.distributor,
        abi: holderRewardDistributorAbi,
        functionName: "claimableQuoteRewards" as const,
        args: address ? [h.launch.meme, address] : undefined,
      })),
      ...created.map((l) => ({
        address: deployment?.feeRouter,
        abi: feeRouterAbi,
        functionName: "launchFees" as const,
        args: [l.meme],
      })),
    ],
    query: { enabled: !!deployment && !!address && holdings.length + created.length > 0, refetchInterval: 15_000 },
  });
  const claims: Claim[] = [];
  holdings.forEach((h, i) => {
    const r = reads.data?.[i]?.result as readonly [Address, bigint] | undefined;
    if (r && r[1] > 0n) claims.push({ kind: "rewards", launch: h.launch, amount: r[1] });
  });
  created.forEach((l, i) => {
    const r = reads.data?.[holdings.length + i]?.result as { devClaimable: bigint; dev: Address } | undefined;
    if (r && r.devClaimable > 0n) claims.push({ kind: "dev", launch: l, amount: r.devClaimable, payee: r.dev });
  });

  if (walletStatus === "reconnecting" || walletStatus === "connecting") {
    return (
      <Panel className="py-10">
        <PerkLoader size={56} minHeight={260} />
      </Panel>
    );
  }
  if (!address) {
    return (
      <Panel className="py-14 text-center text-sm text-muted">{t("me.connect")}</Panel>
    );
  }
  const held = ROLE_ORDER.filter((r) => r !== "guest" && roles.roles.has(r));

  return (
    <div className="space-y-8">
      <header className="fade-up flex flex-wrap items-end justify-between gap-4 pt-6 sm:pt-10">
        <div>
          <p className="eyebrow mb-3 text-[10px] font-bold tracking-[0.2em]">{t("page.me.eyebrow")}</p>
          <h1 className="font-display text-[36px] leading-[1.08] sm:text-[48px]">{t("nav.me")}</h1>
          <p className="mono mt-3 break-all text-sm text-muted">{address}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {held.map((r) => (
            <Pill key={r} tone={r === "admin" ? "yolk" : r === "user" ? "muted" : "amber"}>
              {t(`role.${r}`)}
            </Pill>
          ))}
        </div>
      </header>

      {summary.error && <Notice tone="rose">{summary.error.message}</Notice>}

      {/* claimable */}
      <Panel title={t("me.claims.title")} right={<span className="num text-xs text-subtle">{claims.length}</span>}>
        {summary.isLoading || (reads.isLoading && holdings.length + created.length > 0) ? (
          <Skeleton size={32} lines={2} />
        ) : claims.length === 0 ? (
          <p className="text-sm text-subtle">{t("me.claims.none")}</p>
        ) : (
          <div className="divide-y divide-line">
            {claims.map((c) => (
              <ClaimRow key={`${c.kind}:${c.launch.meme}`} claim={c} onDone={() => void reads.refetch()} />
            ))}
          </div>
        )}
      </Panel>

      {/* holdings */}
      <Panel title={t("me.holdings.title")} right={<span className="num text-xs text-subtle">{holdings.length}</span>}>
        {summary.isLoading ? (
          <Skeleton size={32} lines={3} />
        ) : holdings.length === 0 ? (
          <p className="text-sm text-subtle">
            {t("me.holdings.none")}{" "}
            <Link href="/trade" className="text-flare underline decoration-flare/40">
              {t("nav.trade")} →
            </Link>
          </p>
        ) : (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead>
                <tr className="label text-left">
                  <th className="pb-2 font-normal">{t("trade.col.token")}</th>
                  <th className="px-2 pb-2 text-right font-normal">{t("me.holdings.balance")}</th>
                  <th className="px-2 pb-2 text-right font-normal">{t("trade.col.price")}</th>
                  <th className="pb-2 pl-2 text-right font-normal">{t("me.holdings.value")}</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const l = h.launch;
                  const bal = BigInt(h.balance);
                  const price = l.market.lastPrice;
                  const value = price ? (Number(bal) / 10 ** l.decimals) * price : null;
                  const rate = usdRateOf(rates, l.quote);
                  const usd = { rate, symbol: l.quoteSymbol };
                  return (
                    <tr key={l.meme} className="border-t border-line">
                      <td className="py-3">
                        <Link href={`/meme/${l.meme}`} className="group flex items-center gap-3 hover:text-flare">
                          <LaunchAvatar hash={l.configHash} image={l.metadata?.image} status={l.status} size={32} title={l.name} />
                          <span>
                            <span className="block">{l.name}</span>
                            <span className="num text-xs text-subtle">{l.symbol}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="num px-2 py-3 text-right">{formatAmount(bal, l.decimals, { locale, maxFrac: 2 })}</td>
                      <td className="num px-2 py-3 text-right text-muted">
                        {price ? (
                          <UsdFigure kind="price" usd={quotePriceToUsd(price, rate)} {...usd}>
                            <Subscripted text={formatPrice(price, locale)} />
                          </UsdFigure>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="num py-3 pl-2 text-right">
                        {value !== null ? (
                          <UsdFigure usd={quotePriceToUsd(value, rate)} {...usd}>
                            {`${formatNumber(value, locale, { maximumFractionDigits: 6 })} ${l.quoteSymbol}`}
                          </UsdFigure>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* trade history */}
      <TradeHistory address={address} total={s?.tradeCount} />

      {/* LP Grant positions */}
      <Panel title={t("me.positions.title")} right={<span className="num text-xs text-subtle">{s?.positions.length ?? 0}</span>}>
        {!s || s.positions.length === 0 ? (
          <p className="text-sm text-subtle">
            {t("me.positions.none")}{" "}
            <Link href="/grant" className="text-flare underline decoration-flare/40">
              {t("nav.grant")} →
            </Link>
          </p>
        ) : (
          <div className="divide-y divide-line">
            {s.positions.map((p) => (
              <Link
                key={p.positionId}
                href={`/grant/${p.meme}`}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:text-flare"
              >
                <span className="num">
                  #{p.positionId} · {nameOf.get(p.meme.toLowerCase()) ?? shortAddress(p.meme)}
                </span>
                <span className="flex items-center gap-2">
                  <Pill tone="muted">{t("me.lp.grant")}</Pill>
                  <Pill tone={p.exited ? "muted" : "verdigris"}>
                    {p.exited ? t("grant.position.exited") : t("me.positions.open")}
                  </Pill>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      {/* liquidity pool positions */}
      <Panel
        title={t("me.lp.title")}
        right={<span className="num text-xs text-subtle">{lp.data?.positions.length ?? 0}</span>}
      >
        {(lp.data?.positions.length ?? 0) === 0 ? (
          <p className="text-sm text-subtle">{t("me.lp.empty")}</p>
        ) : (
          <div className="divide-y divide-line">
            {(lp.data?.positions ?? []).map((p) => (
              <Link
                key={p.tokenId}
                href={p.meme ? `/pool/${p.meme}` : "/pool"}
                className="flex items-center justify-between gap-3 py-3 text-sm hover:text-flare"
              >
                <span className="num">
                  #{p.tokenId} · {p.meme ? (nameOf.get(p.meme.toLowerCase()) ?? shortAddress(p.meme)) : "—"}
                </span>
                <span className="text-xs text-subtle">{t("pool.mine.manage")} →</span>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      {/* my launches */}
      <section>
        <div className="mb-3 flex items-baseline gap-3">
          <h2 className="label">{t("me.launches.title")}</h2>
          <span className="num text-xs text-subtle">{created.length}</span>
        </div>
        {created.length === 0 ? (
          <Panel className="text-sm text-subtle">
            {t("me.launches.none")}{" "}
            <Link href="/launch" className="text-flare underline decoration-flare/40">
              {t("nav.launch")} →
            </Link>
          </Panel>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {created.map((l) => (
              <LaunchCard key={l.meme} item={l} />
            ))}
          </div>
        )}
      </section>

      {/* invites */}
      <Panel title={t("me.invites.title")}>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <div className="divide-y divide-line">
            <Kv label={t("me.invites.count")} value={formatNumber(s?.inviteeCount ?? 0, locale)} />
            <Kv label={t("grant.inviter.label")} value={s?.inviter ?? t("grant.inviter.unbound")} copy={!!s?.inviter} />
          </div>
          <InviteLinkRow address={address} />
        </div>
      </Panel>
    </div>
  );
}

function ClaimRow({ claim, onDone }: { claim: Claim; onDone: () => void }) {
  const { t, locale } = useT();
  const { deployment } = useDeployment();
  const tx = useTx();
  const l = claim.launch;
  useEffect(() => {
    if (tx.isSuccess) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.isSuccess]);
  if (!deployment) return null;
  const nothing = (r: unknown) => ((r as readonly [unknown, bigint])[1] === 0n ? "errors.precheck.nothingToClaim" : null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <Link href={`/meme/${l.meme}`} className="group flex min-w-0 items-center gap-3 hover:text-flare">
        <LaunchAvatar hash={l.configHash} image={l.metadata?.image} status={l.status} size={32} title={l.name} />
        <span className="min-w-0">
          <span className="block truncate text-sm">
            {l.name} · {claim.kind === "rewards" ? t("meme.rewards.title") : t("meme.dev.title")}
          </span>
          {claim.payee && (
            <span className="num text-xs text-subtle">{t("me.claims.payee", { who: shortAddress(claim.payee) })}</span>
          )}
        </span>
      </Link>
      <span className="flex items-center gap-3">
        <span className="num text-sm text-verdigris">
          {formatAmount(claim.amount, l.quoteDecimals, { locale })} {l.quoteSymbol}
        </span>
        <Button
          variant="ghost"
          tx={tx}
          disabled={tx.isPending || tx.isConfirming || tx.isSuccess}
          onClick={() =>
            claim.kind === "rewards"
              ? tx.write(
                  { address: deployment.distributor, abi: holderRewardDistributorAbi, functionName: "claimQuoteRewards", args: [l.meme] },
                  { check: nothing },
                )
              : tx.write(
                  { address: deployment.feeRouter, abi: feeRouterAbi, functionName: "claimDevFees", args: [l.meme] },
                  { check: nothing },
                )
          }
        >
          {tx.isSuccess ? t("common.claimed") : t("me.claims.cta")}
        </Button>
      </span>
      <div className="w-full">
        <TxStatus tx={tx} />
      </div>
    </div>
  );
}

/**
 * Every trade the connected wallet made, newest first, across all tokens: curve buys and sells and pool swaps
 * (a swap counts for the wallet that sent the transaction). Older pages load on demand.
 */
function TradeHistory({ address, total }: { address: Address; total: number | undefined }) {
  const { t, locale } = useT();
  const { chainId } = useDeployment();
  const now = useNow(15_000);
  const q = useWalletTrades(address);
  const rates = useUsdRates();
  return (
    <Panel
      title={t("me.trades.title")}
      right={<span className="num text-xs text-subtle">{formatNumber(total ?? q.trades.length, locale)}</span>}
    >
      {q.error && <Notice tone="rose">{q.error.message}</Notice>}
      {q.isLoading ? (
        <Skeleton size={32} lines={3} />
      ) : q.trades.length === 0 ? (
        <p className="text-sm text-subtle">
          {t("me.trades.none")}{" "}
          <Link href="/trade" className="text-flare underline decoration-flare/40">
            {t("nav.trade")} →
          </Link>
        </p>
      ) : (
        <>
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full whitespace-nowrap text-[13px]">
              <thead>
                <tr className="label text-left">
                  <th className="pb-2 pr-3 font-normal">{t("meme.trades.time")}</th>
                  <th className="px-2 pb-2 font-normal">{t("trade.col.token")}</th>
                  <th className="px-2 pb-2 font-normal">{t("meme.trades.side")}</th>
                  <th className="px-2 pb-2 text-right font-normal">{t("me.trades.amount")}</th>
                  <th className="px-2 pb-2 text-right font-normal">{t("me.trades.total")}</th>
                  <th className="pb-2 pl-2 text-right font-normal">{t("me.trades.venue")}</th>
                </tr>
              </thead>
              <tbody>
                {q.trades.map((tr) => {
                  const l = q.launches.get(tr.meme.toLowerCase());
                  return (
                    <tr key={tr.id} className="border-t border-line">
                      <td className="py-3 pr-3">
                        <a
                          href={explorerTxUrl(chainId, tr.txHash)}
                          target="_blank"
                          rel="noreferrer"
                          title={`${formatDate(tr.timestamp, locale)} · ${t("meme.trades.tx")} ${shortAddress(tr.txHash)}`}
                          className="num text-muted underline decoration-dotted decoration-line-strong underline-offset-4 hover:text-flare hover:decoration-flare"
                        >
                          {formatRelativeTime(tr.timestamp, now, t)}
                        </a>
                      </td>
                      <td className="px-2 py-3">
                        <Link href={`/meme/${tr.meme}`} className="group flex items-center gap-2.5 hover:text-flare">
                          {l && <LaunchAvatar hash={l.configHash} image={l.metadata?.image} status={l.status} size={24} title={l.name} />}
                          <span className="num">{l?.symbol || shortAddress(tr.meme)}</span>
                        </Link>
                      </td>
                      <td className="px-2 py-3">
                        <Pill tone={tr.side === "buy" ? "verdigris" : "rose"}>
                          {tr.side === "buy" ? t("meme.trade.buy") : t("meme.trade.sell")}
                        </Pill>
                      </td>
                      <td className="num px-2 py-3 text-right">
                        {l ? formatAmount(BigInt(tr.memeAmount), l.decimals, { locale, maxFrac: 2 }) : "—"}
                      </td>
                      <td className="num px-2 py-3 text-right">
                        {l ? (
                          // today's value of a past trade, so marked approximate
                          <UsdFigure
                            approx
                            usd={quoteAmountToUsd(tr.quoteAmount, l.quoteDecimals, usdRateOf(rates, l.quote))}
                            rate={usdRateOf(rates, l.quote)}
                            symbol={l.quoteSymbol}
                          >
                            {`${formatAmount(BigInt(tr.quoteAmount), l.quoteDecimals, { locale, maxFrac: 6 })} ${l.quoteSymbol}`}
                          </UsdFigure>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-3 pl-2 text-right text-muted">
                        {tr.source === "pool" ? t("me.trades.pool") : t("me.trades.curve")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {q.hasNextPage && (
            <Button
              variant="ghost"
              className="mt-4"
              pending={q.isFetchingNextPage}
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t("meme.trades.loadMore")}
            </Button>
          )}
        </>
      )}
    </Panel>
  );
}
