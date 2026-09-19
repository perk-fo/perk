import { formatNumber, formatPct, markdownTable } from "../format.ts";
import { simulateGrant, type GrantResult } from "../grant.ts";
import { runGrant, type GrantMcConfig, type GrantSummary } from "../montecarlo.ts";
import { STRESS_KINDS, STRESS_LABELS, stressPath } from "../paths.ts";

export const defaultGrantConfig: GrantMcConfig = {
  quoteDeposited: 1000,
  grantMeme: 1000,
  p0: 1,
  days: 14,
  n: 2000,
  seed: 1,
  mu: 0,
  sigma: 1.5,
  dailyVolumeToLiquidity: 0.2,
  lpFeeBps: 15,
  buyShare: 0.5,
};

const SIGMAS = [0.5, 1.0, 1.5, 2.0, 3.0];
const VOL_RATIOS = [0.05, 0.1, 0.2, 0.5, 1.0];

function resultRow(label: string, r: GrantResult): string[] {
  return [
    label,
    formatNumber(r.quoteToUser, 4),
    formatNumber(r.pnl, 4),
    formatNumber(r.excessToTreasury, 4),
    formatNumber(r.memeBurned, 4),
    formatNumber(r.quoteFees, 4),
  ];
}

function summaryRows(s: GrantSummary): string[][] {
  return [
    ["mean pnl", formatNumber(s.mean, 4)],
    ["median pnl", formatNumber(s.median, 4)],
    ["p5 pnl", formatNumber(s.p5, 4)],
    ["p25 pnl", formatNumber(s.p25, 4)],
    ["p75 pnl", formatNumber(s.p75, 4)],
    ["p95 pnl", formatNumber(s.p95, 4)],
    ["P(pnl < 0)", formatPct(s.probLoss, 2)],
    ["mean excess to treasury", formatNumber(s.meanExcessToTreasury, 4)],
    ["mean quote fees", formatNumber(s.meanFees, 4)],
    ["breakeven volume/liquidity (median pnl ≥ 0)", formatNumber(s.breakevenVolumeRatio, 4)],
  ];
}

export type GrantReport = {
  config: GrantMcConfig;
  stress: { kind: string; label: string; result: GrantResult }[];
  monteCarlo: GrantSummary;
  sensitivity: { sigma: number; dailyVolumeToLiquidity: number; medianPnl: number; probLoss: number }[];
};

/**
 * Stress table + Monte Carlo + sigma × volume-ratio grid for the default Grant config.
 */
export function buildReport(config: GrantMcConfig = defaultGrantConfig): GrantReport {
  const stress = STRESS_KINDS.map((kind) => ({
    kind,
    label: STRESS_LABELS[kind],
    result: simulateGrant({
      quoteDeposited: config.quoteDeposited,
      grantMeme: config.grantMeme,
      p0: config.p0,
      pricePath: stressPath(kind, config.p0, config.days),
      dailyVolumeToLiquidity: config.dailyVolumeToLiquidity,
      lpFeeBps: config.lpFeeBps,
      buyShare: config.buyShare,
    }),
  }));

  const monteCarlo = runGrant(config);

  const sensitivity: GrantReport["sensitivity"] = [];
  for (const sigma of SIGMAS) {
    for (const dailyVolumeToLiquidity of VOL_RATIOS) {
      const summary = runGrant({ ...config, sigma, dailyVolumeToLiquidity, n: Math.min(config.n, 500) });
      sensitivity.push({
        sigma,
        dailyVolumeToLiquidity,
        medianPnl: summary.median,
        probLoss: summary.probLoss,
      });
    }
  }

  return { config, stress, monteCarlo, sensitivity };
}

function renderMarkdown(report: GrantReport): string {
  const { config, stress, monteCarlo, sensitivity } = report;
  const lines: string[] = [];

  lines.push("# LP Grant payoff");
  lines.push("");
  lines.push(
    `Default config: Q = ${config.quoteDeposited}, M priced at ${config.grantMeme * config.p0} quote at p0 = ${config.p0}, ` +
      `${config.days}-day window, μ = ${config.mu}, σ = ${formatPct(config.sigma, 0)} annualised, ` +
      `volume/liquidity = ${config.dailyVolumeToLiquidity}/day, LP fee = ${config.lpFeeBps} bps, buy share = ${config.buyShare}. ` +
      `Monte Carlo n = ${config.n}, seed = ${config.seed}.`,
  );
  lines.push("");
  lines.push("## Stress paths");
  lines.push("");
  lines.push(
    markdownTable(
      ["path", "quote to user", "pnl", "excess to treasury", "meme burned", "quote fees"],
      stress.map((s) => resultRow(s.label, s.result)),
    ),
  );
  lines.push("");
  lines.push("## Monte Carlo summary");
  lines.push("");
  lines.push(markdownTable(["metric", "value"], summaryRows(monteCarlo)));
  lines.push("");
  lines.push("## Sensitivity: median pnl (σ × volume/liquidity)");
  lines.push("");
  const header = ["σ \\ vol/L", ...VOL_RATIOS.map((v) => formatNumber(v, 2))];
  const gridRows = SIGMAS.map((sigma) => {
    const cells = VOL_RATIOS.map((vol) => {
      const cell = sensitivity.find((x) => x.sigma === sigma && x.dailyVolumeToLiquidity === vol);
      return cell === undefined ? "" : formatNumber(cell.medianPnl, 3);
    });
    return [formatPct(sigma, 0), ...cells];
  });
  lines.push(markdownTable(header, gridRows));
  lines.push("");
  return lines.join("\n");
}

/**
 * CLI entry. `--json` prints the report as JSON.
 */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const report = buildReport();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderMarkdown(report));
}

const isMain = Boolean((import.meta as { main?: boolean }).main);
if (isMain) {
  main();
}
