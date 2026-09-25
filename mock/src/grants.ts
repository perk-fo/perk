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

/**
 * `inventoryRemaining` is new in v0.14 and not yet in the generated ABI (contracts are mid-change; see
 * mock/README.md). A minimal local fragment, same pattern as `MOCK_ERC20_ABI` in actions.ts, so this compiles and
 * works today and needs no edit once the generated ABI catches up.
 */
const LP_GRANT_VAULT_EXTRA_ABI = [
  {
    type: "function",
    name: "inventoryRemaining",
    stateMutability: "view",
    inputs: [{ name: "meme", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const INSUFFICIENT_INVENTORY_SELECTOR = "8ada068e"; // InsufficientInventory(uint256)

/** LPGrantVault.InsufficientInventory: the shared reserve ran dry for this bundle; never worth retrying as-is. */
function isInsufficientInventory(err: unknown): boolean {
  const text = String(err);
  return text.includes("InsufficientInventory") || text.includes("0x" + INSUFFICIENT_INVENTORY_SELECTOR);
}

/**
 * Activates one bundle of (base, boost, credit) grant meme into a locked position: shrinks it first to fit what is
 * left of the campaign's one shared inventory (base, invitee boost and inviter credit all draw from the same 15%
 * reserve in v0.14 — see mock/README.md), then to what the wallet can actually match in quote (for native OKB,
 * leaving gas behind). Returns false, without throwing, when there is nothing left to activate rather than treating
 * an exhausted inventory as a hard failure.
 */
async function activateShare(
  cfg: DriverConfig,
  meme: Address,
  participant: Account,
  quote: Address,
  native: boolean,
  baseIn: bigint,
  boostIn: bigint,
  creditIn: bigint,
  log: (m: string) => void,
): Promise<boolean> {
  const remaining = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: LP_GRANT_VAULT_EXTRA_ABI,
    functionName: "inventoryRemaining",
    args: [meme],
  });
  let base = baseIn;
  let boost = boostIn;
  let credit = creditIn;
  let over = base + boost + credit - remaining;
  if (over > 0n) {
    const cutBase = over < base ? over : base;
    base -= cutBase;
    over -= cutBase;
    const cutBoost = over < boost ? over : boost;
    boost -= cutBoost;
    over -= cutBoost;
    const cutCredit = over < credit ? over : credit;
    credit -= cutCredit;
    over -= cutCredit;
  }
  if (base + boost + credit === 0n) {
    log(`activation skipped for ${participant.address} on ${meme}: shared inventory is exhausted`);
    return false;
  }

  const balance = native
    ? await cfg.publicClient.getBalance({ address: participant.address })
    : await cfg.publicClient.readContract({ address: quote, abi: erc20Abi, functionName: "balanceOf", args: [participant.address] });
  const reserve = native ? 30_000_000_000_000_000n : 0n;
  const spendable = balance > reserve ? balance - reserve : 0n;
  if (spendable === 0n) return false;

  let quoteNeeded = 0n;
  for (let i = 0; i < 24; i++) {
    const [q] = await cfg.publicClient.readContract({
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "quoteRequired",
      args: [meme, base + boost + credit],
    });
    quoteNeeded = q;
    if (quoteNeeded <= spendable || base + boost + credit < 2n) break;
    // shrink whichever claim is largest, so a small credit or boost is not zeroed out to protect a much bigger base
    if (base >= boost && base >= credit && base > 1n) base /= 2n;
    else if (boost >= credit && boost > 1n) boost /= 2n;
    else if (credit > 1n) credit /= 2n;
    else break;
  }
  if (quoteNeeded === 0n || quoteNeeded > spendable || base + boost + credit === 0n) return false;

  const quoteMax = quoteNeeded + quoteNeeded / 50n + 1n;
  if (!native) {
    await call(cfg, participant, {
      address: quote,
      abi: erc20Abi,
      functionName: "approve",
      args: [cfg.deployment.lpGrantVault, quoteMax],
    });
  }
  try {
    await call(cfg, participant, {
      address: cfg.deployment.lpGrantVault,
      abi: lpGrantVaultAbi,
      functionName: "activateGrant",
      args: [meme, base, boost, credit, quoteMax, 0n],
      value: native ? quoteMax : 0n,
    });
  } catch (err) {
    // A last-moment race against the shared inventory (only plausible if something else drew it down between the
    // check above and this transaction landing). Skip this bundle rather than parking the whole participant.
    if (isInsufficientInventory(err)) {
      log(`activation raced the shared inventory for ${participant.address} on ${meme}; not retrying this bundle`);
      return false;
    }
    throw err;
  }
  log(
    `activated grant for ${participant.address} on ${meme} (base ${base}, boost ${boost}, credit ${credit}, quote ${quoteMax})`,
  );
  return true;
}

/**
 * Register a participant's leaf (anyone may do this) and then activate their share into locked grant positions.
 *
 * v0.14: the invitee boost is only earned as base is actually activated on-chain (10% of cumulative base activated,
 * capped by the leaf's inviteeBoost), so it can never be claimed in the same transaction as the base that earns it.
 * This activates base (and any inviter credit already earned, which does not depend on this account's own base) in
 * one transaction, then re-reads `grantBreakdown` and activates whatever boost that just unlocked in a second one.
 */
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

  let acted = false;

  const [baseClaimable, , creditClaimable] = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "grantBreakdown",
    args: [meme, participant.address],
  });
  if (baseClaimable + creditClaimable > 0n) {
    acted = (await activateShare(cfg, meme, participant, quote, native, baseClaimable, 0n, creditClaimable, log)) || acted;
  }

  // Re-read: base activated just above (if any) may have just earned invitee boost.
  const [, boostClaimable] = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "grantBreakdown",
    args: [meme, participant.address],
  });
  if (boostClaimable > 0n) {
    acted = (await activateShare(cfg, meme, participant, quote, native, 0n, boostClaimable, 0n, log)) || acted;
  }

  return acted;
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
