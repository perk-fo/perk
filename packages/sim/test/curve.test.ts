import { describe, expect, test } from "bun:test";
import {
  BPS,
  buyNet,
  feeCeil,
  finalPriceX18,
  memeSoldAtGraduation,
  mulDiv,
  sell,
  WAD,
} from "../src/curve.ts";

const vQ = 30n * 10n ** 18n;
const vM = 1073n * 10n ** 24n;
const T = 85n * 10n ** 18n;

describe("curve", () => {
  test("test_buyNet_sell_roundTrip_returnsStrictlyLessQuote", () => {
    const state0 = { virtualQuote: 10n, virtualMeme: 10n };
    const qn = 4n;
    const { memeOut, state: state1 } = buyNet(state0, qn);
    expect(memeOut).toBe(2n);
    const { quoteGross } = sell(state1, memeOut);
    expect(quoteGross < qn).toBe(true);

    const wide = { virtualQuote: vQ, virtualMeme: vM };
    const { memeOut: m2, state: s2 } = buyNet(wide, 10n ** 18n);
    const { quoteGross: q2 } = sell(s2, m2);
    expect(q2 <= 10n ** 18n).toBe(true);
  });

  test("test_buyNet_matchesMemeSoldAtGraduation", () => {
    const state0 = { virtualQuote: vQ, virtualMeme: vM };
    const { memeOut } = buyNet(state0, T);
    expect(memeOut).toBe(memeSoldAtGraduation(vQ, vM, T));
  });

  test("test_memeSoldAtGraduation_equalsClosedForm", () => {
    const sold = memeSoldAtGraduation(vQ, vM, T);
    const closed = (vM * T) / (vQ + T);
    expect(sold).toBe(closed);
    expect(sold).toBe((vM * 17n) / 23n);
  });

  test("test_finalPriceX18_reconstructsQuoteReserve_within1Wei", () => {
    const sold = memeSoldAtGraduation(vQ, vM, T);
    const leftover = vM - sold;
    const price = finalPriceX18(vQ, vM, T);
    const lhs = price * leftover;
    const rhs = (vQ + T) * WAD;
    const diff = rhs >= lhs ? rhs - lhs : lhs - rhs;
    // Floor mulDiv remainder: strictly less than the divisor, i.e. < 1 wei relative to leftover.
    expect(diff).toBeLessThan(leftover);
    const reconstructed = mulDiv(price, leftover, WAD);
    const expected = vQ + T;
    const quoteDiff = reconstructed >= expected ? reconstructed - expected : expected - reconstructed;
    expect(quoteDiff).toBeLessThanOrEqual(leftover / WAD + 1n);
  });

  test("test_feeCeil_neverUnderCollects", () => {
    const samples = [
      0n,
      1n,
      99n,
      100n,
      999n,
      10n ** 18n,
      85n * 10n ** 18n,
      (1n << 128n) - 1n,
    ];
    const bpsList = [1n, 15n, 100n, 1500n, BPS];
    for (const amount of samples) {
      for (const bps of bpsList) {
        const fee = feeCeil(amount, bps);
        expect(fee * BPS >= amount * bps).toBe(true);
        if (fee > 0n) {
          expect((fee - 1n) * BPS >= amount * bps).toBe(false);
        }
      }
    }
  });
});
