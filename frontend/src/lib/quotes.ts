"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { assetRegistryAbi } from "@/generated/abis";
import type { QuoteAsset, QuoteCategory, QuoteNotice } from "./api-types";
import { useQuoteAssets } from "./api-hooks";
import { NATIVE_QUOTE, type Deployment } from "./deployments";
import { useDeployment } from "./hooks";

export type { QuoteCategory };

export interface QuoteInfo {
  address: Address;
  isNative: boolean;
  symbol: string;
  /**
   * Null while unknown: neither the API nor the AssetRegistry read has answered. It is never guessed (a 6-decimal
   * asset read as 18 is off by 10^12), so anything that turns user input into an amount waits for it.
   */
  decimals: number | null;
  enabled: boolean;
  rewardCompatible: boolean;
  /** Display label and default notice resolve via `quote.category.*` / `create.quote.rwaNotice` messages. */
  category: QuoteCategory;
  /** A name General Admins chose; the symbol is shown when null. */
  displayName: string | null;
  iconUrl: string | null;
  /** Risk notice General Admins wrote, per locale; see `quoteNotice`. */
  notice: QuoteNotice;
  /** false keeps it out of the Launch page's picker. */
  listed: boolean;
  /** ACTIVE templates bound to it on-chain; null when the API is unreachable and nobody knows. */
  activeTemplates: number | null;
}

/** Static quote list: native OKB plus every entry of deployments.quoteAssets (the fallback when the API is down). */
export function quoteEntries(deployment: Deployment | null): Array<{ address: Address; symbol: string }> {
  if (!deployment) return [];
  return [
    { address: NATIVE_QUOTE, symbol: "OKB" },
    ...Object.entries(deployment.quoteAssets ?? {}).map(([symbol, address]) => ({
      address: address as Address,
      symbol,
    })),
  ];
}

/**
 * The category when General Admins have not set one. Unknown ERC-20s are treated as tokenised stocks, which shows
 * the risk notice: showing it for a token that does not need it is the safer mistake.
 */
function defaultCategory(address: Address, symbol: string, deployment: Deployment): QuoteCategory {
  const a = address.toLowerCase();
  if (a === NATIVE_QUOTE.toLowerCase()) return "native";
  if (a === deployment.xdogToken.toLowerCase() || symbol === "XDOG") return "ecosystem";
  return "rwa";
}

function fromApi(a: QuoteAsset, deployment: Deployment): QuoteInfo {
  return {
    address: a.address,
    isNative: a.isNative,
    symbol: a.symbol,
    decimals: a.isNative ? 18 : a.decimals,
    enabled: a.enabled,
    rewardCompatible: a.rewardCompatible,
    category: a.display.category ?? defaultCategory(a.address, a.symbol, deployment),
    displayName: a.display.displayName,
    iconUrl: a.display.iconUrl,
    notice: a.display.notice,
    listed: a.display.listed,
    activeTemplates: a.activeTemplates,
  };
}

/**
 * A quote from the deployment file plus its AssetRegistry.assetInfo read (`info`, undefined while the read is
 * pending or when it failed). Without `info` an ERC-20's decimals stay null: unknown, not assumed.
 */
export function fromChain(
  entry: { address: Address; symbol: string },
  deployment: Deployment,
  info?: { enabled: boolean; rewardCompatible: boolean; isNative: boolean; decimals: number; symbol: string },
): QuoteInfo {
  const isNative = entry.address.toLowerCase() === NATIVE_QUOTE.toLowerCase();
  const symbol = info?.symbol || entry.symbol;
  return {
    address: entry.address,
    isNative,
    symbol,
    decimals: isNative ? 18 : (info?.decimals ?? null),
    enabled: isNative ? true : (info?.enabled ?? true),
    rewardCompatible: isNative ? true : (info?.rewardCompatible ?? true),
    category: defaultCategory(entry.address, symbol, deployment),
    displayName: null,
    iconUrl: null,
    notice: {},
    listed: true,
    activeTemplates: null,
  };
}

/**
 * Quote currencies for the current chain. The indexer's list comes first: it includes assets listed after this
 * build and the display settings General Admins chose. The deployment file's list, read through
 * AssetRegistry.assetInfo, fills in whatever the API does not return (or everything, while it is unreachable).
 */
export function useQuotes(): { quotes: QuoteInfo[]; isLoading: boolean } {
  const { deployment } = useDeployment();
  const apiAssets = useQuoteAssets();
  const entries = useMemo(() => quoteEntries(deployment), [deployment]);
  const erc20Entries = useMemo(
    () => entries.filter((e) => e.address.toLowerCase() !== NATIVE_QUOTE.toLowerCase()),
    [entries],
  );

  const { data, isLoading } = useReadContracts({
    contracts:
      deployment?.assetRegistry !== undefined
        ? erc20Entries.map((e) => ({
            address: deployment.assetRegistry as Address,
            abi: assetRegistryAbi,
            functionName: "assetInfo" as const,
            args: [e.address] as const,
          }))
        : [],
    query: { enabled: !!deployment?.assetRegistry && erc20Entries.length > 0 },
  });

  const quotes = useMemo(() => {
    if (!deployment) return [];
    const out: QuoteInfo[] = (apiAssets.data?.assets ?? []).map((a) => fromApi(a, deployment));
    const seen = new Set(out.map((q) => q.address.toLowerCase()));
    for (const e of entries) {
      if (seen.has(e.address.toLowerCase())) continue;
      const i = erc20Entries.findIndex((x) => x.address === e.address);
      out.push(fromChain(e, deployment, i >= 0 ? data?.[i]?.result : undefined));
    }
    return out;
  }, [deployment, apiAssets.data, entries, erc20Entries, data]);

  return { quotes, isLoading: apiAssets.isLoading || (isLoading && erc20Entries.length > 0) };
}

/** A quote whose decimals are known: the only kind a transaction may be built with. */
export type KnownQuote = QuoteInfo & { decimals: number };

export function hasKnownDecimals(q: QuoteInfo | undefined): q is KnownQuote {
  return q !== undefined && q.decimals !== null;
}

/** Find a known quote by address; undefined for unknown quotes. */
export function findQuote(quotes: readonly QuoteInfo[], address: Address | undefined): QuoteInfo | undefined {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return quotes.find((q) => q.address.toLowerCase() === a);
}

/** Can a new launch use this quote: allowed on-chain, listed by admins, and with templates to launch from. */
export function isLaunchable(q: QuoteInfo): boolean {
  return q.enabled && q.rewardCompatible && q.listed && q.activeTemplates !== 0;
}

/**
 * The risk notice to show for a quote: what General Admins wrote for this locale (or in English), else the
 * category's standard text, which only tokenised stocks have.
 */
export function quoteNotice(q: QuoteInfo, locale: string, rwaDefault: string): string | null {
  const own = q.notice[locale as keyof QuoteNotice] ?? q.notice.en;
  if (own) return own;
  return q.category === "rwa" ? rwaDefault : null;
}
