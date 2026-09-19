/**
 * Full-range constant-product LP: `L = sqrt(quote * meme)`, `price = quote / meme`.
 * Concentrated `[pa, pb]` uses Uniswap v3 amount formulas with meme as token0
 * (price = quote per meme).
 */

export type TokenAmounts = {
  quote: number;
  meme: number;
};

/**
 * Liquidity of a full-range position. `price` is accepted so callers can pass
 * the pool price; L is `sqrt(quote * meme)`.
 */
export function openPosition(quote: number, meme: number, _price: number): number {
  if (quote < 0 || meme < 0) {
    throw new RangeError("negative reserves");
  }
  return Math.sqrt(quote * meme);
}

/**
 * Mark-to-market of a full-range position at `price` (quote per meme).
 */
export function valueAt(L: number, price: number): TokenAmounts {
  if (price <= 0 || L < 0) {
    throw new RangeError("invalid L or price");
  }
  const sqrtP = Math.sqrt(price);
  return { quote: L * sqrtP, meme: L / sqrtP };
}

/**
 * Uniswap v3 amounts from L given current and range sqrt-prices.
 * Meme is token0, quote is token1.
 */
export function amountsFromLiquidity(
  L: number,
  sqrtPrice: number,
  sqrtPa: number,
  sqrtPb: number,
): TokenAmounts {
  if (!(sqrtPa > 0) || !(sqrtPb > sqrtPa) || L < 0 || !(sqrtPrice > 0)) {
    throw new RangeError("invalid range or L");
  }
  if (sqrtPrice <= sqrtPa) {
    return { meme: L * (sqrtPb - sqrtPa) / (sqrtPa * sqrtPb), quote: 0 };
  }
  if (sqrtPrice >= sqrtPb) {
    return { meme: 0, quote: L * (sqrtPb - sqrtPa) };
  }
  return {
    meme: L * (sqrtPb - sqrtPrice) / (sqrtPrice * sqrtPb),
    quote: L * (sqrtPrice - sqrtPa),
  };
}

function liquidityFromMeme(meme: number, sqrtP: number, sqrtPb: number): number {
  if (sqrtPb <= sqrtP) {
    return 0;
  }
  return meme * (sqrtP * sqrtPb) / (sqrtPb - sqrtP);
}

function liquidityFromQuote(quote: number, sqrtP: number, sqrtPa: number): number {
  if (sqrtP <= sqrtPa) {
    return 0;
  }
  return quote / (sqrtP - sqrtPa);
}

/**
 * Max L that `quote` + `meme` can support in `[pa, pb]` at `price`.
 */
export function openPositionRange(quote: number, meme: number, price: number, pa: number, pb: number): number {
  if (!(pa > 0) || !(pb > pa) || price <= 0) {
    throw new RangeError("invalid price range");
  }
  const sqrtP = Math.sqrt(price);
  const sqrtPa = Math.sqrt(pa);
  const sqrtPb = Math.sqrt(pb);
  if (sqrtP <= sqrtPa) {
    return liquidityFromMeme(meme, sqrtPa, sqrtPb);
  }
  if (sqrtP >= sqrtPb) {
    return liquidityFromQuote(quote, sqrtPb, sqrtPa);
  }
  const l0 = liquidityFromMeme(meme, sqrtP, sqrtPb);
  const l1 = liquidityFromQuote(quote, sqrtP, sqrtPa);
  return Math.min(l0, l1);
}

/**
 * Mark-to-market of a concentrated position at `price`.
 */
export function valueAtRange(L: number, price: number, pa: number, pb: number): TokenAmounts {
  return amountsFromLiquidity(L, Math.sqrt(price), Math.sqrt(pa), Math.sqrt(pb));
}
