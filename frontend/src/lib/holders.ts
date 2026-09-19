import type { Address } from "viem";

/** Holder rows come from @perk/api; the fold helpers below stay for tests and offline tooling. */

export interface HolderRow {
  address: Address;
  balance: bigint;
}

/** Fold ERC-20 Transfer logs into lowercased address → balance. */
export function foldTransfers(
  logs: ReadonlyArray<{ args?: { from?: Address; to?: Address; value?: bigint } }>,
): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  const add = (addr: string, delta: bigint) => {
    const a = addr.toLowerCase();
    bal.set(a, (bal.get(a) ?? 0n) + delta);
  };
  for (const log of logs) {
    const { from, to, value } = log.args ?? {};
    if (!from || !to || value === undefined) continue;
    add(from, -value);
    add(to, value);
  }
  return bal;
}

export function positiveBalances(map: Map<string, bigint>): HolderRow[] {
  const out: HolderRow[] = [];
  for (const [addr, balance] of map) {
    if (balance > 0n) out.push({ address: addr as Address, balance });
  }
  return out;
}

export function topHolders(
  rows: HolderRow[],
  excluded: Set<string>,
  limit = 10,
): { holders: HolderRow[]; count: number; excludedSum: bigint } {
  let excludedSum = 0n;
  const kept: HolderRow[] = [];
  for (const row of rows) {
    if (excluded.has(row.address.toLowerCase())) {
      excludedSum += row.balance;
      continue;
    }
    kept.push(row);
  }
  kept.sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1));
  return { holders: kept.slice(0, limit), count: kept.length, excludedSum };
}
