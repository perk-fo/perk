"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { api, isNotFound } from "./api";
import type {
  CandleInterval,
  Health,
  LaunchDetail,
  LaunchSummary,
  Trade as ApiTrade,
  Holder as ApiHolder,
  TradesPage,
} from "./api-types";
import { mergeTrades, perkSocket, type WsStatus } from "./ws";
import type { Trade } from "./trades";
import type { HolderRow } from "./holders";
import { useTabVisible } from "./hooks";
import { usableUsdRates, type UsdRates } from "./usd";

const LIVE_MS = 6_000;

function live(visible: boolean, ms = LIVE_MS): number | false {
  return visible ? ms : false;
}

/** Indexer health, polled every 5 s while the tab is visible. `data` undefined + error ⇒ API down. */
export function useHealth() {
  const visible = useTabVisible();
  return useQuery<Health>({
    queryKey: ["api", "health"],
    queryFn: api.health,
    refetchInterval: live(visible, 5_000),
    retry: 1,
    staleTime: 2_000,
  });
}

export function useStats() {
  const visible = useTabVisible();
  return useQuery({ queryKey: ["api", "stats"], queryFn: api.stats, refetchInterval: live(visible, 15_000) });
}

export function useLaunchList(params: { status?: string; quote?: string; creator?: string; sort?: string; limit?: number } = {}) {
  const visible = useTabVisible();
  return useQuery({
    queryKey: ["api", "launches", params],
    queryFn: () => api.launches(params),
    refetchInterval: live(visible, 10_000),
  });
}

/** Launch detail; `notFound` is true for a 404 (unknown meme) so pages can render a clear message. */
export function useLaunchDetail(meme: Address | undefined) {
  const visible = useTabVisible();
  const q = useQuery<LaunchDetail>({
    queryKey: ["api", "launch", meme?.toLowerCase()],
    enabled: !!meme,
    queryFn: () => api.launch(meme!),
    refetchInterval: live(visible),
    retry: (count, err) => !isNotFound(err) && count < 2,
  });
  return { ...q, notFound: isNotFound(q.error) };
}

/** Convert an API trade (decimal strings) into the bigint Trade the table/chart components consume. */
export function toTrade(t: ApiTrade): Trade {
  return {
    id: t.id,
    txHash: t.txHash as Hex,
    blockNumber: BigInt(t.blockNumber),
    logIndex: t.logIndex,
    timestamp: t.timestamp,
    side: t.side,
    wallet: t.wallet as Address,
    walletIsRouter: false,
    originResolved: true,
    quoteAmount: BigInt(t.quoteAmount),
    memeAmount: BigInt(t.memeAmount),
    priceQuote: BigInt(t.priceQuote),
    priceMeme: BigInt(t.priceMeme),
    source: t.source,
  };
}

export function toHolderRow(h: ApiHolder): HolderRow {
  return { address: h.address as Address, balance: BigInt(h.balance) };
}

/** Status of the shared push socket; "open" relaxes REST polling to a slow safety net. */
export function useWsStatus(): WsStatus {
  return useSyncExternalStore(
    (fn) => (typeof window === "undefined" ? () => {} : perkSocket().onStatus(fn)),
    () => perkSocket().status,
    () => "idle",
  );
}

/**
 * Newest-first trades for a meme (first page of `limit`). Pagination happens via `before` cursors.
 * Live: trades pushed over the WebSocket are merged straight into this query's cache; after a reconnect the
 * trades, launch and holders queries are re-fetched to cover the offline gap. REST polling stays on as a fallback
 * (6 s without a socket, 30 s with one).
 */
export function useApiTrades(meme: Address | undefined, limit = 60) {
  const visible = useTabVisible();
  const queryClient = useQueryClient();
  const ws = useWsStatus();
  const key = meme?.toLowerCase();
  const q = useQuery({
    queryKey: ["api", "trades", key, limit],
    enabled: !!meme,
    queryFn: () => api.trades(meme!, { limit }),
    refetchInterval: live(visible, ws === "open" ? 30_000 : LIVE_MS),
  });
  useEffect(() => {
    if (!meme || !key) return;
    return perkSocket().subscribe({
      msg: { op: "subscribe", topic: "trades", meme },
      onMessage: (m) => {
        if (m.type !== "trades" || m.trades.length === 0) return;
        queryClient.setQueryData<TradesPage>(["api", "trades", key, limit], (old) =>
          old ? { ...old, trades: mergeTrades(old.trades, m.trades, limit) } : old,
        );
        // price / volume / holders derive from the new trades: refresh them now rather than on their next poll
        void queryClient.invalidateQueries({ queryKey: ["api", "launch", key] });
        void queryClient.invalidateQueries({ queryKey: ["api", "holders", key] });
      },
      onResync: () => {
        void queryClient.invalidateQueries({ queryKey: ["api", "trades", key] });
        void queryClient.invalidateQueries({ queryKey: ["api", "launch", key] });
        void queryClient.invalidateQueries({ queryKey: ["api", "holders", key] });
      },
    });
  }, [meme, key, limit, queryClient]);
  return { ...q, trades: q.data ? q.data.trades.map(toTrade) : [], nextCursor: q.data?.nextCursor ?? null };
}

export function useApiHolders(meme: Address | undefined, limit = 10) {
  const visible = useTabVisible();
  const q = useQuery({
    queryKey: ["api", "holders", meme?.toLowerCase(), limit],
    enabled: !!meme,
    queryFn: () => api.holders(meme!, limit),
    refetchInterval: live(visible, 12_000),
  });
  return {
    isLoading: q.isLoading,
    error: q.error,
    holders: q.data ? q.data.holders.map(toHolderRow) : [],
    count: q.data?.count ?? 0,
    circulating: q.data ? BigInt(q.data.circulating) : 0n,
  };
}

export function useApiCandles(meme: Address | undefined, interval: CandleInterval, enabled = true) {
  const visible = useTabVisible();
  return useQuery({
    queryKey: ["api", "candles", meme?.toLowerCase(), interval],
    enabled: !!meme && enabled,
    queryFn: () => api.candles(meme!, { interval }),
    refetchInterval: live(visible, 10_000),
  });
}

export function useApiGrant(meme: Address | undefined) {
  const visible = useTabVisible();
  const q = useQuery({
    queryKey: ["api", "grant", meme?.toLowerCase()],
    enabled: !!meme,
    queryFn: () => api.grant(meme!),
    refetchInterval: live(visible, 10_000),
    retry: (count, err) => !isNotFound(err) && count < 2,
  });
  return { ...q, notFound: isNotFound(q.error) };
}

/** Ordinary LP positions the wallet holds. Grant positions come from useGrantPositions and stay separate. */
export function useLpPositions(address: Address | undefined) {
  return useQuery({
    queryKey: ["api", "lp-positions", address?.toLowerCase()],
    enabled: !!address,
    queryFn: () => api.lpPositions(address!),
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

/** Quote currencies from the indexer: on-chain status plus how the site shows them. */
export function useQuoteAssets() {
  return useQuery({ queryKey: ["api", "quote-assets"], queryFn: api.quoteAssets, staleTime: 15_000, refetchInterval: 60_000 });
}

/** US-dollar prices of the quote assets, polled every 60 s while the tab is visible. */
export function usePrices() {
  const visible = useTabVisible();
  return useQuery({
    queryKey: ["api", "prices"],
    queryFn: api.prices,
    refetchInterval: live(visible, 60_000),
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * The USD rates worth showing now, by lowercase quote address (lib/usd). Empty while unknown, when the API has no
 * price for a quote, when it marked one stale, and when this page has not managed to refresh them for 15 minutes:
 * every caller then shows its quote figure alone.
 */
export function useUsdRates(): UsdRates {
  const q = usePrices();
  return useMemo(
    () => usableUsdRates(q.data?.prices, q.dataUpdatedAt, Date.now()),
    // a failed refetch re-checks the age of what is kept
    [q.data, q.dataUpdatedAt, q.errorUpdatedAt],
  );
}

/** The home page's featured launches, in the order General Admins set. */
export function useFeatured() {
  const visible = useTabVisible();
  return useQuery({ queryKey: ["api", "featured"], queryFn: api.featured, refetchInterval: live(visible, 30_000) });
}

export function useWalletRoles(address: Address | undefined) {
  return useQuery({
    queryKey: ["api", "roles", address?.toLowerCase()],
    enabled: !!address,
    queryFn: () => api.walletRoles(address!),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/** Everything about one wallet for the "My" page: holdings, launches, grant positions, claims, referrals. */
export function useWalletSummary(address: Address | undefined) {
  const visible = useTabVisible();
  return useQuery({
    queryKey: ["api", "wallet", address?.toLowerCase()],
    enabled: !!address,
    queryFn: () => api.wallet(address!),
    refetchInterval: live(visible, 12_000),
  });
}

/**
 * One wallet's trades across every meme, newest first, `pageSize` at a time; `fetchNextPage` loads older ones.
 * `launches` maps each traded meme (lowercase) to its launch, for names, decimals and quote symbols.
 */
export function useWalletTrades(address: Address | undefined, pageSize = 20) {
  const visible = useTabVisible();
  const q = useInfiniteQuery({
    queryKey: ["api", "wallet-trades", address?.toLowerCase(), pageSize],
    enabled: !!address,
    queryFn: ({ pageParam }) => api.walletTrades(address!, { limit: pageSize, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live(visible, 20_000),
  });
  const pages = q.data?.pages ?? [];
  const trades = pages.flatMap((p) => p.trades);
  const launches = new Map<string, LaunchSummary>();
  for (const p of pages) for (const l of p.launches) launches.set(l.meme.toLowerCase(), l);
  return { ...q, trades, launches };
}
