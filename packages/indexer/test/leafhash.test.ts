import { describe, expect, test } from "bun:test";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { concatHex, encodeAbiParameters, getAddress, keccak256, toHex } from "viem";
import { leafHash } from "../src/merkle";

const ACCOUNT = getAddress("0xb4E911d58E50aC6B6020c391790EbdCc8dCD5668");

describe("leafHash", () => {
  test("equals keccak256(bytes.concat(keccak256(abi.encode(account, base, boost)))) computed with viem", () => {
    const base = 123456789000000000000n;
    const boost = 12345678900000000000n;

    const inner = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [ACCOUNT, base, boost]),
    );
    const expected = keccak256(concatHex([inner]));

    expect(leafHash(ACCOUNT, base, boost)).toBe(expected);
  });

  test("matches the leaf encoding of StandardMerkleTree.of([account, uint256, uint256])", () => {
    const base = 42n;
    const boost = 4n;
    // A single-leaf tree's root IS the leaf hash.
    const tree = StandardMerkleTree.of([[ACCOUNT, base, boost]], ["address", "uint256", "uint256"]);
    expect(leafHash(ACCOUNT, base, boost)).toBe(tree.root);
  });

  test("is sensitive to every leaf field", () => {
    const h = leafHash(ACCOUNT, 100n, 10n);
    expect(leafHash(getAddress("0x1111111111111111111111111111111111111111"), 100n, 10n)).not.toBe(h);
    expect(leafHash(ACCOUNT, 101n, 10n)).not.toBe(h);
    expect(leafHash(ACCOUNT, 100n, 11n)).not.toBe(h);
    // sanity: keccak output shape
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toHex(100n)).toStartWith("0x");
  });
});
