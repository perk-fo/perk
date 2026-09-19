import type { Address, Hex } from "viem";
import type { LaunchDetail, LaunchSummary, MarketStats as ApiMarketStats } from "./api-types";
import type { MarketStats } from "./trades";

/** Shapes the meme / grant pages were written against (mirroring the on-chain structs), built from the API. */
export interface LaunchShape {
  launchId: Hex;
  creator: Address;
  meme: Address;
  quote: Address;
  templateId: Hex;
  hookVersion: number;
  moduleBitmap: bigint;
  configHash: Hex;
  lpGrantEnabled: boolean;
  status: number;
  poolId: Hex;
  createdAt: bigint;
}

export interface CurveConfigShape {
  quote: Address;
  virtualQuoteReserve: bigint;
  virtualMemeReserve: bigint;
  curveSupply: bigint;
  poolReserveSupply: bigint;
  graduationQuoteThreshold: bigint;
  totalFeeBps: number;
}

export interface CurveStateShape {
  virtualQuote: bigint;
  virtualMeme: bigint;
  realQuote: bigint;
  memeSold: bigint;
  initialized: boolean;
  graduated: boolean;
  finalized: boolean;
}

export const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

export function launchShape(d: LaunchSummary): LaunchShape {
  return {
    launchId: d.launchId,
    creator: d.creator,
    meme: d.meme,
    quote: d.quote,
    templateId: d.templateId,
    hookVersion: d.hookVersion ?? 1,
    moduleBitmap: BigInt(d.moduleBitmap),
    configHash: d.configHash,
    lpGrantEnabled: d.lpGrantEnabled,
    status: d.status,
    poolId: d.poolId ?? ZERO_HASH,
    createdAt: BigInt(d.createdAt),
  };
}

export function curveConfigShape(d: LaunchSummary): CurveConfigShape | undefined {
  if (!d.curve) return undefined;
  return {
    quote: d.quote,
    virtualQuoteReserve: BigInt(d.curve.virtualQuoteReserve),
    virtualMemeReserve: BigInt(d.curve.virtualMemeReserve),
    curveSupply: BigInt(d.curve.curveSupply),
    poolReserveSupply: BigInt(d.curve.poolReserveSupply),
    graduationQuoteThreshold: BigInt(d.curve.graduationQuoteThreshold),
    totalFeeBps: d.curve.totalFeeBps,
  };
}

/** Live virtual reserves = initial virtual reserves shifted by what the curve has sold so far. */
export function curveStateShape(d: LaunchSummary): CurveStateShape | undefined {
  if (!d.curve) return undefined;
  const realQuote = BigInt(d.curve.realQuote);
  const memeSold = BigInt(d.curve.memeSold);
  const vq0 = BigInt(d.curve.virtualQuoteReserve);
  const vm0 = BigInt(d.curve.virtualMemeReserve);
  return {
    virtualQuote: vq0 + realQuote,
    virtualMeme: vm0 > memeSold ? vm0 - memeSold : 0n,
    realQuote,
    memeSold,
    initialized: true,
    graduated: d.curve.graduated,
    finalized: d.curve.finalized,
  };
}

export function graduationShape(d: LaunchDetail) {
  if (!d.graduation) return undefined;
  return {
    memeToPool: BigInt(d.graduation.memeToPool),
    quoteToPool: BigInt(d.graduation.quoteToPool),
    liquidity: BigInt(d.graduation.liquidity),
    memeIsCurrency0: d.graduation.memeIsCurrency0,
  };
}

export function progressBpsOf(d: LaunchSummary): bigint {
  return BigInt(d.curve?.progressBps ?? (d.status === 3 ? 10_000 : 0));
}

/** API market block → the MarketStats shape the trading components were written against. */
export function marketStatsShape(m: ApiMarketStats | undefined): MarketStats {
  if (!m || m.lastPriceQuote === null || m.lastPriceMeme === null) {
    return { hasPrice: false, lastPriceQuote: 0n, lastPriceMeme: 1n, changeBps: 0n, volume24h: m ? BigInt(m.volume24hQuote) : 0n, mcapQuote: 0n };
  }
  const lastPriceMeme = BigInt(m.lastPriceMeme);
  return {
    hasPrice: lastPriceMeme > 0n && BigInt(m.lastPriceQuote) > 0n,
    lastPriceQuote: BigInt(m.lastPriceQuote),
    lastPriceMeme: lastPriceMeme === 0n ? 1n : lastPriceMeme,
    changeBps: BigInt(m.change24hBps),
    volume24h: BigInt(m.volume24hQuote),
    mcapQuote: m.marketCapQuote ? BigInt(m.marketCapQuote) : 0n,
  };
}
