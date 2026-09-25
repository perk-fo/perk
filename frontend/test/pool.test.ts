import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, parseAbiParameters, type Address } from "viem";
import {
  ACTION,
  encodeBurn,
  encodeCollect,
  encodeMint,
  encodeUnlockData,
  fullRange,
  liquidityForAmounts,
  NATIVE,
  type PoolKey,
} from "../src/lib/pool";

const KEY: PoolKey = {
  currency0: NATIVE,
  currency1: "0x00000000000000000000000000000000000000aa" as Address,
  fee: 8500,
  tickSpacing: 60,
  hooks: "0x00000000000000000000000000000000000000bb" as Address,
};
const OWNER = "0x00000000000000000000000000000000000000cc" as Address;

describe("full range", () => {
  test("snaps to the widest multiple of the spacing, symmetrically", () => {
    const r = fullRange(60);
    expect(r.tickUpper).toBe(887220);
    expect(r.tickLower).toBe(-887220);
    expect(r.tickUpper % 60).toBe(0);
    // a different spacing still lands inside the protocol's bound
    expect(fullRange(200).tickUpper).toBe(887200);
    expect(fullRange(1).tickUpper).toBe(887272);
  });
});

describe("action tapes", () => {
  test("mint with native currency0 pays for the position, then sweeps the unused native back to the owner", () => {
    const { actions, params } = encodeMint({
      key: KEY,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: 1_000n,
      amount0Max: 10n,
      amount1Max: 20n,
      owner: OWNER,
    });
    // MINT_POSITION, SETTLE_PAIR, SWEEP: without the sweep the rest of msg.value stays in the PositionManager
    expect(actions).toBe("0x020d14");
    expect(params).toHaveLength(3);
    const [, , , liquidity, a0, a1, owner] = decodeAbiParameters(
      parseAbiParameters(
        "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks), int24, int24, uint256, uint128, uint128, address, bytes",
      ),
      params[0]!,
    );
    expect(liquidity).toBe(1_000n);
    expect(a0).toBe(10n);
    expect(a1).toBe(20n);
    expect((owner as string).toLowerCase()).toBe(OWNER);
    const [currency, to] = decodeAbiParameters(parseAbiParameters("address, address"), params[2]!);
    expect(currency).toBe(NATIVE);
    expect((to as string).toLowerCase()).toBe(OWNER);
  });

  test("mint with two ERC-20s settles exactly and needs no sweep", () => {
    const erc20Key: PoolKey = { ...KEY, currency0: "0x0000000000000000000000000000000000000011" as Address };
    const { actions, params } = encodeMint({
      key: erc20Key,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: 1_000n,
      amount0Max: 10n,
      amount1Max: 20n,
      owner: OWNER,
    });
    expect(actions).toBe(`0x${ACTION.MINT_POSITION.toString(16).padStart(2, "0")}0d`);
    expect(params).toHaveLength(2);
  });

  test("collect is a zero-liquidity decrease so principal is untouched", () => {
    const { actions, params } = encodeCollect({ tokenId: 5n, key: KEY, recipient: OWNER });
    expect(actions).toBe("0x0111");
    const [tokenId, liquidity] = decodeAbiParameters(
      parseAbiParameters("uint256, uint256, uint128, uint128, bytes"),
      params[0]!,
    );
    expect(tokenId).toBe(5n);
    expect(liquidity).toBe(0n); // the whole point: fees only
  });

  test("burn closes the position and takes both sides", () => {
    const { actions } = encodeBurn({ tokenId: 9n, key: KEY, amount0Min: 0n, amount1Min: 0n, recipient: OWNER });
    expect(actions).toBe("0x0311");
  });

  test("unlock data carries the tape and its parameters together", () => {
    const { actions, params } = encodeCollect({ tokenId: 1n, key: KEY, recipient: OWNER });
    const [tape, decoded] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), encodeUnlockData(actions, params));
    expect(tape).toBe(actions);
    expect(decoded).toHaveLength(2);
  });
});

describe("liquidity sizing", () => {
  const Q96 = 1n << 96n;
  const A = Q96 / 100n; // far below
  const B = Q96 * 100n; // far above

  test("the smaller side binds, so neither maximum is exceeded", () => {
    const plenty = liquidityForAmounts({ sqrtPriceX96: Q96, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 10n ** 18n, amount1: 10n ** 18n });
    const short0 = liquidityForAmounts({ sqrtPriceX96: Q96, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 1n, amount1: 10n ** 18n });
    const short1 = liquidityForAmounts({ sqrtPriceX96: Q96, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 10n ** 18n, amount1: 1n });
    expect(short0).toBeLessThan(plenty);
    expect(short1).toBeLessThan(plenty);
  });

  test("outside the range only one asset is needed", () => {
    const below = liquidityForAmounts({ sqrtPriceX96: A / 2n, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 10n ** 18n, amount1: 0n });
    const above = liquidityForAmounts({ sqrtPriceX96: B * 2n, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 0n, amount1: 10n ** 18n });
    expect(below).toBeGreaterThan(0n);
    expect(above).toBeGreaterThan(0n);
  });

  test("nothing in, nothing out", () => {
    expect(liquidityForAmounts({ sqrtPriceX96: Q96, sqrtPriceAX96: A, sqrtPriceBX96: B, amount0: 0n, amount1: 0n })).toBe(0n);
  });
});
