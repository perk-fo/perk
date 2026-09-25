/**
 * LP Grant activation arithmetic that mirrors LPGrantVault (v0.14): the invitee boost earned by activating base, and
 * fitting an activation into the campaign's one shared inventory.
 */

/** The vault's invitee boost rate (LPGrantVault INVITEE_BOOST_BPS): 10% of the base actually activated. */
const INVITEE_BOOST_BPS = 1_000n;
const BPS = 10_000n;

/**
 * Invitee boost claimable in an activation that also takes `base`: the vault processes base first, so the boost that
 * base earns can be taken in the same call. Mirrors LPGrantVault: earned = min(cap, 10% of cumulative base activated).
 */
export function boostClaimableWith(
  base: bigint,
  a: { inviteeBoost: bigint; baseActivated: bigint; boostActivated: bigint },
): bigint {
  const earnedCum = ((a.baseActivated + base) * INVITEE_BOOST_BPS) / BPS;
  const earned = earnedCum < a.inviteeBoost ? earnedCum : a.inviteeBoost;
  return earned > a.boostActivated ? earned - a.boostActivated : 0n;
}

/**
 * Fit an activation into the shared inventory left: base first (it decays), then the boost it earns, then credit.
 * Returns the amounts to send and whether anything was cut.
 */
export function capToInventory(
  want: { base: bigint; boost: bigint; credit: bigint },
  remaining: bigint | undefined,
): { base: bigint; boost: bigint; credit: bigint; capped: boolean } {
  if (remaining === undefined) return { ...want, capped: false };
  const min = (x: bigint, y: bigint) => (x < y ? x : y);
  const base = min(want.base, remaining);
  const boost = min(want.boost, remaining - base);
  const credit = min(want.credit, remaining - base - boost);
  return { base, boost, credit, capped: base + boost + credit < want.base + want.boost + want.credit };
}
