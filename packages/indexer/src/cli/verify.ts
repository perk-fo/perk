/**
 * Verify CLI: the "independent recomputation" a third party runs during the root delay window.
 *
 *   bun run src/cli/verify.ts <dataset.json>
 *
 * Rebuilds the StandardMerkleTree purely from the dataset's allocations and prints
 * MATCH / MISMATCH against the recorded root. Exits non-zero on mismatch.
 */
import { readFileSync } from "node:fs";
import { parseDataset, recomputeRoot } from "../dataset";

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun run src/cli/verify.ts <dataset.json>");
    process.exit(2);
  }
  const dataset = parseDataset(readFileSync(path, "utf8"));
  const { root, matches } = recomputeRoot(dataset);
  console.log(`dataset root:    ${dataset.root}`);
  console.log(`recomputed root: ${root}`);
  console.log(`accounts:        ${dataset.allocations.length}`);
  console.log(matches ? "MATCH" : "MISMATCH");
  if (!matches) process.exit(1);
}

main();
