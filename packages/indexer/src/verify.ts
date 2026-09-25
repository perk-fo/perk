/**
 * Dataset checks shared by the verify and propose CLIs. The vault checks a proposed root only against the budgets
 * the proposer declares, never against the leaves, so the review window is where an over-allocating or duplicated
 * list has to be caught. Everything here is recomputed from the leaves; the file's own `totals` are only compared,
 * never trusted.
 */
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { CampaignStatus } from "./abi";
import { BPS_DENOMINATOR, INVITEE_BOOST_BPS } from "./allocations";
import type { CampaignView } from "./chain";
import type { SnapshotDataset } from "./dataset";
import { buildExclusions } from "./exclusions";
import { buildTree, type LeafTuple } from "./merkle";

export interface LeafSums {
  base: bigint;
  boost: bigint;
  twab: bigint;
  accounts: number;
}

export interface DatasetReport {
  /** Everything wrong with the dataset; empty when it passes. */
  problems: string[];
  /** Root rebuilt from the leaves (null when the leaves could not be parsed). */
  root: Hex | null;
  rootMatches: boolean;
  /** Sums recomputed from the leaves. */
  sums: LeafSums;
}

function big(value: unknown, what: string, problems: string[]): bigint | null {
  try {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") throw new Error();
    const v = BigInt(value);
    if (v < 0n) throw new Error();
    return v;
  } catch {
    problems.push(`${what} is not a non-negative integer`);
    return null;
  }
}

/** The addresses no dataset may allocate to, independent of what the dataset itself lists. */
export function requiredExclusions(dataset: SnapshotDataset, system: readonly string[] = [], hook?: string): Address[] {
  return buildExclusions({ system, meme: dataset.meme, quote: dataset.quote, hook });
}

/**
 * Offline checks: parse every leaf, rebuild the root, reject duplicate (case-insensitive) and excluded accounts,
 * recompute the sums and hold them against the budgets recorded in the dataset and against its declared totals,
 * and check each leaf against the allocation rules (boost at most 10% of base, base at least minAllocation, and
 * base = floor(basePool * twab / eligibleTwab) when the dataset records eligibleTwab).
 * `excluded` adds to the dataset's own list (the verifier's independent exclusion list).
 */
export function checkDataset(dataset: SnapshotDataset, opts: { excluded?: readonly string[] } = {}): DatasetReport {
  const problems: string[] = [];
  const sums: LeafSums = { base: 0n, boost: 0n, twab: 0n, accounts: 0 };

  if (!Array.isArray(dataset.allocations) || dataset.allocations.length === 0) {
    return { problems: ["dataset has no allocations"], root: null, rootMatches: false, sums };
  }

  const excluded = new Set<string>();
  for (const a of [...(Array.isArray(dataset.excluded) ? dataset.excluded : []), ...(opts.excluded ?? [])]) {
    if (typeof a === "string" && isAddress(a, { strict: false })) excluded.add(a.toLowerCase());
  }
  for (const a of requiredExclusions(dataset)) excluded.add(a.toLowerCase());

  const inputs = (dataset.inputs ?? {}) as Partial<SnapshotDataset["inputs"]>;
  const basePool = big(inputs.basePool, "inputs.basePool", problems);
  const referralBudget = big(inputs.referralBudget, "inputs.referralBudget", problems);
  const minAllocation = inputs.minAllocation === undefined ? 0n : big(inputs.minAllocation, "inputs.minAllocation", problems);
  const eligibleTwab =
    inputs.eligibleTwab === undefined ? undefined : big(inputs.eligibleTwab, "inputs.eligibleTwab", problems);

  const leaves: LeafTuple[] = [];
  const seen = new Map<string, number>();
  dataset.allocations.forEach((a, i) => {
    const where = `allocation #${i}`;
    if (!a || typeof a !== "object" || typeof a.account !== "string" || !isAddress(a.account, { strict: false })) {
      problems.push(`${where} has no valid account`);
      return;
    }
    const account = getAddress(a.account);
    const key = account.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) problems.push(`${where}: ${account} is a duplicate of allocation #${first}`);
    else seen.set(key, i);
    if (excluded.has(key)) problems.push(`${where}: ${account} is an excluded address`);

    const base = big(a.base, `${where} base`, problems);
    const boost = big(a.boost, `${where} boost`, problems);
    const twab = a.twab === undefined ? 0n : big(a.twab, `${where} twab`, problems);
    if (base === null || boost === null) return;
    leaves.push([account, base, boost]);
    sums.base += base;
    sums.boost += boost;
    sums.twab += twab ?? 0n;

    if (boost * BPS_DENOMINATOR > base * INVITEE_BOOST_BPS) {
      problems.push(`${where}: ${account} has a boost of ${boost}, more than 10% of its base ${base}`);
    }
    if (minAllocation !== null && base < minAllocation) {
      problems.push(`${where}: ${account} has a base of ${base}, below minAllocation ${minAllocation}`);
    }
    if (basePool !== null && eligibleTwab !== undefined && eligibleTwab !== null && twab !== null && eligibleTwab > 0n) {
      const expected = (basePool * twab) / eligibleTwab;
      if (base !== expected) {
        problems.push(`${where}: ${account} has a base of ${base}; its twab ${twab} gives ${expected}`);
      }
    }
  });
  sums.accounts = dataset.allocations.length;

  if (basePool !== null && sums.base > basePool) {
    problems.push(`the leaves allocate ${sums.base} base, more than basePool ${basePool}`);
  }
  if (referralBudget !== null && sums.boost > referralBudget) {
    problems.push(`the leaves allocate ${sums.boost} boost, more than referralBudget ${referralBudget}`);
  }
  if (eligibleTwab !== undefined && eligibleTwab !== null && sums.twab > eligibleTwab) {
    problems.push(`the leaves' twab sums to ${sums.twab}, more than inputs.eligibleTwab ${eligibleTwab}`);
  }

  const totals = (dataset.totals ?? {}) as Partial<SnapshotDataset["totals"]>;
  const declared: [string, unknown, bigint | number][] = [
    ["base", totals.base, sums.base],
    ["boost", totals.boost, sums.boost],
    ["twab", totals.twab, sums.twab],
    ["accounts", totals.accounts, sums.accounts],
  ];
  for (const [name, value, actual] of declared) {
    let same = false;
    try {
      same = value !== undefined && BigInt(value as string) === BigInt(actual);
    } catch {
      same = false;
    }
    if (!same) problems.push(`totals.${name} is ${String(value)} but the leaves give ${actual}`);
  }

  let root: Hex | null = null;
  let rootMatches = false;
  if (leaves.length === dataset.allocations.length) {
    try {
      root = buildTree(leaves).root;
      rootMatches = typeof dataset.root === "string" && root.toLowerCase() === dataset.root.toLowerCase();
      if (!rootMatches) problems.push(`the recorded root ${String(dataset.root)} is not the root of the leaves (${root})`);
    } catch (err) {
      problems.push(`the leaves do not form a tree: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    problems.push("the root was not rebuilt because some leaves are malformed");
  }
  return { problems, root, rootMatches, sums };
}

const STATUS_NAMES = ["NONE", "AWAITING_ROOT", "ROOT_PROPOSED", "ACTIVE", "EXPIRED", "CANCELLED"];
export const statusName = (s: number): string => STATUS_NAMES[s] ?? `status ${s}`;

/**
 * On-chain checks: the chain, the campaign's quote, cutoff and budgets must be those the dataset was built from.
 * With `expectRoot` (verifying a proposed or active root), the campaign's root must be the dataset's root and the
 * totals it declared on chain must equal the leaf sums; without it (before proposing), the campaign must still be
 * waiting for a root.
 */
export function checkAgainstCampaign(
  dataset: SnapshotDataset,
  sums: LeafSums,
  onChain: { chainId: number; campaign: CampaignView },
  opts: { expectRoot: boolean },
): string[] {
  const problems: string[] = [];
  const c = onChain.campaign;
  if (onChain.chainId !== Number(dataset.chainId)) {
    problems.push(`the RPC endpoint serves chain ${onChain.chainId}; the dataset is for chain ${dataset.chainId}`);
  }
  if (c.status === CampaignStatus.NONE) {
    problems.push(`there is no grant campaign for ${dataset.meme} on chain ${onChain.chainId}`);
    return problems;
  }
  const eq = (a: unknown, b: bigint): boolean => {
    try {
      return BigInt(a as string) === b;
    } catch {
      return false;
    }
  };
  if (String(dataset.quote).toLowerCase() !== c.quote.toLowerCase()) {
    problems.push(`the dataset's quote ${dataset.quote} is not the campaign's quote ${c.quote}`);
  }
  if (!eq(dataset.cutoffBlock, c.graduatedAtBlock)) {
    problems.push(`the dataset's cutoff ${dataset.cutoffBlock} is not the campaign's graduation block ${c.graduatedAtBlock}`);
  }
  if (!eq(dataset.inputs?.basePool, c.basePool)) {
    problems.push(`the dataset's basePool ${dataset.inputs?.basePool} is not the campaign's ${c.basePool}`);
  }
  if (!eq(dataset.inputs?.referralBudget, c.referralBudget)) {
    problems.push(`the dataset's referralBudget ${dataset.inputs?.referralBudget} is not the campaign's ${c.referralBudget}`);
  }
  if (sums.base > c.basePool) problems.push(`the leaves allocate ${sums.base} base, more than the campaign's basePool ${c.basePool}`);
  if (sums.boost > c.referralBudget) {
    problems.push(`the leaves allocate ${sums.boost} boost, more than the campaign's referralBudget ${c.referralBudget}`);
  }

  if (opts.expectRoot) {
    if (c.status === CampaignStatus.AWAITING_ROOT || c.status === CampaignStatus.CANCELLED) {
      problems.push(
        `the campaign has no root to compare with (${statusName(c.status)}); before a root is proposed, check the dataset with propose`,
      );
    } else {
      if (String(dataset.root).toLowerCase() !== c.root.toLowerCase()) {
        problems.push(`the on-chain root ${c.root} is not the dataset's root ${dataset.root}`);
      }
      if (c.rootTotalBase !== sums.base) {
        problems.push(`the root was proposed with totalBase ${c.rootTotalBase}, but the leaves sum to ${sums.base}`);
      }
      if (c.rootTotalInviteeBoost !== sums.boost) {
        problems.push(
          `the root was proposed with totalInviteeBoost ${c.rootTotalInviteeBoost}, but the leaves sum to ${sums.boost}`,
        );
      }
    }
  } else if (c.status !== CampaignStatus.AWAITING_ROOT) {
    problems.push(`the campaign is ${statusName(c.status)}; a root can only be proposed while it is AWAITING_ROOT`);
  }
  return problems;
}

/** Compare a dataset with one recomputed from its recorded inputs: same root, and where not, which leaves differ. */
export function compareRecomputed(dataset: SnapshotDataset, recomputed: SnapshotDataset, limit = 10): string[] {
  if (String(dataset.root).toLowerCase() === recomputed.root.toLowerCase()) return [];
  const problems = [`recomputing from the recorded inputs gives root ${recomputed.root}, not ${dataset.root}`];
  const mine = new Map(dataset.allocations.map((a) => [String(a.account).toLowerCase(), a]));
  const theirs = new Map(recomputed.allocations.map((a) => [a.account.toLowerCase(), a]));
  const diffs: string[] = [];
  for (const [k, a] of mine) {
    const b = theirs.get(k);
    if (!b) diffs.push(`${a.account} is not in the recomputed list`);
    else if (String(a.base) !== b.base || String(a.boost) !== b.boost) {
      diffs.push(`${a.account}: base/boost ${a.base}/${a.boost}, recomputed ${b.base}/${b.boost}`);
    }
  }
  for (const [k, b] of theirs) if (!mine.has(k)) diffs.push(`${b.account} is missing from the dataset`);
  problems.push(...diffs.slice(0, limit).map((d) => `  ${d}`));
  if (diffs.length > limit) problems.push(`  … and ${diffs.length - limit} more`);
  return problems;
}
