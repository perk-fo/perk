import { describe, expect, test } from "bun:test";
import { runGrant, type GrantMcConfig } from "../src/montecarlo.ts";

const config: GrantMcConfig = {
  quoteDeposited: 1000,
  grantMeme: 1000,
  p0: 1,
  days: 14,
  n: 200,
  seed: 7,
  mu: 0,
  sigma: 1.5,
  dailyVolumeToLiquidity: 0.2,
};

describe("montecarlo", () => {
  test("test_runGrant_deterministicGivenSeed", () => {
    const a = runGrant(config);
    const b = runGrant(config);
    expect(a).toEqual(b);
    const c = runGrant({ ...config, seed: config.seed + 1 });
    expect(c.median === a.median && c.mean === a.mean).toBe(false);
  });

  test("test_runGrant_quantilesOrdered", () => {
    const s = runGrant(config);
    expect(s.p5).toBeLessThanOrEqual(s.p25);
    expect(s.p25).toBeLessThanOrEqual(s.median);
    expect(s.median).toBeLessThanOrEqual(s.p75);
    expect(s.p75).toBeLessThanOrEqual(s.p95);
    expect(s.probLoss).toBeGreaterThanOrEqual(0);
    expect(s.probLoss).toBeLessThanOrEqual(1);
    expect(s.breakevenVolumeRatio).toBeGreaterThanOrEqual(0);
  });
});
