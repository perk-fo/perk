/** 1e18 fixed-point scale used by the Solidity curve for prices. */
export const WAD = 10n ** 18n;

/** Basis-point denominator. Matches PerkConstants.BPS. */
export const BPS = 10_000n;

/** Virtual reserves of one bonding-curve instance. */
export type CurveState = {
  virtualQuote: bigint;
  virtualMeme: bigint;
};

/**
 * Floor(a * b / denominator). Matches OpenZeppelin Math.mulDiv with rounding down.
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("mulDiv division by zero");
  }
  return (a * b) / denominator;
}

/**
 * Protocol fee with ceil rounding so the protocol never under-collects:
 * `ceil(amount * bps / BPS)`.
 */
export function feeCeil(amount: bigint, bps: bigint): bigint {
  if (amount === 0n || bps === 0n) {
    return 0n;
  }
  return (amount * bps + BPS - 1n) / BPS;
}

/**
 * Buy `qn` net quote against the constant-product curve.
 * `memeOut = mulDiv(Mv, qn, Qv + qn)` (floor). Equivalent to the real-valued
 * `Mv - Qv*Mv/(Qv+qn)` and to `memeSoldAtGraduation` for a single fill of `T`.
 * Flooring the output (not `Mv - floor(k/(Qv+qn))`) keeps `k` from decreasing.
 */
export function buyNet(state: CurveState, qn: bigint): { memeOut: bigint; state: CurveState } {
  const Qv = state.virtualQuote;
  const Mv = state.virtualMeme;
  const memeOut = mulDiv(Mv, qn, Qv + qn);
  return {
    memeOut,
    state: { virtualQuote: Qv + qn, virtualMeme: Mv - memeOut },
  };
}

/**
 * Sell `m` meme against the constant-product curve.
 * `quoteGross = mulDiv(Qv, m, Mv + m)` (floor).
 */
export function sell(state: CurveState, m: bigint): { quoteGross: bigint; state: CurveState } {
  const Qv = state.virtualQuote;
  const Mv = state.virtualMeme;
  const quoteGross = mulDiv(Qv, m, Mv + m);
  return {
    quoteGross,
    state: { virtualQuote: Qv - quoteGross, virtualMeme: Mv + m },
  };
}

/**
 * Meme sold when net quote on the curve hits `T`:
 * `mulDiv(vM, T, vQ + T)`.
 */
export function memeSoldAtGraduation(vQ: bigint, vM: bigint, T: bigint): bigint {
  return mulDiv(vM, T, vQ + T);
}

/**
 * Curve final price at graduation, quote per 1e18 meme, scaled by 1e18:
 * `mulDiv(vQ + T, 1e18, vM - sold)`.
 */
export function finalPriceX18(vQ: bigint, vM: bigint, T: bigint): bigint {
  const sold = memeSoldAtGraduation(vQ, vM, T);
  return mulDiv(vQ + T, WAD, vM - sold);
}
