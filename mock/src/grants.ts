/**
 * Walking a graduated campaign through the grant cadence: build the public snapshot dataset with the indexer
 * tooling, propose the root, activate it once the public review window has passed, have the demo participants
 * register and provide subsidised liquidity, and finalise when the window closes.
 */
import { mkdirSync, readFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { erc20Abi, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { lpGrantVaultAbi } from "../../backend/src/generated/abis";
import { call, type Account } from "./actions";
import type { DriverConfig } from "./config";
import { repoRoot } from "./config";

/** Where the dataset for `meme` is written once its snapshot has succeeded. */
export function datasetPathFor(cfg: DriverConfig, meme: Address): string {
  return join(cfg.datasetDir, `${meme.toLowerCase()}.json`);
}

interface SnapshotJob {
  running: boolean;
  failures: number;
  nextTryAt: number;
  lastError?: string;
}
const snapshotJobs = new Map<string, SnapshotJob>();
/** A snapshot that has failed this often is not going to fix itself: the campaign is parked with the reason. */
const SNAPSHOT_MAX_FAILURES = 6;

/**
 * The snapshot for one meme, run by the indexer CLI in the background so a long replay never stalls the other
 * launches: returns the dataset path once it exists, null while the job runs or waits out its backoff (one minute,
 * doubling up to an hour), and throws once it has failed SNAPSHOT_MAX_FAILURES times. The CLI is a separate process on
 * purpose: it is the same command anyone runs to recompute the root during the review window. It gets the RPC URL
 * through its environment, never on the command line, and writes to a temporary file that is renamed only on success,
 * so a failed run never leaves a dataset behind that later passes for a finished one.
 */
export function snapshotJob(cfg: DriverConfig, meme: Address, log: (m: string) => void): string | null {
  const out = datasetPathFor(cfg, meme);
  if (existsSync(out)) return out;
  const key = meme.toLowerCase();
  const job = snapshotJobs.get(key) ?? { running: false, failures: 0, nextTryAt: 0 };
  snapshotJobs.set(key, job);
  if (job.running || Date.now() < job.nextTryAt) return null;
  if (job.failures >= SNAPSHOT_MAX_FAILURES) {
    throw new Error(`snapshot failed ${job.failures} times: ${job.lastError ?? "unknown error"}`);
  }
  mkdirSync(cfg.datasetDir, { recursive: true });
  const tmp = `${out}.partial`;
  job.running = true;
  const proc = Bun.spawn(
    ["bun", "run", "src/cli/snapshot.ts", "--meme", meme, "--chain", String(cfg.chainId), "--out", tmp],
    {
      cwd: join(repoRoot, "packages", "indexer"),
      env: { ...process.env, RPC_URL: cfg.rpcUrl, LOG_PAGE: process.env.LOG_PAGE ?? "100" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  void (async () => {
    const code = await proc.exited;
    job.running = false;
    if (code === 0 && existsSync(tmp)) {
      JSON.parse(readFileSync(tmp, "utf8")); // a truncated file must not be taken for a dataset
      renameSync(tmp, out);
      log(`snapshot written ${out}`);
      return;
    }
    rmSync(tmp, { force: true });
    job.failures += 1;
    job.lastError = (await new Response(proc.stderr).text()).trim().split("\n").slice(-3).join(" ").slice(0, 300);
    job.nextTryAt = Date.now() + Math.min(3_600_000, 60_000 * 2 ** (job.failures - 1));
    log(`snapshot failed for ${meme} (attempt ${job.failures}): ${job.lastError}`);
  })().catch((err) => {
    job.running = false;
    job.failures += 1;
    job.lastError = String(err).slice(0, 300);
    job.nextTryAt = Date.now() + 60_000;
  });
  log(`snapshot started for ${meme}`);
  return null;
}

/**
 * Publishes a dataset on IPFS through Pinata, so the root's public dataset can be fetched by anyone (the API serves
 * proofs from it, and reviewers recompute it during the review window). Without PINATA_JWT, on a local chain for
 * instance, it falls back to a file:// URI that only this machine can read.
 */
export async function publishDataset(path: string, meme: Address, log: (m: string) => void): Promise<string> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    log("PINATA_JWT not set: proposing a file:// dataset URI that only this machine can read");
    return `file://${path}`;
  }
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)], { type: "application/json" }), `perk-grant-${meme.toLowerCase()}.json`);
  form.append("network", "public");
  form.append("name", `perk-grant-${meme.toLowerCase()}.json`);
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!res.ok) throw new Error(`dataset upload failed: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { cid?: string } };
  const cid = body.data?.cid;
  if (!cid) throw new Error("dataset upload returned no CID");
  log(`dataset pinned ipfs://${cid}`);
  return `ipfs://${cid}`;
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

  // Activate only as much as the wallet can actually match with quote (for native OKB, leaving gas behind).
  const quote = getAddress(
    (
      await cfg.publicClient.readContract({
        address: cfg.deployment.lpGrantVault,
        abi: lpGrantVaultAbi,
        functionName: "campaign",
        args: [meme],
      })
    ).quote,
  );
  const native = quote === zeroAddress;
  const balance = native
    ? await cfg.publicClient.getBalance({ address: participant.address })
    : await cfg.publicClient.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [participant.address] });
  const reserve = native ? 30_000_000_000_000_000n : 0n;
  const spendable = balance > reserve ? balance - reserve : 0n;
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
  if (!native) {
    await call(cfg, participant, {
      address: quote,
      abi: erc20Abi,
      functionName: "approve",
      args: [cfg.deployment.lpGrantVault, quoteMax],
    });
  }
  await call(cfg, participant, {
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "activateGrant",
    args: [meme, base, boostClaimable, creditClaimable, quoteMax, 0n],
    value: native ? quoteMax : 0n,
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
    // bound the exit at 97% of what it would pay right now, like a wallet would
    const { result } = await cfg.publicClient.simulateContract({
      account: participant.address,
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "exitGrantPosition",
      args: [id, 0n, 0n],
    });
    const [quoteOut, memeOut] = result;
    await call(cfg, participant, {
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "exitGrantPosition",
      args: [id, (quoteOut * 97n) / 100n, (memeOut * 97n) / 100n],
    });
    log(`exited grant position ${id} on ${meme}`);
    return true;
  }
  return false;
}
