import { keccak256, toHex, type Address, type Hex } from "viem";
import { NATIVE_QUOTE } from "./deployments";

/**
 * The launch-template numbers of contracts/src/libraries/PerkTemplates.sol, so the admin page can register the V1
 * templates for a new quote currency the way the deploy scripts do. `test/template-numbers.test.ts` checks the output
 * against the templates those scripts registered on testnet; the registry itself rejects anything malformed.
 */

export const MODULE_OFFICIAL_POOL_GUARD_V1 = 1n << 0n;
export const MODULE_QUOTE_FEE_ROUTER_V1 = 1n << 1n;
export const MODULE_HOLDER_QUOTE_REWARD_V1 = 1n << 2n;
export const MODULE_LP_GRANT_V1 = 1n << 3n;
export const MODULE_REFERRAL_GRANT_BOOST_V1 = 1n << 4n;
export const CORE_MODULES_V1 = MODULE_OFFICIAL_POOL_GUARD_V1 | MODULE_QUOTE_FEE_ROUTER_V1 | MODULE_HOLDER_QUOTE_REWARD_V1;

/** Every V1 module a quote must be compatible with (ModuleRegistry.setQuoteCompatibility, version 1). */
export const MODULE_IDS_V1: ReadonlyArray<{ name: string; id: Hex }> = [
  "OFFICIAL_POOL_GUARD_V1",
  "QUOTE_FEE_ROUTER_V1",
  "HOLDER_QUOTE_REWARD_V1",
  "LP_GRANT_V1",
  "REFERRAL_GRANT_BOOST_V1",
].map((name) => ({ name, id: keccak256(toHex(name)) }));

const HOOK_VERSION_V1 = 1;
const BPS = 10_000n;
const FEE_SPLIT = { devBps: 5000, rewardsBps: 2500, lpBps: 1500, treasuryBps: 500, protocolBps: 500 };
const TOTAL_FEE_BPS = 100;
const POOL_LP_FEE_PIPS = 1500;
const GRANT_RESERVE_BPS = 1500;
const GRANT_BASE_BPS = 8000;
const GRANT_REFERRAL_BPS = 2000;
const MIN_TICK = 887272;
const ACTIVE = 2; // PerkTypes.RegistryStatus.ACTIVE
const LEFTOVER_BURN = 0;

export interface TemplateNumbers {
  totalSupply: bigint;
  curveSupply: bigint;
  poolReserveSupplyPerk: bigint;
  poolReserveSupplyStandard: bigint;
  virtualQuoteReserve: bigint;
  virtualMemeReserve: bigint;
  graduationQuoteThreshold: bigint;
  tickSpacing: number;
  minEligibleBalance: bigint;
  grantWindowSeconds: bigint;
  minLpSeconds: bigint;
  anyQuote: boolean;
  quote: Address;
}

/** The ABI shape of PerkTypes.Template, ready for TemplateRegistry.registerTemplate. */
export interface TemplateStruct {
  hookVersion: number;
  moduleBitmap: bigint;
  totalFeeBps: number;
  feeSplit: typeof FEE_SPLIT;
  supply: { totalSupply: bigint; curveSupply: bigint; poolReserveSupply: bigint; grantReserveSupply: bigint };
  curve: { virtualQuoteReserve: bigint; virtualMemeReserve: bigint; graduationQuoteThreshold: bigint };
  pool: { lpFee: number; tickSpacing: number; tickLower: number; tickUpper: number; leftoverPolicy: number };
  grant: {
    enabled: boolean;
    reserveBps: number;
    baseGrantPoolBps: number;
    referralBudgetBps: number;
    windowSeconds: bigint;
    minLpSeconds: bigint;
    referralBoostEnabled: boolean;
  };
  minEligibleBalance: bigint;
  status: number;
  anyQuote: boolean;
  quote: Address;
}

/** PerkTemplates.defaultNumbers(): 18-decimal quote numbers, not yet bound to a quote. */
export function defaultNumbers(): TemplateNumbers {
  const e18 = 10n ** 18n;
  return {
    totalSupply: 1_000_000_000n * e18,
    curveSupply: 674_200_000n * e18,
    poolReserveSupplyPerk: 175_800_000n * e18,
    poolReserveSupplyStandard: 325_800_000n * e18,
    virtualQuoteReserve: 30n * e18,
    virtualMemeReserve: 912_050_000n * e18,
    graduationQuoteThreshold: 85n * e18,
    tickSpacing: 60,
    minEligibleBalance: 1000n * e18,
    grantWindowSeconds: 14n * 86_400n,
    minLpSeconds: 86_400n,
    anyQuote: true,
    quote: NATIVE_QUOTE,
  };
}

/** PerkTemplates.forQuote: bind to `quote` and rescale the quote-denominated numbers from 18 to `decimals`. */
export function forQuote(n: TemplateNumbers, quote: Address, decimals: number): TemplateNumbers {
  const m = { ...n, anyQuote: false, quote };
  if (decimals < 18) {
    const div = 10n ** BigInt(18 - decimals);
    m.virtualQuoteReserve = n.virtualQuoteReserve / div;
    m.graduationQuoteThreshold = n.graduationQuoteThreshold / div;
  } else if (decimals > 18) {
    const mul = 10n ** BigInt(decimals - 18);
    m.virtualQuoteReserve = n.virtualQuoteReserve * mul;
    m.graduationQuoteThreshold = n.graduationQuoteThreshold * mul;
  }
  return m;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Move the graduation threshold and keep the curve's shape: the virtual quote reserve keeps its ratio to the
 * threshold (30:85), so the share of supply sold at graduation, and with it every supply number, stays the same.
 * Rounded up, so rounding never lets the curve sell more than its supply.
 */
export function withThreshold(n: TemplateNumbers, threshold: bigint): TemplateNumbers {
  return {
    ...n,
    graduationQuoteThreshold: threshold,
    virtualQuoteReserve: ceilDiv(threshold * n.virtualQuoteReserve, n.graduationQuoteThreshold),
  };
}

/** The testnet "fast" variant (ConfigureQuoteAsset defaults): a curve 10,000x smaller and short grant timings. */
export function fastNumbers(n: TemplateNumbers, scaleDiv = 10_000n, windowSeconds = 7200n, minLpSeconds = 600n): TemplateNumbers {
  return {
    ...n,
    virtualQuoteReserve: ceilDiv(n.virtualQuoteReserve, scaleDiv),
    graduationQuoteThreshold: n.graduationQuoteThreshold / scaleDiv,
    grantWindowSeconds: windowSeconds,
    minLpSeconds,
  };
}

function usableTicks(spacing: number): { lower: number; upper: number } {
  const t = Math.trunc(MIN_TICK / spacing) * spacing;
  return { lower: -t, upper: t };
}

function base(n: TemplateNumbers, poolReserveSupply: bigint, grantReserveSupply: bigint): TemplateStruct {
  const ticks = usableTicks(n.tickSpacing);
  return {
    hookVersion: HOOK_VERSION_V1,
    moduleBitmap: 0n,
    totalFeeBps: TOTAL_FEE_BPS,
    feeSplit: { ...FEE_SPLIT },
    supply: { totalSupply: n.totalSupply, curveSupply: n.curveSupply, poolReserveSupply, grantReserveSupply },
    curve: {
      virtualQuoteReserve: n.virtualQuoteReserve,
      virtualMemeReserve: n.virtualMemeReserve,
      graduationQuoteThreshold: n.graduationQuoteThreshold,
    },
    pool: { lpFee: POOL_LP_FEE_PIPS, tickSpacing: n.tickSpacing, tickLower: ticks.lower, tickUpper: ticks.upper, leftoverPolicy: LEFTOVER_BURN },
    grant: {
      enabled: false,
      reserveBps: 0,
      baseGrantPoolBps: 0,
      referralBudgetBps: 0,
      windowSeconds: 0n,
      minLpSeconds: 0n,
      referralBoostEnabled: false,
    },
    minEligibleBalance: n.minEligibleBalance,
    status: ACTIVE,
    anyQuote: n.anyQuote,
    quote: n.quote,
  };
}

/** Perk Grant V1: LP Grant on. */
export function perkGrantV1(n: TemplateNumbers): TemplateStruct {
  const t = base(n, n.poolReserveSupplyPerk, (n.totalSupply * BigInt(GRANT_RESERVE_BPS)) / BPS);
  t.moduleBitmap = CORE_MODULES_V1 | MODULE_LP_GRANT_V1 | MODULE_REFERRAL_GRANT_BOOST_V1;
  t.grant = {
    enabled: true,
    reserveBps: GRANT_RESERVE_BPS,
    baseGrantPoolBps: GRANT_BASE_BPS,
    referralBudgetBps: GRANT_REFERRAL_BPS,
    windowSeconds: n.grantWindowSeconds,
    minLpSeconds: n.minLpSeconds,
    referralBoostEnabled: true,
  };
  return t;
}

/** Standard Curve V1: LP Grant off. */
export function standardCurveV1(n: TemplateNumbers): TemplateStruct {
  const t = base(n, n.poolReserveSupplyStandard, 0n);
  t.moduleBitmap = CORE_MODULES_V1;
  return t;
}

/** TemplateRegistry.memeSoldAtGraduation: vMeme * T / (vQuote + T). */
export function memeSoldAtGraduation(t: TemplateStruct): bigint {
  const { virtualMemeReserve: vm, virtualQuoteReserve: vq, graduationQuoteThreshold: th } = t.curve;
  return (vm * th) / (vq + th);
}

/** Why the registry would reject these numbers, or null. The registry checks more; these are the ones a threshold can break. */
export function templateProblem(t: TemplateStruct): "zeroThreshold" | "zeroReserve" | "oversold" | null {
  if (t.curve.graduationQuoteThreshold === 0n) return "zeroThreshold";
  if (t.curve.virtualQuoteReserve === 0n) return "zeroReserve";
  if (memeSoldAtGraduation(t) > t.supply.curveSupply) return "oversold";
  return null;
}
