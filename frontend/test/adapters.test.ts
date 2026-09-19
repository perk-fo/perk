import { describe, expect, test } from "bun:test";
import { curveStateShape, launchShape, marketStatsShape, progressBpsOf, ZERO_HASH } from "@/lib/api-adapters";
import { toTrade, toHolderRow } from "@/lib/api-hooks";
import { deriveRoles, ROLE_GATING_ENABLED } from "@/lib/roles";
import { foldTransfers, positiveBalances, topHolders } from "@/lib/holders";
import type { LaunchSummary, Trade as ApiTrade } from "@/lib/api-types";

const summary: LaunchSummary = {
  meme: "0x00000000000000000000000000000000000000aa",
  launchId: "0x01",
  creator: "0x00000000000000000000000000000000000000cc",
  quote: "0x0000000000000000000000000000000000000000",
  quoteSymbol: "OKB",
  quoteDecimals: 18,
  templateId: "0x02",
  configHash: "0x03",
  moduleBitmap: "31",
  hookVersion: 1,
  lpGrantEnabled: true,
  name: "Ink Fox",
  symbol: "IFOX",
  decimals: 18,
  totalSupply: "1000000000000000000000",
  status: 1,
  poolId: null,
  createdAt: 1_789_000_000,
  createdBlock: 41_000_000,
  createdTx: "0x04",
  curve: {
    virtualQuoteReserve: "1000",
    virtualMemeReserve: "5000",
    curveSupply: "4000",
    poolReserveSupply: "1000",
    graduationQuoteThreshold: "2000",
    totalFeeBps: 100,
    realQuote: "500",
    memeSold: "1200",
    progressBps: 2500,
    graduated: false,
    finalized: false,
  },
  market: {
    lastPriceQuote: "3",
    lastPriceMeme: "2",
    lastPrice: 1.5,
    change24hBps: -250,
    volume24hQuote: "777",
    volumeTotalQuote: "9999",
    marketCapQuote: "1500000000000000000000",
    tradeCount: 4,
    holderCount: 2,
    lastTradeAt: 1_789_000_100,
  },
  grantStatus: null,
};

describe("api adapters", () => {
  test("launchShape fills the zero pool id and bigint fields", () => {
    const l = launchShape(summary);
    expect(l.poolId).toBe(ZERO_HASH);
    expect(l.moduleBitmap).toBe(31n);
    expect(l.createdAt).toBe(1_789_000_000n);
  });
  test("curveStateShape derives live virtual reserves", () => {
    const s = curveStateShape(summary)!;
    expect(s.virtualQuote).toBe(1500n);
    expect(s.virtualMeme).toBe(3800n);
    expect(s.realQuote).toBe(500n);
  });
  test("progressBps falls back per status", () => {
    expect(progressBpsOf(summary)).toBe(2500n);
    expect(progressBpsOf({ ...summary, curve: null, status: 3 })).toBe(10_000n);
  });
  test("marketStatsShape mirrors the trading MarketStats", () => {
    const m = marketStatsShape(summary.market);
    expect(m.hasPrice).toBe(true);
    expect(m.changeBps).toBe(-250n);
    expect(m.volume24h).toBe(777n);
    expect(marketStatsShape(undefined).hasPrice).toBe(false);
  });
  test("toTrade / toHolderRow convert decimal strings to bigint", () => {
    const t: ApiTrade = {
      id: "0x05:1",
      txHash: "0x05",
      logIndex: 1,
      blockNumber: 42,
      timestamp: 1,
      side: "sell",
      source: "pool",
      wallet: "0x00000000000000000000000000000000000000ee",
      router: null,
      quoteAmount: "10",
      memeAmount: "20",
      fee: null,
      priceQuote: "10",
      priceMeme: "20",
      price: 0.5,
    };
    const tr = toTrade(t);
    expect(tr.blockNumber).toBe(42n);
    expect(tr.quoteAmount).toBe(10n);
    expect(tr.side).toBe("sell");
    expect(toHolderRow({ address: "0x00000000000000000000000000000000000000ee", balance: "5", shareBps: 1 }).balance).toBe(5n);
  });
});

describe("roles", () => {
  test("gating is off during development", () => {
    expect(ROLE_GATING_ENABLED).toBe(false);
  });
  test("deriveRoles picks the highest tier", () => {
    expect(deriveRoles({ connected: false, isAdmin: true, creatorOf: new Set(), lpOf: new Set() }).tier).toBe("guest");
    expect(deriveRoles({ connected: true, isAdmin: false, creatorOf: new Set(), lpOf: new Set() }).tier).toBe("user");
    expect(deriveRoles({ connected: true, isAdmin: false, creatorOf: new Set(), lpOf: new Set(["0xa"]) }).tier).toBe("lp");
    const r = deriveRoles({ connected: true, isAdmin: true, creatorOf: new Set(["0xa"]), lpOf: new Set(["0xb"]) });
    expect(r.tier).toBe("admin");
    expect([...r.roles].sort()).toEqual(["admin", "creator", "lp", "user"]);
  });
});

describe("holders fold (legacy client-side path)", () => {
  test("fold, drop zero balances, rank and exclude", () => {
    const A = "0x00000000000000000000000000000000000000a1";
    const B = "0x00000000000000000000000000000000000000b1";
    const SYS = "0x00000000000000000000000000000000000000c1";
    const ZERO = "0x0000000000000000000000000000000000000000";
    const bal = foldTransfers([
      { args: { from: ZERO, to: A, value: 100n } },
      { args: { from: A, to: B, value: 30n } },
      { args: { from: A, to: SYS, value: 70n } },
    ]);
    const rows = positiveBalances(bal);
    expect(rows.map((r) => r.address).sort()).toEqual([B, SYS].sort());
    const top = topHolders(rows, new Set([SYS]), 10);
    expect(top.count).toBe(1);
    expect(top.excludedSum).toBe(70n);
    expect(top.holders[0].address).toBe(B);
  });
});
