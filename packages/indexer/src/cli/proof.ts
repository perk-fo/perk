/**
 * Proof CLI: print the GrantLeaf tuple and Merkle proof for one account, ready for
 * LPGrantVault.registerAllocation(meme, leaf, proof).
 *
 *   bun run src/cli/proof.ts --dataset dataset.json --account 0x…
 */
import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import { requireFlag, parseFlags } from "../config";
import { leavesFromDataset, parseDataset } from "../dataset";
import { buildTree } from "../merkle";

function main(): void {
  const { flags } = parseFlags(process.argv.slice(2));
  const path = requireFlag(flags, "dataset");
  const account = getAddress(requireFlag(flags, "account")) as Address;

  const dataset = parseDataset(readFileSync(path, "utf8"));
  const tree = buildTree(leavesFromDataset(dataset));
  const proof = tree.proofFor(account);
  const leaf = leavesFromDataset(dataset).find((l) => getAddress(l[0]) === account);
  if (!leaf) throw new Error(`${account} has no allocation in ${path}`);

  console.log(
    JSON.stringify(
      {
        meme: dataset.meme,
        leaf: {
          account: leaf[0],
          baseAllocation: leaf[1].toString(),
          inviteeBoost: leaf[2].toString(),
        },
        proof,
      },
      null,
      2,
    ),
  );
}

main();
