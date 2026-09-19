import { type Address, type Hex, formatUnits } from "viem";

/**
 * Trade model + pure market math. Trades come from @perk/api (ADR-010): the browser never scans logs.
 * Curve trades: price = quoteNet / memeOut (buy) or quoteGross / memeIn (sell).
 * Pool trades: |quote delta| / |meme delta| from the v4 Swap event, side = quote delta < 0 ⇒ buy.
 */

export type TradeSide = "buy" | "sell";
export type TradeSource = "curve" | "pool";

export interface Trade {
  id: string;
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
  side: TradeSide;
  wallet: Address;
  /** Pool swaps: sender is the router until tx.origin is resolved. */
  walletIsRouter: boolean;
  originResolved: boolean;
  quoteAmount: bigint;
  memeAmount: bigint;
  /** Quote wei used for price = quoteNet (buy) or quoteGross (sell). */
  priceQuote: bigint;
  /** Meme wei used for price = memeOut (buy) or memeIn (sell). */
  priceMeme: bigint;
  source: TradeSource;
}


export function sortTradesNewestFirst(trades: Trade[]): Trade[] {
  return [...trades].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber > b.blockNumber ? -1 : 1;
    return b.logIndex - a.logIndex;
  });
}

export function amountToNumber(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}

export function tradePriceNumber(trade: Trade, quoteDecimals: number, memeDecimals: number): number {
  const q = amountToNumber(trade.priceQuote, quoteDecimals);
  const m = amountToNumber(trade.priceMeme, memeDecimals);
  if (!Number.isFinite(q) || !Number.isFinite(m) || m === 0) return 0;
  return q / m;
}

export interface MarketStats {
  hasPrice: boolean;
  lastPriceQuote: bigint;
  lastPriceMeme: bigint;
  changeBps: bigint;
  volume24h: bigint;
  mcapQuote: bigint;
}

export function computeMarketStats(trades: Trade[], now: number, totalSupply: bigint): MarketStats {
  const empty: MarketStats = {
    hasPrice: false,
    lastPriceQuote: 0n,
    lastPriceMeme: 1n,
    changeBps: 0n,
    volume24h: 0n,
    mcapQuote: 0n,
  };
  if (trades.length === 0) return empty;
  const newest = trades[0];
  const cutoff = now - 86_400;
  const window = trades.filter((t) => t.timestamp === 0 || t.timestamp >= cutoff);
  const last = window[0] ?? newest;
  const first = window[window.length - 1] ?? last;
  let volume24h = 0n;
  for (const t of window) volume24h += t.quoteAmount;

  let changeBps = 0n;
  if (first.priceQuote > 0n && first.priceMeme > 0n && last.priceMeme > 0n) {
    const lastP = last.priceQuote * first.priceMeme;
    const firstP = first.priceQuote * last.priceMeme;
    if (firstP > 0n) changeBps = ((lastP - firstP) * 10_000n) / firstP;
  }

  const mcapQuote =
    last.priceMeme === 0n ? 0n : (last.priceQuote * totalSupply) / last.priceMeme;

  return {
    hasPrice: last.priceMeme > 0n && last.priceQuote > 0n,
    lastPriceQuote: last.priceQuote,
    lastPriceMeme: last.priceMeme,
    changeBps,
    volume24h,
    mcapQuote,
  };
}

/** Packed Uniswap v4 BalanceDelta (int256): amount0 in the high 128 bits, amount1 in the low 128 bits. */
export function unpackBalanceDelta(packed: bigint): { amount0: bigint; amount1: bigint } {
  const amount0 = packed >> 128n;
  let amount1 = packed & ((1n << 128n) - 1n);
  if (amount1 >= 1n << 127n) amount1 -= 1n << 128n;
  return { amount0, amount1 };
}
