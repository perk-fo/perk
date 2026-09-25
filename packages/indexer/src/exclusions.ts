import { getAddress, isAddress, type Address } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
/** PerkConstants.DEAD_ADDRESS: the burn sink. */
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as Address;

export interface ExclusionInputs {
  /** Contract addresses from the deployment record (see `deploymentSystemAddresses`). */
  system: readonly string[];
  meme: string;
  quote: string;
  /** The campaign pool's hook, in case it differs from the deployment's current hook. */
  hook?: string;
  /** Operator additions (--exclude / SNAPSHOT_EXCLUDE). */
  extra?: readonly string[];
}

/**
 * Accounts that never receive a grant allocation: the deployment's contracts (curve, fee router, distributor,
 * treasury, vault, locker, graduation manager, hook, factory, registries, the v4 PoolManager and PositionManager,
 * Permit2, the quote tokens), the meme and quote themselves, the zero address and 0xdead. None of them can register
 * and activate, so a share given to them is burned at finalisation and real holders are diluted by it.
 * Returned checksummed, deduplicated and sorted, as published in `dataset.excluded`.
 */
export function buildExclusions(p: ExclusionInputs): Address[] {
  const set = new Map<string, Address>();
  const add = (a: string | undefined): void => {
    if (!a) return;
    if (!isAddress(a, { strict: false })) throw new Error(`not an address in the exclusion list: ${a}`);
    const c = getAddress(a);
    set.set(c.toLowerCase(), c);
  };
  add(ZERO_ADDRESS);
  add(DEAD_ADDRESS);
  add(p.meme);
  add(p.quote);
  add(p.hook);
  for (const a of p.system) add(a);
  for (const a of p.extra ?? []) add(a);
  return [...set.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Parse a comma- or whitespace-separated address list (the --exclude flag / SNAPSHOT_EXCLUDE). */
export function parseAddressList(raw: string | undefined): Address[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .filter((s) => s !== "")
    .map((s) => {
      if (!isAddress(s, { strict: false })) throw new Error(`not an address: ${s}`);
      return getAddress(s);
    });
}

/** Drop excluded accounts from a TWAB map; returns the kept map and the excluded accounts that held a balance. */
export function applyExclusions(
  twab: Map<Address, bigint>,
  excluded: readonly Address[],
): { kept: Map<Address, bigint>; removed: { account: Address; twab: bigint }[] } {
  const ex = new Set(excluded.map((a) => a.toLowerCase()));
  const kept = new Map<Address, bigint>();
  const removed: { account: Address; twab: bigint }[] = [];
  for (const [account, value] of twab) {
    if (ex.has(account.toLowerCase())) removed.push({ account, twab: value });
    else kept.set(account, value);
  }
  return { kept, removed };
}
