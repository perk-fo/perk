/**
 * Testnet content driver.
 *
 *   bun run src/main.ts              run the scheduler until stopped
 *   bun run src/main.ts --plan-only  write the plan and print the schedule, send nothing
 *   bun run src/main.ts --status     print where every token has got to
 *
 * It launches tokens on a fixed cadence, trades each one to graduation over its trading window, and then walks the
 * campaign through the grant cadence. All progress is persisted after every action, so stopping the process and
 * starting it again — here or on the server — picks the schedule back up without repeating anything.
 */
import { getAddress, type Address } from "viem";
import { buildConfig, type DriverConfig } from "./config";
import { buildPlan, DEFAULTS, rng, type TokenSpec } from "./plan";
import { emptyState, loadState, saveState, type DriverState, type TokenState } from "./state";
import {
  campaign,
  curveTrade,
  finalizeGrant,
  fundQuoteAssets,
  fundWallets,
  graduate,
  launchToken,
  optInParticipants,
  poolSwap,
  launchStatus,
  memeBalance,
  proposeRoot,
  templateThreshold,
  activateRoot,
  quoteAddress,
} from "./actions";
import { datasetPathFor, exitFirstPosition, publishDataset, readDataset, registerAndActivate, snapshotJob } from "./grants";
import { uploadTokenMetadata } from "./media";

const TICK_MS = Number(process.env.DRIVER_TICK_MS ?? 15_000);
const WALLET_TARGET = BigInt(process.env.DRIVER_WALLET_TARGET_WEI ?? 40_000_000_000_000_000n); // 0.04 OKB
/** Creator dev buy, as a fraction of the launch threshold — the two quote assets have different decimals. */
const DEV_BUY_DIVISOR = BigInt(process.env.DRIVER_DEV_BUY_DIVISOR ?? 25n);
const POOL_SWAP_INTERVAL_S = Number(process.env.DRIVER_POOL_SWAP_INTERVAL_S ?? 600);
/** Post-graduation swap size. A buy is a fraction of that launch's own threshold, so a six-decimal quote is not
 *  asked for an 18-decimal amount; a sell is sized from the trader's own balance. */
const POOL_SWAP_DIVISOR = BigInt(process.env.DRIVER_POOL_SWAP_DIVISOR ?? 40n);

const now = () => Math.floor(Date.now() / 1000);

function log(msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));
}

function apiUrl(): string {
  return process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
}

/** Fresh plan, or the persisted one when it still matches the deployment we are pointed at. */
function initState(cfg: DriverConfig): DriverState {
  const existing = loadState(cfg.stateFile);
  if (existing) {
    if (existing.deploymentBlock === cfg.deployment.blockNumber && existing.chainId === cfg.chainId) return existing;
    log("deployment changed since the last run; starting a fresh plan", {
      was: existing.deploymentBlock,
      now: cfg.deployment.blockNumber,
    });
  }
  // DRIVER_QUOTES pins which quote assets new plans rotate through ("native", or a comma-separated list of keys
  // from the deployment's quoteAssets). Useful to steer launches away from a quote whose graduation is broken.
  const available = ["native", ...Object.keys(cfg.deployment.quoteAssets ?? {})];
  const wanted = (process.env.DRIVER_QUOTES ?? "").split(",").map((q) => q.trim()).filter(Boolean);
  const quoteAssets = wanted.length > 0 ? wanted.filter((q) => available.includes(q)) : available;
  if (quoteAssets.length === 0) throw new Error(`DRIVER_QUOTES matched none of: ${available.join(", ")}`);
  const plan = buildPlan({ ...DEFAULTS, startAt: now(), quoteAssets });
  const state = emptyState(cfg.chainId, cfg.deployment.blockNumber, plan);
  saveState(cfg.stateFile, state);
  return state;
}

/** Where a token should be at time `t` on its way to its goal (TokenSpec.goalBps), in basis points. */
function targetProgress(spec: TokenSpec, t: number): number {
  const goal = spec.goalBps ?? 10_000;
  const start = spec.tradeAt[0] ?? spec.launchAt;
  const end = spec.tradeAt[spec.tradeAt.length - 1] ?? start + DEFAULTS.tradeWindowSeconds;
  if (t <= start) return 0;
  if (t >= end) return goal;
  return Math.round((goal * (t - start)) / (end - start));
}

/** A launch that settled below its threshold trades on the curve about this often, around its goal. */
const HOLD_TRADE_INTERVAL_S = 25 * 60;

async function stepToken(
  cfg: DriverConfig,
  state: DriverState,
  spec: TokenSpec,
  ts: TokenState,
  rand: () => number,
): Promise<boolean> {
  const t = now();
  if (ts.error) return false;

  // --- launch ---------------------------------------------------------------
  if (ts.stage === "planned") {
    if (t < spec.launchAt) return false;
    const uri =
      (await uploadTokenMetadata(apiUrl(), {
        name: spec.name,
        symbol: spec.symbol,
        description: spec.description,
        seed: spec.index + 1,
      })) ?? `perk://demo/${spec.symbol}`;
    const devBuy = (await templateThreshold(cfg, spec.quote)) / DEV_BUY_DIVISOR;
    const { meme, tx } = await launchToken(cfg, spec, uri, devBuy);
    ts.meme = meme;
    ts.launchTx = tx;
    ts.stage = "trading";
    log("launched", { symbol: spec.symbol, meme, quote: spec.quote });
    return true;
  }

  const meme = ts.meme as Address | undefined;
  if (!meme) return false;

  // --- curve trading until the threshold is reached --------------------------
  if (ts.stage === "trading") {
    // The launch status comes first and is the authoritative signal. A token can reach its threshold before its
    // schedule of curve trades runs out; every trade after that reverts, because the curve has closed, and checking
    // the schedule first retried one of those trades for ever and never got to graduation. (`progressBps` is no
    // help either: it drops back to 0 the moment the curve graduates.)
    const status = await launchStatus(cfg, meme);
    const due = spec.tradeAt
      .map((at, i) => ({ at, i }))
      .filter(({ at, i }) => at <= t && !ts.tradesDone.includes(i));
    if (status < 2 && due.length > 0) {
      const { i } = due[0]!;
      const trader = cfg.traders[i % cfg.traders.length]!;
      await curveTrade(cfg, meme, spec.quote, trader, targetProgress(spec, t), rand, (m) => log(m));
      ts.tradesDone.push(i);
      return true;
    }
    if (status >= 2) {
      try {
        await graduate(cfg, meme, (m) => log(m));
      } catch (err) {
        // A launch whose graduation cannot complete is not going to fix itself, and retrying every tick just
        // buries the log. Park it with the reason so `--status` shows what happened.
        ts.error = String(err).slice(0, 200);
        log("graduation stalled; parking this launch", { symbol: spec.symbol, meme, error: ts.error });
        return true;
      }
      ts.stage = "graduated";
      ts.graduatedAt = now();
      log("graduated", { symbol: spec.symbol, meme });
      return true;
    }
    const windowOver = t > (spec.tradeAt[spec.tradeAt.length - 1] ?? 0);
    if (windowOver && (spec.goalBps ?? 10_000) < 10_000) {
      // this one was never meant to graduate: from here on it trades around its goal
      ts.stage = "holding";
      ts.lastHoldTradeAt = t;
      log("holding on the curve", { symbol: spec.symbol, meme, goalBps: spec.goalBps });
      return true;
    }
    if (windowOver) {
      // the window closed without crossing the threshold: push it over with one more buy
      const trader = cfg.traders[spec.index % cfg.traders.length]!;
      await curveTrade(cfg, meme, spec.quote, trader, 10_000, rand, (m) => log(m));
      return true;
    }
    return false;
  }

  // --- holding below the threshold: a two-sided market around the goal ------
  if (ts.stage === "holding") {
    const interval = HOLD_TRADE_INTERVAL_S * (0.6 + 0.8 * rand());
    if ((ts.lastHoldTradeAt ?? 0) + interval > t) return false;
    const goal = spec.goalBps ?? 10_000;
    // wander a few percent either side of the goal, never close enough to the threshold to graduate by accident
    const target = Math.min(9_500, Math.max(500, goal + Math.round((rand() - 0.5) * 800)));
    const trader = cfg.traders[Math.floor(rand() * cfg.traders.length)]!;
    try {
      await curveTrade(cfg, meme, spec.quote, trader, target, rand, (m) => log(m), true);
    } catch (err) {
      log("curve trade failed", { meme, error: String(err).slice(0, 200) });
    }
    ts.lastHoldTradeAt = now();
    return true;
  }

  // --- post-graduation: keep the pool chart alive ---------------------------
  {
    if ((ts.lastPoolSwapAt ?? 0) + POOL_SWAP_INTERVAL_S < t) {
      const trader = cfg.traders[(spec.index + ts.tradesDone.length) % cfg.traders.length]!;
      try {
        // A sell is a slice of what the trader actually holds. A fixed token count was dust at these prices and
        // showed up in the trades table as a sale for 0 quote; a wallet with nothing to sell buys instead.
        const held = await memeBalance(cfg, meme, trader.address);
        const buy = held === 0n || rand() < 0.6;
        const size = buy
          ? (await templateThreshold(cfg, spec.quote)) / POOL_SWAP_DIVISOR
          : (held * BigInt(2 + Math.floor(rand() * 5))) / 100n;
        await poolSwap(cfg, meme, trader, buy, size, (m) => log(m));
      } catch (err) {
        log("pool swap failed", { meme, error: String(err).slice(0, 200) });
      }
      ts.lastPoolSwapAt = now();
      return true;
    }
  }

  // --- grant cadence --------------------------------------------------------
  const c = await campaign(cfg, meme);
  const status = Number(c.status);
  if (status === 0) return false; // this launch has no campaign (standard template)

  // After a restart that lost the last saved step, follow the chain rather than the file.
  if (ts.stage === "graduated" && (status === 2 || status === 3)) {
    ts.stage = status === 2 ? "root_proposed" : "root_active";
    ts.datasetPath ??= datasetPathFor(cfg, meme);
    log("stage reconciled from chain", { meme, stage: ts.stage });
    return true;
  }
  if (ts.stage === "root_proposed" && status === 3) {
    ts.stage = "root_active";
    return true;
  }

  if (ts.stage === "graduated" && status === 1 /* AWAITING_ROOT */) {
    let path: string | null;
    try {
      path = snapshotJob(cfg, meme, (m) => log(m));
    } catch (err) {
      ts.error = String(err).slice(0, 200);
      log("grant parked: its snapshot keeps failing", { meme, error: ts.error });
      return true;
    }
    if (!path) return false;
    const dataset = readDataset(path);
    if (BigInt(dataset.totals.base) === 0n) {
      ts.error = "no eligible accounts in the snapshot";
      log("grant skipped: empty snapshot", { meme });
      return true;
    }
    ts.datasetUri ??= await publishDataset(path, meme, (m) => log(m));
    await proposeRoot(
      cfg,
      meme,
      dataset.root,
      ts.datasetUri,
      BigInt(dataset.totals.base),
      BigInt(dataset.totals.boost),
    );
    ts.datasetPath = path;
    ts.stage = "root_proposed";
    ts.rootProposedAt = now();
    log("root proposed", { meme, root: dataset.root });
    return true;
  }

  if (ts.stage === "root_proposed" && status === 2 /* ROOT_PROPOSED */) {
    const activatableAt = Number(c.rootProposedAt) + Number((await vaultConfig(cfg)).rootDelaySeconds);
    if (t < activatableAt) return false;
    await activateRoot(cfg, meme);
    ts.stage = "root_active";
    ts.rootActivatedAt = now();
    log("root activated", { meme });
    return true;
  }

  if ((ts.stage === "root_active" || ts.stage === "grant_open") && status === 3 /* ACTIVE */) {
    ts.grantEndsAt = Number(c.endTime);
    const activated = new Set(ts.participantsActivated ?? []);
    const datasetPath = ts.datasetPath ?? null;
    if (datasetPath) {
      for (const p of cfg.participants) {
        if (activated.has(p.address)) continue;
        try {
          const ok = await registerAndActivate(cfg, meme, datasetPath, p, (m) => log(m));
          activated.add(p.address);
          ts.participantsActivated = [...activated];
          if (ok) return true;
        } catch (err) {
          if (isPriceUnstable(err)) {
            // the vault refuses to open a position right after a sharp move; it clears by itself within minutes
            log("activate postponed: pool price still settling", { meme, who: p.address });
            return false;
          }
          log("activate failed", { meme, who: p.address, error: String(err).slice(0, 200) });
          activated.add(p.address);
          ts.participantsActivated = [...activated];
          return true;
        }
      }
    }
    ts.stage = "grant_open";
    // let one participant exit once the minimum LP time has passed, so exits appear in the UI too
    const exits = new Set(ts.exitsDone ?? []);
    const exiter = cfg.participants[0]!;
    if (!exits.has(exiter.address)) {
      try {
        if (await exitFirstPosition(cfg, meme, exiter, (m) => log(m))) {
          exits.add(exiter.address);
          ts.exitsDone = [...exits];
          return true;
        }
      } catch (err) {
        if (isPriceUnstable(err)) {
          log("exit postponed: pool price still settling", { meme });
          return false;
        }
        log("exit failed", { meme, error: String(err).slice(0, 200) });
        exits.add(exiter.address);
        ts.exitsDone = [...exits];
      }
    }
    if (t >= Number(c.endTime)) {
      await finalizeGrant(cfg, meme);
      ts.stage = "finalized";
      log("grant finalized", { meme });
      return true;
    }
    return false;
  }

  if (status === 4 /* EXPIRED */ || status === 5 /* CANCELLED */) {
    ts.stage = "finalized";
    return true;
  }
  return false;
}

let cachedVaultConfig: { rootDelaySeconds: bigint; rootDeadlineSeconds: bigint } | null = null;
async function vaultConfig(cfg: DriverConfig) {
  if (cachedVaultConfig) return cachedVaultConfig;
  const { lpGrantVaultAbi } = await import("../../backend/src/generated/abis");
  const c = await cfg.publicClient.readContract({
    address: cfg.deployment.lpGrantVault,
    abi: lpGrantVaultAbi,
    functionName: "config",
  });
  cachedVaultConfig = { rootDelaySeconds: BigInt(c.rootDelaySeconds), rootDeadlineSeconds: BigInt(c.rootDeadlineSeconds) };
  return cachedVaultConfig;
}

function printStatus(state: DriverState): void {
  const byStage: Record<string, number> = {};
  for (const ts of Object.values(state.tokens)) byStage[ts.stage] = (byStage[ts.stage] ?? 0) + 1;
  console.log(`plan: ${state.plan.length} tokens, deployment block ${state.deploymentBlock}`);
  console.log(`stages: ${JSON.stringify(byStage)}`);
  for (const spec of state.plan) {
    const ts = state.tokens[spec.index]!;
    const when = new Date(spec.launchAt * 1000).toISOString().slice(5, 16).replace("T", " ");
    console.log(
      `  #${String(spec.index).padStart(2)} ${spec.symbol.padEnd(7)} ${spec.quote.padEnd(6)} launch ${when}  ` +
        `${ts.stage.padEnd(13)} trades ${String(ts.tradesDone.length).padStart(2)}/${spec.tradeAt.length}` +
        `${ts.meme ? `  ${ts.meme}` : ""}${ts.error ? `  ERROR ${ts.error}` : ""}`,
    );
  }
}

const PRICE_UNSTABLE_SELECTOR = "c3119941"; // PriceUnstable(int24,int24)

/** LPGrantVault.PriceUnstable: transient, so the step is retried on a later tick instead of being given up. */
function isPriceUnstable(err: unknown): boolean {
  const text = String(err);
  return text.includes("PriceUnstable") || text.includes("0x" + PRICE_UNSTABLE_SELECTOR);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const cfg = buildConfig();
  const state = initState(cfg);

  if (args.has("--status")) {
    printStatus(state);
    return;
  }
  if (args.has("--plan-only")) {
    printStatus(state);
    log("plan written", { file: cfg.stateFile });
    return;
  }

  log("driver starting", {
    chainId: cfg.chainId,
    tokens: state.plan.length,
    creator: cfg.creator.address,
    traders: cfg.traders.length,
    participants: cfg.participants.length,
    state: cfg.stateFile,
  });

  if (!state.funded) {
    await fundWallets(cfg, WALLET_TARGET, (m) => log(m));
    await fundQuoteAssets(cfg, (m) => log(m));
    state.optedIn = await optInParticipants(cfg, (m) => log(m));
    state.funded = true;
    saveState(cfg.stateFile, state);
  }

  const rand = rng(DEFAULTS.seed ^ 0x9e37);
  for (;;) {
    try {
      // top the wallets up periodically; trading drains them slowly
      await fundWallets(cfg, WALLET_TARGET, () => {});
      await fundQuoteAssets(cfg, () => {});
      for (const spec of state.plan) {
        const ts = state.tokens[spec.index]!;
        try {
          const changed = await stepToken(cfg, state, spec, ts, rand);
          if (changed) saveState(cfg.stateFile, state);
        } catch (err) {
          log("token step failed", { symbol: spec.symbol, error: String(err).slice(0, 300) });
          saveState(cfg.stateFile, state);
        }
      }
    } catch (err) {
      log("tick failed", { error: String(err).slice(0, 300) });
    }
    await Bun.sleep(TICK_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
