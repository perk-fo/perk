/**
 * Walking a graduated campaign through the grant cadence: build the public snapshot dataset with the indexer
 * tooling, propose the root, activate it once the public review window has passed, have the demo participants
 * register and provide subsidised liquidity, and finalise when the window closes.
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { lpGrantVaultAbi } from "../../../backend/src/generated/abis";
import { call, type Account } from "./actions";
import type { DriverConfig } from "./config";
import { repoRoot } from "./config";

/**
 * Runs the snapshot CLI for one meme and returns the dataset it wrote. The CLI is a separate process on purpose:
 * it is the same command an outside party runs to recompute the root during the review window.
 */
export async function buildSnapshot(cfg: DriverConfig, meme: Address, log: (m: string) => void): Promise<string> {
  mkdirSync(cfg.datasetDir, { recursive: true });
  const out = join(cfg.datasetDir, `${meme.toLowerCase()}.json`);
  if (existsSync(out)) return out;
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "src/cli/snapshot.ts",
      "--meme",
      meme,
      "--chain",
      String(cfg.chainId),
      "--out",
      out,
      "--rpc-url",
      cfg.rpcUrl,
    ],
    { cwd: join(repoRoot, "packages", "indexer"), stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`snapshot failed for ${meme}: ${err.slice(0, 400)}`);
  }
  log(`snapshot written ${out}`);
  return out;
}

/** The parts of the public dataset the driver needs. Produced by the indexer's snapshot CLI. */
export interface SnapshotSummary {
  meme: Address;
  root: Hex;
  totals: { base: string; boost: string; accounts: number };
  allocations: { account: Address }[];
}

export function readDataset(path: string): SnapshotSummary {
  return JSON.parse(readFileSync(path, "utf8")) as SnapshotSummary;
}

interface ProofOutput {
  leaf: { account: Address; baseAllocation: string; inviteeBoost: string };
  proof: Hex[];
}

/**
 * The per-account leaf and Merkle proof, from the same `proof.ts` CLI a real user's wallet would be served by.
 * Going through the CLI keeps the driver off the indexer's internals.
 */
async function proofFor(cfg: DriverConfig, datasetPath: string, account: Address): Promise<ProofOutput | null> {
  const proc = Bun.spawn(
    ["bun", "run", "src/cli/proof.ts", "--dataset", datasetPath, "--account", account],
    { cwd: join(repoRoot, "packages", "indexer"), stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) return null;
  return JSON.parse(await new Response(proc.stdout).text()) as ProofOutput;
}

/** Register a participant's leaf (anyone may do this) and then activate their share into a grant position. */
export async function registerAndActivate(
  cfg: DriverConfig,
  meme: Address,
  datasetPath: string,
  participant: Account,
  log: (m: string) => void,
): Promise<boolean> {
  const mine = await proofFor(cfg, datasetPath, getAddress(participant.address));
  if (!mine) return false;

  const allocation = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "allocation",
    args: [meme, participant.address],
  });
  if (!allocation.registered) {
    await call(cfg, participant, {
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "registerAllocation",
      args: [
        meme,
        {
          account: mine.leaf.account,
          baseAllocation: BigInt(mine.leaf.baseAllocation),
          inviteeBoost: BigInt(mine.leaf.inviteeBoost),
        },
        mine.proof,
      ],
    });
    log(`registered ${participant.address} on ${meme}`);
  }

  const [baseClaimable, boostClaimable, creditClaimable] = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "grantBreakdown",
    args: [meme, participant.address],
  });
  if (baseClaimable + boostClaimable + creditClaimable === 0n) return false;

  // Activate only as much as the wallet can actually match with quote, leaving gas behind.
  const balance = await cfg.publicClient.getBalance({ address: participant.address });
  const spendable = balance > 30_000_000_000_000_000n ? balance - 30_000_000_000_000_000n : 0n;
  if (spendable === 0n) return false;

  let base = baseClaimable;
  let quoteNeeded = 0n;
  for (let i = 0; i < 24; i++) {
    const [q] = await cfg.publicClient.readContract({
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "quoteRequired",
      args: [meme, base + boostClaimable + creditClaimable],
    });
    quoteNeeded = q;
    if (quoteNeeded <= spendable || base < 2n) break;
    base /= 2n;
  }
  if (quoteNeeded === 0n || quoteNeeded > spendable) return false;

  const quoteMax = quoteNeeded + quoteNeeded / 50n + 1n;
  await call(cfg, participant, {
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "activateGrant",
    args: [meme, base, boostClaimable, creditClaimable, quoteMax, 0n],
    value: quoteMax,
  });
  log(`activated grant for ${participant.address} on ${meme} (quote ${quoteMax})`);
  return true;
}

/** Closes one grant position, so the UI shows exits as well as entries. */
export async function exitFirstPosition(
  cfg: DriverConfig,
  meme: Address,
  participant: Account,
  log: (m: string) => void,
): Promise<boolean> {
  const ids = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "positionsOf",
    args: [participant.address],
  });
  for (const id of ids) {
    const p = await cfg.publicClient.readContract({
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "position",
      args: [id],
    });
    if (p.exited || getAddress(p.meme) !== getAddress(meme)) continue;
    const c = await cfg.publicClient.readContract({
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "campaign",
      args: [meme],
    });
    const now = Math.floor(Date.now() / 1000);
    if (now < Number(p.activatedAt) + Number(c.minLpSeconds)) return false;
    await call(cfg, participant, {
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "exitGrantPosition",
      args: [id, 0n, 0n],
    });
    log(`exited grant position ${id} on ${meme}`);
    return true;
  }
  return false;
}
