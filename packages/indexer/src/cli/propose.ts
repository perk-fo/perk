/**
 * Propose CLI: print the exact `cast send` command for
 * LPGrantVault.proposeRoot(meme, root, uri, totalBase, totalBoost). Never sends anything.
 *
 *   bun run src/cli/propose.ts --dataset dataset.json --uri ipfs://… [--chain 1952]
 *
 * The command must be executed by the vault owner; the printed totals come from the dataset
 * and satisfy the on-chain check totalBase <= basePool && totalInviteeBoost <= referralBudget.
 */
import { readFileSync } from "node:fs";
import { loadConfig, parseFlags, requireFlag } from "../config";
import { parseDataset } from "../dataset";

function main(): void {
  const { flags } = parseFlags(process.argv.slice(2));
  const path = requireFlag(flags, "dataset");
  const dataset = parseDataset(readFileSync(path, "utf8"));
  const uri = typeof flags.uri === "string" ? flags.uri : path;
  const chainId = typeof flags.chain === "string" ? Number(flags.chain) : dataset.chainId;

  const config = loadConfig(chainId, { rpcUrl: typeof flags["rpc-url"] === "string" ? flags["rpc-url"] : undefined });

  const cmd = [
    "cast send",
    config.addresses.lpGrantVault,
    '"proposeRoot(address,bytes32,string,uint256,uint256)"',
    dataset.meme,
    dataset.root,
    `"${uri}"`,
    dataset.totals.base,
    dataset.totals.boost,
    `--rpc-url ${config.rpcUrl}`,
    "--account <owner-keystore>   # must be the LPGrantVault owner",
  ].join(" \\\n  ");

  console.log("# publish the dataset at the URI first, then have the vault owner run:");
  console.log(cmd);
}

main();
