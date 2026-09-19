import { describe, expect, test } from "bun:test";
import { getAddress, type Address } from "viem";
import { computeAllocations } from "../src/allocations";
import { buildDataset, leavesFromDataset, parseDataset, recomputeRoot, type SnapshotDataset } from "../src/dataset";
import { buildTree, verifyProof, type LeafTuple } from "../src/merkle";

function account(n: number): Address {
  return getAddress(`0x${n.toString(16).padStart(40, "0")}`);
}

const MEME = getAddress("0xb4E911d58E50aC6B6020c391790EbdCc8dCD5668");
const QUOTE = getAddress("0x0000000000000000000000000000000000000000");

function makeDataset(): SnapshotDataset {
  const inputs = [1, 2, 3, 4].map((i) => ({ account: account(i), twab: 1000n * BigInt(i) }));
  const result = computeAllocations(inputs, 10n ** 24n, 10n ** 23n, 0n, new Map());
  const leaves: LeafTuple[] = result.allocations.map((a) => [a.account, a.base, a.boost]);
  const tree = buildTree(leaves);
  return buildDataset({
    chainId: 1952,
    meme: MEME,
    quote: QUOTE,
    cutoffBlock: 41179664n,
    windowBlocks: 302400n,
    step: 300n,
    basePool: 10n ** 24n,
    referralBudget: 10n ** 23n,
    minAllocation: 0n,
    boostScaled: result.boostScaled,
    eligibleAccounts: inputs.length,
    fromBlock: 0n,
    allocations: result.allocations,
    root: tree.root,
    generatedAt: new Date("2026-09-17T00:00:00Z"),
  });
}

describe("dataset + verify", () => {
  test("recomputed root matches an untampered dataset", () => {
    const dataset = makeDataset();
    const { matches } = recomputeRoot(dataset);
    expect(matches).toBe(true);
  });

  test("survives a JSON round-trip (bigints as decimal strings)", () => {
    const dataset = parseDataset(JSON.stringify(makeDataset()));
    expect(recomputeRoot(dataset).matches).toBe(true);
    expect(dataset.totals.accounts).toBe(4);
    expect(dataset.toolVersion).toBeTruthy();
  });

  test("detects a tampered allocation (verify CLI logic → MISMATCH)", () => {
    const dataset = makeDataset();
    const tampered: SnapshotDataset = structuredClone(dataset);
    tampered.allocations[0].base = (BigInt(tampered.allocations[0].base) + 1n).toString();
    const { matches, root } = recomputeRoot(tampered);
    expect(matches).toBe(false);
    expect(root).not.toBe(tampered.root);
  });

  test("detects a tampered root", () => {
    const dataset = makeDataset();
    dataset.root = `0x${"11".repeat(32)}`;
    expect(recomputeRoot(dataset).matches).toBe(false);
  });

  test("rejects malformed datasets", () => {
    expect(() => parseDataset("{}")).toThrow();
    const dataset = makeDataset();
    dataset.allocations[0].account = "not-an-address" as Address;
    expect(() => leavesFromDataset(dataset)).toThrow();
  });

  test("proofs from the dataset leaves verify against the root", () => {
    const dataset = makeDataset();
    const leaves = leavesFromDataset(dataset);
    const tree = buildTree(leaves);
    for (const [acc, base, boost] of leaves) {
      expect(verifyProof(dataset.root, acc, base, boost, tree.proofFor(acc))).toBe(true);
    }
  });
});
