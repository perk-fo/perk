import type { Address } from "viem";
import type { ReferralBinding } from "./referrals";

export interface AllocationInput {
  account: Address;
  twab: bigint;
}

export interface Allocation {
  account: Address;
  twab: bigint;
  base: bigint;
  boost: bigint;
}

export interface AllocationResult {
  allocations: Allocation[];
  totalBase: bigint;
  totalBoost: bigint;
  /** True when the raw 10% boosts exceeded referralBudget and were scaled down. */
  boostScaled: boolean;
  /** Accounts dropped because their base fell below minAllocation. */
  dropped: Address[];
}

/** Invitee boost is 10% of base (ADR-008 / PRD 6.3). */
export const INVITEE_BOOST_BPS = 1000n;
export const BPS_DENOMINATOR = 10000n;

/**
 * Compute allocations:
 *  - base_i = floor(basePool * twab_i / sum(twab)) — floor division guarantees sum(base) <= basePool.
 *  - accounts with base < minAllocation are dropped.
 *  - inviteeBoost_i = base_i * 10% for accounts with an inviter bound at or before the cutoff.
 *  - if sum(boost) > referralBudget, every boost is scaled down proportionally (floor) and the
 *    fact is recorded via `boostScaled` so it lands in the public dataset.
 */
export function computeAllocations(
  inputs: readonly AllocationInput[],
  basePool: bigint,
  referralBudget: bigint,
  minAllocation: bigint,
  referrals: Map<Address, ReferralBinding>,
): AllocationResult {
  if (basePool < 0n || referralBudget < 0n) throw new Error("budgets must be non-negative");

  let totalTwab = 0n;
  for (const i of inputs) {
    if (i.twab < 0n) throw new Error(`negative twab for ${i.account}`);
    totalTwab += i.twab;
  }

  const dropped: Address[] = [];
  let allocations: Allocation[] = [];
  if (totalTwab > 0n) {
    for (const { account, twab } of inputs) {
      if (twab === 0n) {
        dropped.push(account);
        continue;
      }
      const base = (basePool * twab) / totalTwab;
      if (base < minAllocation) {
        dropped.push(account);
        continue;
      }
      const hasInviter = referrals.has(account);
      const boost = hasInviter ? (base * INVITEE_BOOST_BPS) / BPS_DENOMINATOR : 0n;
      allocations.push({ account, twab, base, boost });
    }
  }

  let totalBase = 0n;
  let totalBoost = 0n;
  for (const a of allocations) {
    totalBase += a.base;
    totalBoost += a.boost;
  }
  if (totalBase > basePool) throw new Error("invariant violated: sum(base) > basePool");

  let boostScaled = false;
  if (totalBoost > referralBudget) {
    boostScaled = true;
    const rawTotal = totalBoost;
    allocations = allocations.map((a) => ({
      ...a,
      boost: a.boost > 0n ? (a.boost * referralBudget) / rawTotal : 0n,
    }));
    totalBoost = allocations.reduce((s, a) => s + a.boost, 0n);
  }
  if (totalBoost > referralBudget) throw new Error("invariant violated: sum(boost) > referralBudget");

  // Deterministic order for a reproducible dataset / tree.
  allocations.sort((a, b) => a.account.toLowerCase().localeCompare(b.account.toLowerCase()));
  dropped.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return { allocations, totalBase, totalBoost, boostScaled, dropped };
}
