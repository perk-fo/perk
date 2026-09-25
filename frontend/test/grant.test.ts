import { describe, expect, test } from "bun:test";
import { boostClaimableWith, capToInventory } from "@/lib/grant";

const E = 10n ** 18n;

describe("boostClaimableWith", () => {
  test("is 10% of the base taken in the same activation", () => {
    expect(boostClaimableWith(1_000n * E, { inviteeBoost: 500n * E, baseActivated: 0n, boostActivated: 0n })).toBe(100n * E);
  });
  test("never goes past the listed cap", () => {
    expect(boostClaimableWith(10_000n * E, { inviteeBoost: 500n * E, baseActivated: 0n, boostActivated: 0n })).toBe(500n * E);
  });
  test("counts earlier base and subtracts boost already taken", () => {
    // 10% of (2,000 + 1,000) = 300, minus 150 taken
    expect(boostClaimableWith(1_000n * E, { inviteeBoost: 500n * E, baseActivated: 2_000n * E, boostActivated: 150n * E })).toBe(
      150n * E,
    );
  });
  test("is zero with no boost listed", () => {
    expect(boostClaimableWith(1_000n * E, { inviteeBoost: 0n, baseActivated: 0n, boostActivated: 0n })).toBe(0n);
  });
});

describe("capToInventory", () => {
  test("leaves an activation that fits alone", () => {
    expect(capToInventory({ base: 100n, boost: 10n, credit: 5n }, 200n)).toEqual({ base: 100n, boost: 10n, credit: 5n, capped: false });
  });
  test("fills base first, then boost, then credit", () => {
    expect(capToInventory({ base: 100n, boost: 10n, credit: 5n }, 105n)).toEqual({ base: 100n, boost: 5n, credit: 0n, capped: true });
    expect(capToInventory({ base: 100n, boost: 10n, credit: 5n }, 60n)).toEqual({ base: 60n, boost: 0n, credit: 0n, capped: true });
  });
  test("an empty inventory leaves nothing to send", () => {
    expect(capToInventory({ base: 100n, boost: 10n, credit: 5n }, 0n)).toEqual({ base: 0n, boost: 0n, credit: 0n, capped: true });
  });
  test("an unknown inventory does not cap", () => {
    expect(capToInventory({ base: 1n, boost: 0n, credit: 0n }, undefined).capped).toBe(false);
  });
});
