import { describe, expect, test } from "bun:test";
import { bindBlock, inviteLink, isFresh, nextStoredRef, parseRef } from "@/lib/referral";

const A = "0x452563f9554079CCe44BE205c09bfdDd61898BD1" as const;
const B = "0xd4a70141689e0eF26dDFE39bcc3422513B11d0b0" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DAY = 24 * 3600 * 1000;

describe("invite links", () => {
  test("link carries the checksummed address and parses back", () => {
    const link = inviteLink("https://perk.xyz/", A.toLowerCase() as `0x${string}`);
    expect(link).toBe(`https://perk.xyz/grant?ref=${A}`);
    expect(parseRef(new URL(link).search)).toBe(A);
  });
  test("junk ref is ignored", () => {
    expect(parseRef("?ref=hello")).toBeNull();
    expect(parseRef("?x=1")).toBeNull();
  });
  test("first touch wins until it expires (30 days)", () => {
    const first = nextStoredRef(null, A, 0);
    expect(nextStoredRef(first, B, 5 * DAY).inviter).toBe(A);
    expect(nextStoredRef(first, B, 31 * DAY).inviter).toBe(B);
    expect(isFresh(first, 29 * DAY)).toBe(true);
    expect(isFresh(first, 31 * DAY)).toBe(false);
  });
});

describe("bindBlock mirrors ReferralRegistry.bindInviter", () => {
  test("bindable", () => expect(bindBlock(B, A, ZERO, ZERO)).toBeNull());
  test("self referral", () => expect(bindBlock(A, A, ZERO, ZERO)).toBe("self"));
  test("already bound", () => expect(bindBlock(B, A, A, ZERO)).toBe("alreadyBound"));
  test("mutual referral", () => expect(bindBlock(B, A, ZERO, B)).toBe("mutual"));
});
