import { describe, expect, test } from "bun:test";
import { buildCandles, candleChange, pickBucket, type TradePoint } from "@/lib/candles";

const tr = (ts: number, price: number, side: "buy" | "sell" = "buy", v = 1): TradePoint => ({ ts, price, side, quoteVolume: v });

describe("pickBucket", () => {
  test("chooses the smallest readable interval under the candle cap", () => {
    expect(pickBucket(30 * 60)).toBe(60);
    expect(pickBucket(6 * 3600)).toBe(300);
    expect(pickBucket(15 * 86400)).toBe(4 * 3600);
    expect(pickBucket(10_000 * 86400)).toBe(86400);
  });
});

describe("buildCandles", () => {
  test("empty input gives no candles", () => {
    expect(buildCandles([], 60, 1000)).toEqual([]);
  });

  test("fills quiet buckets with flat candles at the previous close and runs to now", () => {
    const c = buildCandles([tr(0, 1), tr(30, 2), tr(185, 3, "sell")], 60, 300);
    expect(c.map((x) => x.t)).toEqual([0, 60, 120, 180, 240, 300]);
    expect(c[0]).toMatchObject({ o: 1, h: 2, l: 1, c: 2, n: 2, v: 2, buys: 2 });
    expect(c[1]).toMatchObject({ o: 2, h: 2, l: 2, c: 2, n: 0, v: 0 });
    expect(c[3]).toMatchObject({ o: 2, h: 3, l: 2, c: 3, n: 1, buys: 0 });
    expect(c[5]).toMatchObject({ o: 3, c: 3, n: 0 });
  });

  test("each candle opens at the previous close", () => {
    const c = buildCandles([tr(0, 1), tr(70, 5), tr(130, 4)], 60, 130);
    expect(c[1].o).toBe(c[0].c);
    expect(c[2].o).toBe(c[1].c);
  });

  test("trades before `from` only seed the opening price", () => {
    const c = buildCandles([tr(0, 10), tr(500, 12)], 60, 600, 400);
    expect(c[0].t).toBe(360);
    expect(c[0]).toMatchObject({ o: 10, c: 10, n: 0 });
    const last = c.find((x) => x.n > 0)!;
    expect(last).toMatchObject({ t: 480, o: 10, c: 12 });
  });

  test("keeps only the most recent maxCandles buckets", () => {
    const c = buildCandles([tr(0, 1), tr(6000, 2)], 60, 6000, undefined, 10);
    expect(c).toHaveLength(10);
    expect(c[9].t).toBe(6000);
    expect(c[0].o).toBe(1);
  });

  test("counts the connected wallet's buys and sells per candle", () => {
    const c = buildCandles(
      [{ ...tr(0, 1), mine: true }, { ...tr(10, 1, "sell"), mine: true }, tr(20, 1), { ...tr(70, 2), mine: true }],
      60,
      70,
    );
    expect(c[0]).toMatchObject({ myBuys: 1, mySells: 1, n: 3 });
    expect(c[1]).toMatchObject({ myBuys: 1, mySells: 0 });
  });

  test("candleChange compares first open with last close", () => {
    const c = buildCandles([tr(0, 2), tr(60, 3)], 60, 60);
    expect(candleChange(c)).toBeCloseTo(50);
    expect(candleChange([])).toBe(0);
  });
});
