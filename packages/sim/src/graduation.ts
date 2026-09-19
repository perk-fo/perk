import { BPS, finalPriceX18, memeSoldAtGraduation, mulDiv, WAD } from "./curve.ts";

/**
 * Placeholder numbers from docs/tasks/T04-registries.md (PerkTemplates.defaultNumbers).
 * Pending PRD open items; not production parameters.
 */
export type TemplateNumbers = {
  totalSupply: bigint;
  curveSupply: bigint;
  poolReserveSupplyPerk: bigint;
  poolReserveSupplyStandard: bigint;
  virtualQuoteReserve: bigint;
  virtualMemeReserve: bigint;
  graduationQuoteThreshold: bigint;
  /** User-side total fee in bps of volume. Template default: 100 = 1.00%. */
  totalFeeBps: bigint;
  /** LP share of the total fee, in bps of that fee. Template default: 1500. */
  lpShareBps: bigint;
};

// pump.fun-style virtual reserves scaled by 0.85 so the Perk template's pool reserve pairs exactly with the
// graduation quote; Standard ends with ~15% of supply as leftover meme (ADR-006). Placeholders pending the client's decision in the PRD.
export const defaultNumbers: TemplateNumbers = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  curveSupply: 674_200_000n * 10n ** 18n,
  poolReserveSupplyPerk: 175_800_000n * 10n ** 18n,
  poolReserveSupplyStandard: 325_800_000n * 10n ** 18n,
  virtualQuoteReserve: 30n * 10n ** 18n,
  virtualMemeReserve: 912_050_000n * 10n ** 18n,
  graduationQuoteThreshold: 85n * 10n ** 18n,
  totalFeeBps: 100n,
  lpShareBps: 1500n,
};

export type SeedInput = {
  memeReceived: bigint;
  quoteReceived: bigint;
  priceX18: bigint;
};

export type SeedResult = {
  memeToPool: bigint;
  quoteToPool: bigint;
  memeLeftover: bigint;
  quoteLeftover: bigint;
};

/**
 * ADR-006 / GraduationManager seeding:
 * `memeToPool = min(M, Q / p)`, `quoteToPool = memeToPool * p`.
 * One leftover is always zero (dust quote is absorbed into the pool when quote-limited).
 */
export function seedPool(input: SeedInput): SeedResult {
  const { memeReceived, quoteReceived, priceX18 } = input;
  if (priceX18 === 0n) {
    throw new RangeError("priceX18 is zero");
  }
  const quoteForAllMeme = mulDiv(memeReceived, priceX18, WAD);
  if (quoteForAllMeme <= quoteReceived) {
    return {
      memeToPool: memeReceived,
      quoteToPool: quoteForAllMeme,
      memeLeftover: 0n,
      quoteLeftover: quoteReceived - quoteForAllMeme,
    };
  }
  const memeFromQuote = mulDiv(quoteReceived, WAD, priceX18);
  return {
    memeToPool: memeFromQuote,
    quoteToPool: quoteReceived,
    memeLeftover: memeReceived - memeFromQuote,
    quoteLeftover: 0n,
  };
}

export type SimulateOptions = {
  grantBps: bigint;
  poolReserveSupply?: bigint;
};

export type TemplateBreakdown = {
  name: string;
  grantBps: bigint;
  totalSupply: bigint;
  curveSupply: bigint;
  poolReserveSupply: bigint;
  grantReserveSupply: bigint;
  memeSold: bigint;
  memeSoldClosedForm: bigint;
  unsoldCurve: bigint;
  soldExceedsCurve: boolean;
  finalPriceX18: bigint;
  memeReceived: bigint;
  quoteReceived: bigint;
  quoteFromCurve: bigint;
  quoteFromLpFees: bigint;
  seed: SeedResult;
};

/**
 * Gross quote that yields `net` after a ceil-rounded `totalFeeBps` fee:
 * `ceil(net * BPS / (BPS - totalFeeBps))`.
 */
export function grossFromNet(net: bigint, totalFeeBps: bigint): bigint {
  const keepBps = BPS - totalFeeBps;
  return (net * BPS + keepBps - 1n) / keepBps;
}

/**
 * Curve-stage LP reserve added to graduation quote, assuming the threshold is
 * filled entirely by buys (one equivalent fill: fee on gross that nets to T).
 */
export function curveLpReserve(numbers: TemplateNumbers): bigint {
  const T = numbers.graduationQuoteThreshold;
  const gross = grossFromNet(T, numbers.totalFeeBps);
  const fee = gross - T;
  return mulDiv(fee, numbers.lpShareBps, BPS);
}

/**
 * Full graduation breakdown for one template given curve/supply numbers.
 */
export function simulateTemplate(numbers: TemplateNumbers, opts: SimulateOptions): TemplateBreakdown {
  const grantReserveSupply = mulDiv(numbers.totalSupply, opts.grantBps, BPS);
  const poolReserveSupply =
    opts.poolReserveSupply ??
    (opts.grantBps === 0n ? numbers.poolReserveSupplyStandard : numbers.poolReserveSupplyPerk);

  const vQ = numbers.virtualQuoteReserve;
  const vM = numbers.virtualMemeReserve;
  const T = numbers.graduationQuoteThreshold;
  const soldRaw = memeSoldAtGraduation(vQ, vM, T);
  const soldExceedsCurve = soldRaw > numbers.curveSupply;
  const memeSold = soldExceedsCurve ? numbers.curveSupply : soldRaw;
  const unsoldCurve = numbers.curveSupply - memeSold;
  const price = finalPriceX18(vQ, vM, T);
  const quoteFromLpFees = curveLpReserve(numbers);
  const quoteFromCurve = T;
  const memeReceived = unsoldCurve + poolReserveSupply;
  const quoteReceived = quoteFromCurve + quoteFromLpFees;
  const seed = seedPool({ memeReceived, quoteReceived, priceX18: price });

  return {
    name: opts.grantBps === 0n ? "Standard" : "Perk",
    grantBps: opts.grantBps,
    totalSupply: numbers.totalSupply,
    curveSupply: numbers.curveSupply,
    poolReserveSupply,
    grantReserveSupply,
    memeSold,
    memeSoldClosedForm: soldRaw,
    unsoldCurve,
    soldExceedsCurve,
    finalPriceX18: price,
    memeReceived,
    quoteReceived,
    quoteFromCurve,
    quoteFromLpFees,
    seed,
  };
}

export type TemplateComparison = {
  perk: TemplateBreakdown;
  standard: TemplateBreakdown;
  memeLeftoverDelta: bigint;
};

/**
 * Side-by-side Perk (15% grant) vs Standard (0% grant) using the same curve numbers.
 */
export function compareTemplates(numbers: TemplateNumbers): TemplateComparison {
  const perk = simulateTemplate(numbers, { grantBps: 1500n, poolReserveSupply: numbers.poolReserveSupplyPerk });
  const standard = simulateTemplate(numbers, {
    grantBps: 0n,
    poolReserveSupply: numbers.poolReserveSupplyStandard,
  });
  return {
    perk,
    standard,
    memeLeftoverDelta: standard.seed.memeLeftover - perk.seed.memeLeftover,
  };
}

export type ThresholdSweepRow = {
  threshold: bigint;
  perk: TemplateBreakdown;
  standard: TemplateBreakdown;
};

/**
 * Re-run both templates at each graduation threshold, holding other numbers fixed.
 */
export function sweepThreshold(numbers: TemplateNumbers, thresholds: readonly bigint[]): ThresholdSweepRow[] {
  return thresholds.map((threshold) => {
    const n = { ...numbers, graduationQuoteThreshold: threshold };
    const cmp = compareTemplates(n);
    return { threshold, perk: cmp.perk, standard: cmp.standard };
  });
}

export type PoolSplitSweepRow = {
  poolReserveSupply: bigint;
  curveSupply: bigint;
  perk: TemplateBreakdown;
  standard: TemplateBreakdown;
};

/**
 * Sweep the curve / pool-reserve split of the non-grant supply.
 * `poolReserveBps` is of total supply; Perk grant (15%) stays reserved, Standard
 * adds that 15% onto pool reserve.
 */
export function sweepPoolReserve(numbers: TemplateNumbers, poolReserveBpsList: readonly bigint[]): PoolSplitSweepRow[] {
  return poolReserveBpsList.map((poolBps) => {
    const poolReserveSupplyPerk = mulDiv(numbers.totalSupply, poolBps, BPS);
    const grantReserve = mulDiv(numbers.totalSupply, 1500n, BPS);
    const curveSupply = numbers.totalSupply - grantReserve - poolReserveSupplyPerk;
    const poolReserveSupplyStandard = poolReserveSupplyPerk + grantReserve;
    const n: TemplateNumbers = {
      ...numbers,
      curveSupply,
      poolReserveSupplyPerk,
      poolReserveSupplyStandard,
    };
    const cmp = compareTemplates(n);
    return {
      poolReserveSupply: poolReserveSupplyPerk,
      curveSupply,
      perk: cmp.perk,
      standard: cmp.standard,
    };
  });
}
