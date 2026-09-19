import { describe, expect, test } from "bun:test";
import type { Trade } from "@/lib/trades";
import { computeMarketStats, sortTradesNewestFirst, tradePriceNumber, unpackBalanceDelta } from "@/lib/trades";

function trade(p: Partial<Trade> & { blockNumber: bigint; logIndex: number }): Trade {
  return {
    id: `${p.blockNumber}:${p.logIndex}`,
    txHash: "0x01",
    timestamp: 1_000,
    side: "buy",
    wallet: "0x0000000000000000000000000000000000000001",
    walletIsRouter: false,
    originResolved: true,
    quoteAmount: 100n,
    memeAmount: 1_000n,
    priceQuote: 100n,
    priceMeme: 1_000n,
    source: "curve",
    ...p,
  };
}

describe("computeMarketStats", () => {
  test("empty list has no price", () => {
    const s = computeMarketStats([], 10_000, 0n);
    expect(s.hasPrice).toBe(false);
    expect(s.volume24h).toBe(0n);
  });
  test("24h window volume, change and market cap", () => {
    const now = 100_000;
    const trades = sortTradesNewestFirst([
      trade({ blockNumber: 1n, logIndex: 0, timestamp: now - 90_000, priceQuote: 100n, priceMeme: 1_000n, quoteAmount: 100n }),
      trade({ blockNumber: 2n, logIndex: 0, timestamp: now - 50_000, priceQuote: 200n, priceMeme: 1_000n, quoteAmount: 200n }),
      trade({ blockNumber: 3n, logIndex: 0, timestamp: now - 10, priceQuote: 300n, priceMeme: 1_000n, quoteAmount: 300n }),
    ]);
    const s = computeMarketStats(trades, now, 10_000n);
    expect(s.hasPrice).toBe(true);
    expect(s.volume24h).toBe(500n); // the 90_000s-old trade is outside 24h
    expect(s.changeBps).toBe(5_000n); // 0.2 → 0.3 = +50%
    expect(s.mcapQuote).toBe(3_000n); // 0.3 × 10_000
  });
});

describe("helpers", () => {
  test("sortTradesNewestFirst orders by block then log index", () => {
    const sorted = sortTradesNewestFirst([
      trade({ blockNumber: 5n, logIndex: 1 }),
      trade({ blockNumber: 7n, logIndex: 0 }),
      trade({ blockNumber: 5n, logIndex: 3 }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["7:0", "5:3", "5:1"]);
  });
  test("tradePriceNumber adjusts decimals", () => {
    const t = trade({ blockNumber: 1n, logIndex: 0, priceQuote: 5n * 10n ** 6n, priceMeme: 10n * 10n ** 18n });
    expect(tradePriceNumber(t, 6, 18)).toBeCloseTo(0.5);
  });
  test("unpackBalanceDelta handles negative low word", () => {
    const amount0 = -5n;
    const amount1 = 7n;
    const packed = (amount0 << 128n) + (amount1 & ((1n << 128n) - 1n));
    expect(unpackBalanceDelta(packed)).toEqual({ amount0: -5n, amount1: 7n });
    const packedNeg1 = (3n << 128n) + ((-9n) & ((1n << 128n) - 1n));
    expect(unpackBalanceDelta(packedNeg1)).toEqual({ amount0: 3n, amount1: -9n });
  });
});
