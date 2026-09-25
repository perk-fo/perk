import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { fromChain, hasKnownDecimals } from "@/lib/quotes";
import type { Deployment } from "@/lib/deployments";

const DEPLOYMENT = { xdogToken: "0x00000000000000000000000000000000000000dd" } as unknown as Deployment;
const TAAPL = { address: "0x00000000000000000000000000000000000000aa" as Address, symbol: "tAAPL" };
const OKB = { address: "0x0000000000000000000000000000000000000000" as Address, symbol: "OKB" };

describe("quote metadata from the chain", () => {
  test("an ERC-20 whose AssetRegistry read failed has unknown decimals, not 18", () => {
    const q = fromChain(TAAPL, DEPLOYMENT, undefined);
    expect(q.decimals).toBeNull();
    expect(hasKnownDecimals(q)).toBe(false);
  });

  test("the registry's decimals are used when the read succeeds", () => {
    const q = fromChain(TAAPL, DEPLOYMENT, { enabled: true, rewardCompatible: true, isNative: false, decimals: 6, symbol: "tAAPL" });
    expect(q.decimals).toBe(6);
    expect(hasKnownDecimals(q)).toBe(true);
  });

  test("native OKB is 18 decimals by definition", () => {
    const q = fromChain(OKB, DEPLOYMENT, undefined);
    expect(q.decimals).toBe(18);
    expect(hasKnownDecimals(q)).toBe(true);
  });

  test("no quote at all is not a known quote", () => {
    expect(hasKnownDecimals(undefined)).toBe(false);
  });
});
