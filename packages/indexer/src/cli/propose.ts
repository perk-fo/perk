/**
 * Propose CLI: check a dataset, then print the exact `cast send` command for
 * LPGrantVault.proposeRoot(meme, root, uri, totalBase, totalBoost). Never sends anything.
 *
 *   RPC_URL=https://… bun run src/cli/propose.ts --dataset dataset.json --uri ipfs://… [--offline]
 *
 * The dataset must pass every check `verify` makes from the file (root, duplicates, exclusions, budgets, leaf
 * rules), and, unless --offline, the campaign on chain must be waiting for a root with the quote, cutoff and budgets
 * the dataset was built from. The totals in the printed command are recomputed from the leaves; the file's own
 * `totals` are never used. The endpoint appears in the command as "$RPC_URL", so the key is never printed.
 * The command must be run by the vault's grant publisher or its owner.
 */
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { loadDeployment, parseFlags, requireFlag, stringFlag } from "../config";
import { parseDataset } from "../dataset";
import { checkAgainstCampaign, checkDataset, requiredExclusions, statusName } from "../verify";
import { connect, fail, NO_RPC_MESSAGE } from "./common";

async function main(): Promise<void> {
  const { flags } = parseFlags(process.argv.slice(2));
  const path = requireFlag(flags, "dataset");
  const dataset = parseDataset(readFileSync(path, "utf8"));
  const uri = stringFlag(flags, "uri") ?? path;
  const chainId = Number(stringFlag(flags, "chain") ?? dataset.chainId);
  if (chainId !== Number(dataset.chainId)) throw new Error(`the dataset is for chain ${dataset.chainId}, not ${chainId}`);
  const deployment = loadDeployment(chainId);

  let report = checkDataset(dataset, { excluded: requiredExclusions(dataset, deployment.systemAddresses) });
  const problems: string[] = [];
  if (flags.offline === true) {
    console.error("note: --offline: the campaign on chain was not checked");
  } else {
    const conn = connect(chainId, flags);
    if (!conn) throw new Error(`${NO_RPC_MESSAGE} Or pass --offline to skip the on-chain checks.`);
    const servedChain = await conn.reader.getChainId();
    const head = await conn.reader.getBlockNumber();
    const campaign = await conn.reader.readCampaign(deployment.addresses.lpGrantVault, getAddress(dataset.meme), head);
    console.error(`campaign on chain ${servedChain} at block ${head}: ${statusName(campaign.status)}`);
    // the campaign's own hook is excluded too, should it differ from the deployment's
    report = checkDataset(dataset, { excluded: requiredExclusions(dataset, deployment.systemAddresses, campaign.hooks) });
    problems.push(...checkAgainstCampaign(dataset, report.sums, { chainId: servedChain, campaign }, { expectRoot: false }));
  }
  const sums = report.sums;
  problems.unshift(...report.problems);
  if (problems.length > 0) {
    console.error("refusing to propose this dataset:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const cmd = [
    "cast send",
    deployment.addresses.lpGrantVault,
    '"proposeRoot(address,bytes32,string,uint256,uint256)"',
    getAddress(dataset.meme),
    report.root!,
    `"${uri}"`,
    sums.base.toString(),
    sums.boost.toString(),
    '--rpc-url "$RPC_URL"',
    "--account <publisher-keystore>   # the vault's grant publisher, or its owner",
  ].join(" \\\n  ");

  console.log("# publish the dataset at the URI first, then, with RPC_URL set in the environment, run:");
  console.log(cmd);
}

main().catch((err) => fail(err));
