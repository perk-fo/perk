"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { assetRegistryAbi } from "@/generated/abis";
import { NATIVE_QUOTE, type Deployment } from "./deployments";
import { useDeployment } from "./hooks";

export type QuoteCategory = "native" | "ecosystem" | "rwa";

export interface QuoteInfo {
  address: Address;
  isNative: boolean;
  symbol: string;
  decimals: number;
  enabled: boolean;
  rewardCompatible: boolean;
  /** Display label and RWA notice resolve via `quote.category.*` / `create.quote.rwaNotice` messages. */
  category: QuoteCategory;
}

/** Static quote list: native OKB plus every entry of deployments.quoteAssets. */
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

function classify(address: Address, symbol: string, deployment: Deployment): QuoteCategory {
  const a = address.toLowerCase();
  if (a === NATIVE_QUOTE.toLowerCase()) return "native";
  if (a === deployment.xdogToken.toLowerCase() || symbol === "XDOG") return "ecosystem";
  return "rwa";
}

function buildQuote(
  entry: { address: Address; symbol: string },
  deployment: Deployment,
  info?: { enabled: boolean; rewardCompatible: boolean; isNative: boolean; decimals: number; symbol: string },
): QuoteInfo {
  const isNative = entry.address.toLowerCase() === NATIVE_QUOTE.toLowerCase();
  const symbol = info?.symbol || entry.symbol;
  const category = classify(entry.address, symbol, deployment);
  return {
    address: entry.address,
    isNative,
    symbol,
    decimals: isNative ? 18 : (info?.decimals ?? 18),
    enabled: isNative ? true : (info?.enabled ?? true),
    rewardCompatible: isNative ? true : (info?.rewardCompatible ?? true),
    category,
  };
}

/**
 * Quote list for the current chain, with decimals/symbol/flags read through
 * AssetRegistry.assetInfo for every ERC-20 quote asset.
 */
export function useQuotes(): { quotes: QuoteInfo[]; isLoading: boolean } {
  const { deployment } = useDeployment();
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
    const byAddress = new Map<string, QuoteInfo>();
    for (const e of entries) {
      const i = erc20Entries.findIndex((x) => x.address === e.address);
      const raw = i >= 0 ? data?.[i]?.result : undefined;
      byAddress.set(e.address.toLowerCase(), buildQuote(e, deployment, raw));
    }
    return entries.map((e) => byAddress.get(e.address.toLowerCase())!);
  }, [deployment, entries, erc20Entries, data]);

  return { quotes, isLoading: isLoading && erc20Entries.length > 0 };
}

/** Find a known quote by address; undefined for unknown quotes. */
export function findQuote(quotes: readonly QuoteInfo[], address: Address | undefined): QuoteInfo | undefined {
  if (!address) return undefined;
  const a = address.toLowerCase();
  return quotes.find((q) => q.address.toLowerCase() === a);
}
