/**
 * Ordinary liquidity through the Uniswap v4 PositionManager.
 *
 * This is the plain market-making path, open to anyone once a launch has graduated into its pool. It is separate
 * from the LP Grant flow: a grant position is minted and owned by the vault on a beneficiary's behalf and settles
 * under the grant's own rules, whereas a position minted here belongs to the wallet outright and behaves like any
 * other v4 position.
 *
 * The PositionManager takes a command tape rather than one call per operation: a packed byte string of actions and
 * a matching array of ABI-encoded parameters, executed atomically by `modifyLiquidities`.
 */
import { encodeAbiParameters, maxUint128, parseAbiParameters, type Address, type Hex } from "viem";

/** v4-periphery `Actions`. */
export const ACTION = {
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
} as const;

/** The native currency is address zero in a v4 pool key. */
export const NATIVE = "0x0000000000000000000000000000000000000000" as Address;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const POOL_KEY_PARAMS = parseAbiParameters(
  "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 tickLower, int24 tickUpper, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData",
);

const DECREASE_PARAMS = parseAbiParameters(
  "uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData",
);

const BURN_PARAMS = parseAbiParameters("uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData");

const PAIR_PARAMS = parseAbiParameters("address currency0, address currency1");
const SWEEP_PARAMS = parseAbiParameters("address currency, address to");
const TAKE_PAIR_PARAMS = parseAbiParameters("address currency0, address currency1, address recipient");

function tape(actions: readonly number[]): Hex {
  return `0x${actions.map((a) => a.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Widest tick range the pool's spacing allows. Full range is what graduation itself uses, and it keeps the position
 * in range for the whole price curve, which is the behaviour a first-time liquidity provider expects.
 */
export function fullRange(tickSpacing: number): { tickLower: number; tickUpper: number } {
  const MAX_TICK = 887272;
  const usable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower: -usable, tickUpper: usable };
}

/**
 * Mint a new full-range position and pay for it from the wallet.
 *
 * With a native currency0 the wallet sends `amount0Max` as the transaction value, but SETTLE_PAIR pays only the exact
 * debt; whatever is left stays in the PositionManager, where the next caller's SWEEP would take it. So the tape ends
 * with SWEEP(currency0, owner), returning the unused native amount in the same transaction.
 */
export function encodeMint(input: {
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
}): { actions: Hex; params: Hex[] } {
  const native0 = input.key.currency0.toLowerCase() === NATIVE;
  const actions: number[] = [ACTION.MINT_POSITION, ACTION.SETTLE_PAIR];
  const params: Hex[] = [
    encodeAbiParameters(POOL_KEY_PARAMS, [
      input.key,
      input.tickLower,
      input.tickUpper,
      input.liquidity,
      input.amount0Max,
      input.amount1Max,
      input.owner,
      "0x",
    ]),
    encodeAbiParameters(PAIR_PARAMS, [input.key.currency0, input.key.currency1]),
  ];
  if (native0) {
    actions.push(ACTION.SWEEP);
    params.push(encodeAbiParameters(SWEEP_PARAMS, [input.key.currency0, input.owner]));
  }
  return { actions: tape(actions), params };
}

/**
 * Collect fees without touching principal: v4 has no separate collect, so a zero-liquidity decrease followed by a
 * take sweeps whatever has accrued.
 */
export function encodeCollect(input: { tokenId: bigint; key: PoolKey; recipient: Address }): {
  actions: Hex;
  params: Hex[];
} {
  return {
    actions: tape([ACTION.DECREASE_LIQUIDITY, ACTION.TAKE_PAIR]),
    params: [
      encodeAbiParameters(DECREASE_PARAMS, [input.tokenId, 0n, 0n, 0n, "0x"]),
      encodeAbiParameters(TAKE_PAIR_PARAMS, [input.key.currency0, input.key.currency1, input.recipient]),
    ],
  };
}

/** Withdraw part of a position, leaving it open. */
export function encodeDecrease(input: {
  tokenId: bigint;
  key: PoolKey;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
}): { actions: Hex; params: Hex[] } {
  return {
    actions: tape([ACTION.DECREASE_LIQUIDITY, ACTION.TAKE_PAIR]),
    params: [
      encodeAbiParameters(DECREASE_PARAMS, [
        input.tokenId,
        input.liquidity,
        input.amount0Min,
        input.amount1Min,
        "0x",
      ]),
      encodeAbiParameters(TAKE_PAIR_PARAMS, [input.key.currency0, input.key.currency1, input.recipient]),
    ],
  };
}

/** Close a position entirely: burn it and take everything, principal and accrued fees together. */
export function encodeBurn(input: {
  tokenId: bigint;
  key: PoolKey;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
}): { actions: Hex; params: Hex[] } {
  return {
    actions: tape([ACTION.BURN_POSITION, ACTION.TAKE_PAIR]),
    params: [
      encodeAbiParameters(BURN_PARAMS, [input.tokenId, input.amount0Min, input.amount1Min, "0x"]),
      encodeAbiParameters(TAKE_PAIR_PARAMS, [input.key.currency0, input.key.currency1, input.recipient]),
    ],
  };
}

/** `modifyLiquidities` takes the tape and parameters as one encoded blob. */
export function encodeUnlockData(actions: Hex, params: readonly Hex[]): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), [actions, [...params]]);
}

/**
 * Liquidity for a pair of maximum amounts at the current price, using the standard v4 formulas. Whichever side
 * binds first decides the result, so the wallet never has to supply more than it offered.
 */
export function liquidityForAmounts(input: {
  sqrtPriceX96: bigint;
  sqrtPriceAX96: bigint;
  sqrtPriceBX96: bigint;
  amount0: bigint;
  amount1: bigint;
}): bigint {
  const Q96 = 1n << 96n;
  let { sqrtPriceAX96: a, sqrtPriceBX96: b } = input;
  if (a > b) [a, b] = [b, a];
  const p = input.sqrtPriceX96;
  if (p <= a) return (input.amount0 * ((a * b) / Q96)) / (b - a);
  if (p >= b) return (input.amount1 * Q96) / (b - a);
  const l0 = (input.amount0 * ((p * b) / Q96)) / (b - p);
  const l1 = (input.amount1 * Q96) / (p - a);
  return l0 < l1 ? l0 : l1;
}

export const MAX_UINT128 = maxUint128;
