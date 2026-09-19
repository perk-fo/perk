import { simulateGrant, type GrantResult } from "./grant.ts";
import { gbm } from "./paths.ts";

export type GrantMcConfig = {
  quoteDeposited: number;
  grantMeme: number;
  p0: number;
  days: number;
  n: number;
  seed: number;
  mu: number;
  sigma: number;
  dailyVolumeToLiquidity: number;
  lpFeeBps?: number;
  buyShare?: number;
};

export type GrantSummary = {
  mean: number;
  median: number;
  p5: number;
  p25: number;
  p75: number;
  p95: number;
  probLoss: number;
  meanExcessToTreasury: number;
  meanFees: number;
  breakevenVolumeRatio: number;
};

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    throw new RangeError("empty sample");
  }
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) {
    throw new RangeError("quantile index");
  }
  if (lo === hi) {
    return a;
  }
  return a * (hi - idx) + b * (idx - lo);
}

function meanOf(xs: readonly number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  let s = 0;
  for (const x of xs) {
    s += x;
  }
  return s / xs.length;
}

function runOnPaths(
  config: GrantMcConfig,
  paths: readonly (readonly number[])[],
  dailyVolumeToLiquidity: number,
): GrantResult[] {
  return paths.map((pricePath) =>
    simulateGrant({
      quoteDeposited: config.quoteDeposited,
      grantMeme: config.grantMeme,
      p0: config.p0,
      pricePath,
      dailyVolumeToLiquidity,
      lpFeeBps: config.lpFeeBps,
      buyShare: config.buyShare,
    }),
  );
}

function medianPnl(results: readonly GrantResult[]): number {
  const pnls = results.map((r) => r.pnl).sort((a, b) => a - b);
  return quantile(pnls, 0.5);
}

/**
 * Smallest `dailyVolumeToLiquidity` at which median pnl >= 0, via bisection on a fixed path set.
 */
export function breakevenVolumeRatio(
  config: GrantMcConfig,
  paths: readonly (readonly number[])[],
  opts?: { lo?: number; hi?: number; iterations?: number },
): number {
  const lo0 = opts?.lo ?? 0;
  const hi0 = opts?.hi ?? 20;
  const iterations = opts?.iterations ?? 40;
  if (medianPnl(runOnPaths(config, paths, lo0)) >= 0) {
    return lo0;
  }
  let lo = lo0;
  let hi = hi0;
  if (medianPnl(runOnPaths(config, paths, hi)) < 0) {
    // Even an aggressive volume ratio does not repair median loss; return the upper bound.
    return hi;
  }
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (medianPnl(runOnPaths(config, paths, mid)) >= 0) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

/**
 * Monte Carlo Grant payoff over `n` GBM paths. Deterministic given `seed`.
 */
export function runGrant(config: GrantMcConfig): GrantSummary {
  const paths = gbm({
    p0: config.p0,
    mu: config.mu,
    sigma: config.sigma,
    days: config.days,
    n: config.n,
    seed: config.seed,
  });
  const results = runOnPaths(config, paths, config.dailyVolumeToLiquidity);
  const pnls = results.map((r) => r.pnl).sort((a, b) => a - b);
  const excesses = results.map((r) => r.excessToTreasury);
  const fees = results.map((r) => r.quoteFees);
  const losses = results.filter((r) => r.pnl < 0).length;

  return {
    mean: meanOf(pnls),
    median: quantile(pnls, 0.5),
    p5: quantile(pnls, 0.05),
    p25: quantile(pnls, 0.25),
    p75: quantile(pnls, 0.75),
    p95: quantile(pnls, 0.95),
    probLoss: losses / results.length,
    meanExcessToTreasury: meanOf(excesses),
    meanFees: meanOf(fees),
    breakevenVolumeRatio: breakevenVolumeRatio(config, paths),
  };
}
