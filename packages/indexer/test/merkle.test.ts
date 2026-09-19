import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { buildTree, leafHash, processProof, verifyProof, type LeafTuple } from "../src/merkle";

// The same 4-leaf tree contracts/test/unit/LPGrantVault.t.sol builds by hand.
const LEAVES: LeafTuple[] = [
  [getAddress("0x1000000000000000000000000000000000000001"), 1000n, 100n],
  [getAddress("0x2000000000000000000000000000000000000002"), 2000n, 0n],
  [getAddress("0x3000000000000000000000000000000000000003"), 3000n, 300n],
  [getAddress("0x4000000000000000000000000000000000000004"), 4000n, 400n],
];

describe("merkle tree (4 leaves)", () => {
  const tree = buildTree(LEAVES);

  test("every proof verifies with the viem-side processProof (sorted pairs)", () => {
    for (const [account, base, boost] of LEAVES) {
      const proof = tree.proofFor(account);
      expect(proof.length).toBe(2); // depth of a 4-leaf tree
      const recomputed = processProof(proof, leafHash(account, base, boost));
      expect(recomputed).toBe(tree.root);
      expect(verifyProof(tree.root, account, base, boost, proof)).toBe(true);
    }
  });

  test("proofFor is case-insensitive on the account", () => {
    const lower = LEAVES[0][0].toLowerCase() as `0x${string}`;
    expect(tree.proofFor(lower)).toEqual(tree.proofFor(LEAVES[0][0]));
  });

  test("a tampered leaf does not verify", () => {
    const [account, base] = LEAVES[0];
    const proof = tree.proofFor(account);
    expect(verifyProof(tree.root, account, base + 1n, 0n, proof)).toBe(false);
    expect(verifyProof(tree.root, LEAVES[1][0], base, 0n, proof)).toBe(false);
  });

  test("proofFor throws for an unknown account", () => {
    expect(() => tree.proofFor(getAddress("0x9999999999999999999999999999999999999999"))).toThrow();
  });

  test("buildTree rejects an empty leaf set", () => {
    expect(() => buildTree([])).toThrow();
  });
});
