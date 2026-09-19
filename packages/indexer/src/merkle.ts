import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { getAddress, keccak256, concatHex, encodeAbiParameters, type Address, type Hex } from "viem";

/**
 * Leaf encoding identical to LPGrantVault.leafHash:
 *   keccak256(bytes.concat(keccak256(abi.encode(account, baseAllocation, inviteeBoost))))
 * which is exactly the leaf of StandardMerkleTree.of(values, ["address", "uint256", "uint256"]).
 */
export const LEAF_TYPES = ["address", "uint256", "uint256"] as const;

export type LeafTuple = [Address, bigint, bigint];

export function leafHash(account: Address, baseAllocation: bigint, inviteeBoost: bigint): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [getAddress(account), baseAllocation, inviteeBoost],
    ),
  );
  return keccak256(concatHex([inner]));
}

export interface GrantTree {
  tree: StandardMerkleTree<LeafTuple>;
  root: Hex;
  proofFor: (account: Address) => Hex[];
  dump: () => ReturnType<StandardMerkleTree<LeafTuple>["dump"]>;
  /** Standard-format dump as JSON text (bigints serialized as decimal strings). */
  dumpJson: () => string;
}

/** Build the StandardMerkleTree over (account, baseAllocation, inviteeBoost) leaves. */
export function buildTree(leaves: readonly LeafTuple[]): GrantTree {
  if (leaves.length === 0) throw new Error("cannot build a Merkle tree with zero leaves");
  const tree = StandardMerkleTree.of(
    leaves.map((l) => [getAddress(l[0]), l[1], l[2]] as LeafTuple),
    [...LEAF_TYPES],
  );
  return {
    tree,
    root: tree.root as Hex,
    proofFor(account: Address): Hex[] {
      const target = getAddress(account);
      for (const [i, v] of tree.entries()) {
        if (getAddress(v[0]) === target) return tree.getProof(i) as Hex[];
      }
      throw new Error(`account ${account} is not in the tree`);
    },
    dump: () => tree.dump(),
    dumpJson: () => JSON.stringify(tree.dump(), (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
  };
}

/**
 * OpenZeppelin MerkleProof.processProof reimplemented with viem primitives (sorted pairs).
 * Used by the tests and the verify CLI to check proofs independently of the tree library.
 */
export function processProof(proof: readonly Hex[], leaf: Hex): Hex {
  let computed = leaf;
  for (const p of proof) {
    computed =
      computed.toLowerCase() <= p.toLowerCase()
        ? keccak256(concatHex([computed, p]))
        : keccak256(concatHex([p, computed]));
  }
  return computed;
}

/** Verify a proof for a (account, base, boost) leaf against a root, OZ-compatible. */
export function verifyProof(
  root: Hex,
  account: Address,
  baseAllocation: bigint,
  inviteeBoost: bigint,
  proof: readonly Hex[],
): boolean {
  return processProof(proof, leafHash(account, baseAllocation, inviteeBoost)).toLowerCase() === root.toLowerCase();
}
