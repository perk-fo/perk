import { openPosition, valueAt } from "./lp.ts";

export type GrantInput = {
  quoteDeposited: number;
  grantMeme: number;
  p0: number;
  pricePath: readonly number[];
  dailyVolumeToLiquidity: number;
  lpFeeBps?: number;
  buyShare?: number;
};

export type GrantResult = {
  quoteToUser: number;
  pnl: number;
  excessToTreasury: number;
  memeBurned: number;
  quoteFees: number;
  quotePrincipalOut: number;
  memePrincipalOut: number;
  memeFees: number;
};

const DEFAULT_LP_FEE_BPS = 15;
const DEFAULT_BUY_SHARE = 0.5;

/**
 * LP Grant payoff (PRD 6.9 / appendix B).
 *
 * Principal is a full-range position opened at `p0` with `(quoteDeposited, grantMeme)`.
 * Fees accrue daily on volume = `dailyVolumeToLiquidity * TVL`: buy volume pays the
 * LP fee in quote (kept); sell volume pays in meme (burned). At exit, quote principal
 * is capped at the deposited amount; excess quote goes to treasury; all meme is burned.
 */
export function simulateGrant(input: GrantInput): GrantResult {
  const lpFeeBps = input.lpFeeBps ?? DEFAULT_LP_FEE_BPS;
  const buyShare = input.buyShare ?? DEFAULT_BUY_SHARE;
  const Q = input.quoteDeposited;
  const feeRate = lpFeeBps / 10_000;
  const L = openPosition(Q, input.grantMeme, input.p0);

  let quoteFees = 0;
  let memeFees = 0;
  let lastPrice = input.p0;

  for (const price of input.pricePath) {
    if (!(price > 0)) {
      throw new RangeError("non-positive price in path");
    }
    lastPrice = price;
    const marked = valueAt(L, price);
    const tvl = marked.quote + marked.meme * price;
    const volume = input.dailyVolumeToLiquidity * tvl;
    const buyVol = buyShare * volume;
    const sellVol = (1 - buyShare) * volume;
    quoteFees += buyVol * feeRate;
    memeFees += (sellVol / price) * feeRate;
  }

  const principal = valueAt(L, lastPrice);
  const quotePrincipalOut = principal.quote;
  const memePrincipalOut = principal.meme;
  const quoteToUser = Math.min(quotePrincipalOut, Q) + quoteFees;
  const excessToTreasury = Math.max(quotePrincipalOut - Q, 0);
  const memeBurned = memePrincipalOut + memeFees;
  const pnl = quoteToUser - Q;

  return {
    quoteToUser,
    pnl,
    excessToTreasury,
    memeBurned,
    quoteFees,
    quotePrincipalOut,
    memePrincipalOut,
    memeFees,
  };
}
