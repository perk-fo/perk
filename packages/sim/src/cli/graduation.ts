import { formatUnits, markdownTable } from "../format.ts";
import {
  compareTemplates,
  defaultNumbers,
  sweepPoolReserve,
  sweepThreshold,
  type TemplateBreakdown,
  type TemplateNumbers,
} from "../graduation.ts";

const TOKEN_DECIMALS = 18;

function tok(amount: bigint, maxFrac = 4): string {
  return formatUnits(amount, TOKEN_DECIMALS, maxFrac);
}

function limiting(seed: TemplateBreakdown["seed"]): string {
  if (seed.memeLeftover === 0n && seed.quoteLeftover === 0n) {
    return "exact";
  }
  return seed.memeLeftover === 0n ? "meme (quote leftover)" : "quote (meme leftover → burn)";
}

function breakdownRows(perk: TemplateBreakdown, standard: TemplateBreakdown): string[][] {
  const row = (label: string, pick: (t: TemplateBreakdown) => string): string[] => [
    label,
    pick(perk),
    pick(standard),
  ];
  return [
    row("grant reserve bps", (t) => t.grantBps.toString()),
    row("grant reserve", (t) => tok(t.grantReserveSupply)),
    row("curve supply", (t) => tok(t.curveSupply)),
    row("pool reserve", (t) => tok(t.poolReserveSupply)),
    row("meme sold (closed form)", (t) => tok(t.memeSoldClosedForm)),
    row("meme sold (capped at curveSupply)", (t) => tok(t.memeSold)),
    row("unsold curve meme", (t) => tok(t.unsoldCurve)),
    row("sold > curveSupply?", (t) => (t.soldExceedsCurve ? "yes" : "no")),
    row("final price (quote / meme)", (t) => formatUnits(t.finalPriceX18, 18, 12)),
    row("meme received by GraduationManager", (t) => tok(t.memeReceived)),
    row("quote from curve (threshold)", (t) => tok(t.quoteFromCurve)),
    row("quote from curve LP fee share", (t) => tok(t.quoteFromLpFees, 6)),
    row("quote received", (t) => tok(t.quoteReceived, 6)),
    row("meme to pool", (t) => tok(t.seed.memeToPool)),
    row("quote to pool", (t) => tok(t.seed.quoteToPool, 6)),
    row("meme leftover (burn)", (t) => tok(t.seed.memeLeftover)),
    row("quote leftover", (t) => tok(t.seed.quoteLeftover, 6)),
    row("limiting side", (t) => limiting(t.seed)),
  ];
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export type GraduationReport = {
  numbers: TemplateNumbers;
  comparison: ReturnType<typeof compareTemplates>;
  thresholdSweep: ReturnType<typeof sweepThreshold>;
  poolSplitSweep: ReturnType<typeof sweepPoolReserve>;
};

const DEFAULT_THRESHOLDS: bigint[] = [50n, 70n, 85n, 100n, 120n, 150n].map((x) => x * 10n ** 18n);
const DEFAULT_POOL_BPS: bigint[] = [1000n, 1500n, 2000n, 2500n, 3500n];

/**
 * Build the default graduation report (template compare + two sweeps).
 */
export function buildReport(numbers: TemplateNumbers = defaultNumbers): GraduationReport {
  return {
    numbers,
    comparison: compareTemplates(numbers),
    thresholdSweep: sweepThreshold(numbers, DEFAULT_THRESHOLDS),
    poolSplitSweep: sweepPoolReserve(numbers, DEFAULT_POOL_BPS),
  };
}

function renderMarkdown(report: GraduationReport): string {
  const { comparison, thresholdSweep, poolSplitSweep } = report;
  const lines: string[] = [];

  lines.push("# Graduation seeding: Perk vs Standard");
  lines.push("");
  lines.push(
    "Placeholder numbers from T04 `PerkTemplates.defaultNumbers` (pending PRD open items). " +
      "Quote received includes the curve-stage LP fee share (15% of the 1% buy fee on a single fill to the threshold).",
  );
  lines.push("");
  if (comparison.perk.soldExceedsCurve) {
    lines.push(
      "> Note: closed-form `memeSoldAtGraduation` exceeds `curveSupply` for these placeholders. " +
        "Physical unsold is floored at 0; the registry would reject this config on-chain.",
    );
    lines.push("");
  }
  lines.push("## Template comparison");
  lines.push("");
  lines.push(markdownTable(["", "Perk Launch", "Standard Launch"], breakdownRows(comparison.perk, comparison.standard)));
  lines.push("");
  const grantGap = comparison.perk.grantReserveSupply;
  const leftoverNote =
    comparison.memeLeftoverDelta === grantGap
      ? "equals the 15% grant-reserve gap (both quote-limited)"
      : "does not equal the 15% grant-reserve gap (at least one template is meme-limited, or sold exceeds curveSupply)";
  lines.push(
    `Standard meme leftover exceeds Perk by ${tok(comparison.memeLeftoverDelta)} tokens (${leftoverNote}).`,
  );
  lines.push("");
  lines.push("## Threshold sweep");
  lines.push("");
  lines.push(
    markdownTable(
      ["threshold (quote)", "final price", "Perk meme leftover", "Standard meme leftover", "Perk quote leftover", "Standard quote leftover"],
      thresholdSweep.map((row) => [
        tok(row.threshold),
        formatUnits(row.perk.finalPriceX18, 18, 8),
        tok(row.perk.seed.memeLeftover),
        tok(row.standard.seed.memeLeftover),
        tok(row.perk.seed.quoteLeftover, 6),
        tok(row.standard.seed.quoteLeftover, 6),
      ]),
    ),
  );
  lines.push("");
  lines.push("## Pool-reserve split sweep");
  lines.push("");
  lines.push(
    "Perk pool-reserve bps of total supply; curve supply is the remainder after 15% grant. Standard adds the 15% onto pool reserve.",
  );
  lines.push("");
  lines.push(
    markdownTable(
      ["Perk pool reserve", "curve supply", "Perk meme leftover", "Standard meme leftover", "Perk limiting", "Standard limiting"],
      poolSplitSweep.map((row) => [
        tok(row.poolReserveSupply),
        tok(row.curveSupply),
        tok(row.perk.seed.memeLeftover),
        tok(row.standard.seed.memeLeftover),
        limiting(row.perk.seed),
        limiting(row.standard.seed),
      ]),
    ),
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * CLI entry. `--json` prints the report as JSON (bigints as strings).
 */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const report = buildReport();
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, bigintReplacer, 2)}\n`);
    return;
  }
  process.stdout.write(renderMarkdown(report));
}

const isMain = Boolean((import.meta as { main?: boolean }).main);
if (isMain) {
  main();
}
