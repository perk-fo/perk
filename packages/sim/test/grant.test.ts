import { describe, expect, test } from "bun:test";
import { simulateGrant } from "../src/grant.ts";
import { gbm, stressPath } from "../src/paths.ts";

const Q = 1000;
const M = 1000;
const p0 = 1;
const feeArgs = { dailyVolumeToLiquidity: 0.2, lpFeeBps: 15, buyShare: 0.5 };

describe("grant", () => {
  test("test_simulateGrant_flatPath_pnlEqualsFees", () => {
    const r = simulateGrant({
      quoteDeposited: Q,
      grantMeme: M,
      p0,
      pricePath: stressPath("flat", p0, 14),
      ...feeArgs,
    });
    expect(Math.abs(r.pnl - r.quoteFees)).toBeLessThan(1e-9);
    expect(r.excessToTreasury).toBeLessThan(1e-9);
    expect(Math.abs(r.quoteToUser - (Q + r.quoteFees))).toBeLessThan(1e-9);
  });

  test("test_simulateGrant_up100_capsPrincipalAndPaysFees", () => {
    const r = simulateGrant({
      quoteDeposited: Q,
      grantMeme: M,
      p0,
      pricePath: stressPath("up100", p0, 14),
      ...feeArgs,
    });
    expect(Math.abs(r.quoteToUser - (Q + r.quoteFees))).toBeLessThan(1e-9);
    expect(r.excessToTreasury).toBeGreaterThan(0);
    expect(r.quotePrincipalOut).toBeGreaterThan(Q);
  });

  test("test_simulateGrant_down50_negativePnlNoExcess", () => {
    const r = simulateGrant({
      quoteDeposited: Q,
      grantMeme: M,
      p0,
      pricePath: stressPath("down50", p0, 14),
      ...feeArgs,
    });
    expect(r.pnl).toBeLessThan(0);
    expect(r.excessToTreasury).toBeLessThan(1e-9);
    expect(r.quotePrincipalOut).toBeLessThan(Q);
  });

  test("test_simulateGrant_fuzzGbm_principalNeverExceedsQ", () => {
    const paths = gbm({ p0, mu: 0, sigma: 1.5, days: 14, n: 1000, seed: 42 });
    expect(paths.length).toBe(1000);
    for (const pricePath of paths) {
      const r = simulateGrant({
        quoteDeposited: Q,
        grantMeme: M,
        p0,
        pricePath,
        ...feeArgs,
      });
      const principalToUser = r.quoteToUser - r.quoteFees;
      expect(principalToUser).toBeLessThanOrEqual(Q + 1e-9);
      expect(r.quoteToUser).toBeLessThanOrEqual(Q + r.quoteFees + 1e-9);
    }
  });
});
