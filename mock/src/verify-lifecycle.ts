/**
 * One-off check of the downstream half of the cadence, which the scheduled plan only reaches hours after a launch:
 * launch a token outside the plan, buy it straight to graduation, graduate it, build the snapshot dataset and
 * propose the root. Run it once after a deployment to prove the path before trusting it overnight.
 *
 *   bun run src/verify-lifecycle.ts
 */
import { buildConfig } from "./config";
import { curveTrade, graduate, launchToken, progressBps, proposeRoot, templateThreshold } from "./actions";
import { publishDataset, readDataset, snapshotJob } from "./grants";
import { rng } from "./plan";

const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...fields }));

async function main(): Promise<void> {
  const cfg = buildConfig();
  const rand = rng(Date.now() & 0xffff);
  const spec = {
    index: 999,
    name: "Cadence Check",
    symbol: "CHECK",
    description: "Throwaway launch used to verify graduation and the grant cadence after a deployment.",
    quote: "native",
    launchAt: 0,
    tradeAt: [],
    goalBps: 10_000,
    salt: `0x${(0xc4ec0 + (Date.now() % 100000)).toString(16).padStart(64, "0")}`,
  };

  const devBuy = (await templateThreshold(cfg, spec.quote)) / 25n;
  const { meme } = await launchToken(cfg, spec, `perk://verify/${spec.symbol}`, devBuy);
  log("launched", { meme });

  for (let i = 0; i < 12; i++) {
    const bps = await progressBps(cfg, meme);
    if (bps >= 10_000) break;
    const trader = cfg.traders[i % cfg.traders.length]!;
    await curveTrade(cfg, meme, spec.quote, trader, 10_000, rand, (m) => log(m));
  }
  const finalBps = await progressBps(cfg, meme);
  log("curve complete", { progressBps: finalBps });
  if (finalBps < 10_000) throw new Error(`curve did not reach the threshold (${finalBps} bps)`);

  await graduate(cfg, meme, (m) => log(m));
  log("graduated", { meme });

  let path: string | null = null;
  while (!path) {
    path = snapshotJob(cfg, meme, (m) => log(m));
    if (!path) await Bun.sleep(5_000);
  }
  const dataset = readDataset(path);
  log("snapshot", { root: dataset.root, accounts: dataset.totals.accounts, base: dataset.totals.base });
  if (BigInt(dataset.totals.base) === 0n) throw new Error("snapshot produced no eligible allocations");

  await proposeRoot(
    cfg,
    meme,
    dataset.root,
    await publishDataset(path, meme, (m) => log(m)),
    BigInt(dataset.totals.base),
    BigInt(dataset.totals.boost),
  );
  log("root proposed — activation becomes possible after the vault's review delay", { meme });
  log("PASS: launch, curve, graduation, snapshot and proposeRoot all worked");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
