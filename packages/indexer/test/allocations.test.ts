import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { computeAllocations, type AllocationInput } from "../src/allocations";
import type { ReferralBinding } from "../src/referrals";

function account(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

/** Deterministic LCG so the fuzz loop is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function binding(invitee: Address, inviter: Address): [Address, ReferralBinding] {
  return [invitee, { invitee, inviter, blockNumber: 1n }];
}

describe("computeAllocations", () => {
  test("sum(base) <= basePool for random inputs (floor rounding)", () => {
    const rand = lcg(42);
    for (let iter = 0; iter < 100; iter++) {
      const n = 1 + Math.floor(rand() * 50);
      const inputs: AllocationInput[] = Array.from({ length: n }, (_, i) => ({
        account: account(i + 1),
        twab: BigInt(Math.floor(rand() * 1e9)) * 10n ** 12n,
      }));
      const basePool = BigInt(Math.floor(rand() * 1e9)) * 10n ** 18n + 1n;
      const r = computeAllocations(inputs, basePool, basePool / 10n, 0n, new Map());
      expect(r.totalBase).toBeLessThanOrEqual(basePool);
      expect(r.totalBoost).toBeLessThanOrEqual(basePool / 10n);
      expect(r.allocations.length).toBe(inputs.filter((i) => i.twab > 0n).length);
    }
  });

  test("base split is proportional to twab", () => {
    const r = computeAllocations(
      [
        { account: account(1), twab: 100n },
        { account: account(2), twab: 300n },
      ],
      1000n,
      1000n,
      0n,
      new Map(),
    );
    expect(r.allocations.find((a) => a.account === account(1))?.base).toBe(250n);
    expect(r.allocations.find((a) => a.account === account(2))?.base).toBe(750n);
  });

  test("min-allocation filter drops dust accounts", () => {
    const r = computeAllocations(
      [
        { account: account(1), twab: 10n ** 16n },
        { account: account(2), twab: 1n }, // base = 10^18 / (10^16 + 1) ≈ 99 < min
      ],
      10n ** 18n,
      0n,
      100n,
      new Map(),
    );
    expect(r.allocations.map((a) => a.account)).toEqual([account(1)]);
    expect(r.dropped).toEqual([account(2)]);
  });

  test("zero-twab accounts are dropped", () => {
    const r = computeAllocations(
      [
        { account: account(1), twab: 100n },
        { account: account(2), twab: 0n },
      ],
      1000n,
      1000n,
      0n,
      new Map(),
    );
    expect(r.dropped).toEqual([account(2)]);
    expect(r.totalBase).toBe(1000n);
  });

  test("invitee boost = 10% of base only for accounts with an inviter", () => {
    const referrals = new Map([binding(account(1), account(9))]);
    const r = computeAllocations(
      [
        { account: account(1), twab: 100n },
        { account: account(2), twab: 100n },
      ],
      1000n,
      1000n,
      0n,
      referrals,
    );
    expect(r.allocations.find((a) => a.account === account(1))?.boost).toBe(50n);
    expect(r.allocations.find((a) => a.account === account(2))?.boost).toBe(0n);
  });

  test("boost scaling when the 10% boosts exceed the referral budget", () => {
    // 4 accounts, each with inviter → raw boost sum = 10% of totalBase = 100, budget = 40.
    const referrals = new Map([
      binding(account(1), account(9)),
      binding(account(2), account(9)),
      binding(account(3), account(9)),
      binding(account(4), account(9)),
    ]);
    const inputs = [1, 2, 3, 4].map((i) => ({ account: account(i), twab: 250n }));
    const r = computeAllocations(inputs, 1000n, 40n, 0n, referrals);
    expect(r.boostScaled).toBe(true);
    expect(r.totalBoost).toBeLessThanOrEqual(40n);
    expect(r.totalBoost).toBeGreaterThan(0n);
    // scaled proportionally: all equal twab → all equal boost
    const boosts = new Set(r.allocations.map((a) => a.boost));
    expect(boosts.size).toBe(1);
    expect(boosts.has(10n)).toBe(true); // 25 raw * 40 / 100
  });

  test("no scaling recorded when the budget suffices", () => {
    const referrals = new Map([binding(account(1), account(9))]);
    const r = computeAllocations([{ account: account(1), twab: 100n }], 1000n, 1000n, 0n, referrals);
    expect(r.boostScaled).toBe(false);
    expect(r.totalBoost).toBe(100n);
  });

  test("empty input set yields empty allocations", () => {
    const r = computeAllocations([], 1000n, 100n, 0n, new Map());
    expect(r.allocations).toEqual([]);
    expect(r.totalBase).toBe(0n);
    expect(r.totalBoost).toBe(0n);
  });

  test("allocations are sorted by account for a deterministic dataset", () => {
    const r = computeAllocations(
      [
        { account: account(0xee), twab: 10n },
        { account: account(0x11), twab: 10n },
        { account: account(0x99), twab: 10n },
      ],
      300n,
      0n,
      0n,
      new Map(),
    );
    const sorted = [...r.allocations.map((a) => a.account.toLowerCase())].sort();
    expect(r.allocations.map((a) => a.account.toLowerCase())).toEqual(sorted);
  });
});
