import { getAddress, type Address, type Hex } from "viem";
import type { Allocation } from "./allocations";
import { buildTree, type LeafTuple } from "./merkle";

export const TOOL_VERSION = "0.1.0";

/**
 * The public snapshot dataset (PRD 6.2: the dataset is published so anyone can recompute it).
 * All bigints are serialized as decimal strings. Anyone can recompute the root with
 * `bun run src/cli/verify.ts <dataset.json>`.
 */
export interface SnapshotDataset {
  chainId: number;
  meme: Address;
  quote: Address;
  cutoffBlock: string;
  windowBlocks: string;
  step: string;
  excluded: Address[];
  inputs: {
    basePool: string;
    referralBudget: string;
    minAllocation: string;
    boostScaled: boolean;
    eligibleAccounts: number;
    fromBlock: string;
    avgBlockTimeMs?: string;
  };
  allocations: { account: Address; twab: string; base: string; boost: string }[];
  totals: { base: string; boost: string; twab: string; accounts: number };
  root: Hex;
  generatedAt: string;
  toolVersion: string;
}

export interface BuildDatasetParams {
  chainId: number;
  meme: Address;
  quote: Address;
  cutoffBlock: bigint;
  windowBlocks: bigint;
  step: bigint;
  basePool: bigint;
  referralBudget: bigint;
  minAllocation: bigint;
  boostScaled: boolean;
  eligibleAccounts: number;
  fromBlock: bigint;
  avgBlockTimeMs?: bigint;
  allocations: readonly Allocation[];
  root: Hex;
  generatedAt?: Date;
}

export function buildDataset(p: BuildDatasetParams): SnapshotDataset {
  let totalBase = 0n;
  let totalBoost = 0n;
  let totalTwab = 0n;
  for (const a of p.allocations) {
    totalBase += a.base;
    totalBoost += a.boost;
    totalTwab += a.twab;
  }
  return {
    chainId: p.chainId,
    meme: getAddress(p.meme),
    quote: getAddress(p.quote),
    cutoffBlock: p.cutoffBlock.toString(),
    windowBlocks: p.windowBlocks.toString(),
    step: p.step.toString(),
    excluded: [],
    inputs: {
      basePool: p.basePool.toString(),
      referralBudget: p.referralBudget.toString(),
      minAllocation: p.minAllocation.toString(),
      boostScaled: p.boostScaled,
      eligibleAccounts: p.eligibleAccounts,
      fromBlock: p.fromBlock.toString(),
      ...(p.avgBlockTimeMs !== undefined ? { avgBlockTimeMs: p.avgBlockTimeMs.toString() } : {}),
    },
    allocations: p.allocations.map((a) => ({
      account: getAddress(a.account),
      twab: a.twab.toString(),
      base: a.base.toString(),
      boost: a.boost.toString(),
    })),
    totals: {
      base: totalBase.toString(),
      boost: totalBoost.toString(),
      twab: totalTwab.toString(),
      accounts: p.allocations.length,
    },
    root: p.root,
    generatedAt: (p.generatedAt ?? new Date()).toISOString(),
    toolVersion: TOOL_VERSION,
  };
}

/** Extract the Merkle leaves from a dataset (checks that the JSON parses into sane values). */
export function leavesFromDataset(dataset: SnapshotDataset): LeafTuple[] {
  if (!Array.isArray(dataset.allocations) || dataset.allocations.length === 0) {
    throw new Error("dataset has no allocations");
  }
  return dataset.allocations.map((a, i) => {
    try {
      return [getAddress(a.account), BigInt(a.base), BigInt(a.boost)] as LeafTuple;
    } catch {
      throw new Error(`dataset allocation #${i} is malformed`);
    }
  });
}

/**
 * Independent recomputation: rebuild the tree purely from the allocations array and
 * compare against the recorded root. This is what a third party runs during the
 * `rootDelaySeconds` window between proposeRoot and activateRoot.
 */
export function recomputeRoot(dataset: SnapshotDataset): { root: Hex; matches: boolean } {
  const { root } = buildTree(leavesFromDataset(dataset));
  const recorded = (dataset.root ?? "").toLowerCase();
  return { root, matches: root.toLowerCase() === recorded };
}

export function parseDataset(json: string): SnapshotDataset {
  const d = JSON.parse(json) as SnapshotDataset;
  for (const key of ["chainId", "meme", "quote", "cutoffBlock", "allocations", "totals", "root"] as const) {
    if (d[key] === undefined) throw new Error(`dataset is missing "${key}"`);
  }
  return d;
}
