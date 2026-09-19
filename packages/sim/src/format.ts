/**
 * Render a GitHub-flavored markdown table.
 */
export function markdownTable(headers: string[], rows: ReadonlyArray<readonly string[]>): string {
  const width = headers.length;
  const escape = (cell: string): string => cell.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells: readonly string[]): string => `| ${cells.map(escape).join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => {
    const padded = Array.from({ length: width }, (_, i) => row[i] ?? "");
    return line(padded);
  });
  return [line(headers), separator, ...body].join("\n");
}

/**
 * Pretty-print a token amount with `decimals` fractional digits, trimming trailing zeros.
 */
export function formatUnits(amount: bigint, decimals: number, maxFrac?: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0");
  if (maxFrac !== undefined && maxFrac < decimals) {
    frac = frac.slice(0, maxFrac);
  }
  frac = frac.replace(/0+$/, "");
  const sign = neg ? "-" : "";
  return frac.length === 0 ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${frac}`;
}

/**
 * Format a float for tables: fixed digits, trim trailing zeros.
 */
export function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const s = value.toFixed(digits);
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/**
 * Format a ratio as a percentage string.
 */
export function formatPct(value: number, digits = 2): string {
  return `${formatNumber(value * 100, digits)}%`;
}
