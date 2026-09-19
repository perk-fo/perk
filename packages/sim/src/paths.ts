/**
 * Mulberry32 — small seeded PRNG, returns [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export type GbmParams = {
  p0: number;
  mu: number;
  sigma: number;
  days: number;
  n: number;
  seed: number;
};

/**
 * `n` GBM daily close paths of length `days` (does not include `p0`).
 * `mu` / `sigma` are annualised; `dt = 1/365`.
 */
export function gbm(params: GbmParams): number[][] {
  const { p0, mu, sigma, days, n, seed } = params;
  const rng = mulberry32(seed);
  const dt = 1 / 365;
  const drift = (mu - (sigma * sigma) / 2) * dt;
  const vol = sigma * Math.sqrt(dt);
  const paths: number[][] = [];
  for (let i = 0; i < n; i++) {
    const path: number[] = [];
    let p = p0;
    for (let d = 0; d < days; d++) {
      p = p * Math.exp(drift + vol * gaussian(rng));
      path.push(p);
    }
    paths.push(path);
  }
  return paths;
}

export type StressKind = "down90" | "down80" | "down50" | "flat" | "up100" | "up500" | "up100ThenBack";

const STRESS_END: Record<Exclude<StressKind, "up100ThenBack">, number> = {
  down90: 0.1,
  down80: 0.2,
  down50: 0.5,
  flat: 1,
  up100: 2,
  up500: 6,
};

function fill(days: number, value: number): number[] {
  return Array.from({ length: days }, () => value);
}

/**
 * Deterministic stress path of `days` daily closes, starting after t=0.
 * Jumps to the shocked price on day 1 and stays there, except `up100ThenBack`
 * which sits at 2*p0 for the first half then returns to p0.
 */
export function stressPath(kind: StressKind, p0: number, days: number): number[] {
  if (days <= 0) {
    return [];
  }
  if (kind === "up100ThenBack") {
    const mid = Math.floor(days / 2);
    return Array.from({ length: days }, (_, i) => (i < mid ? 2 * p0 : p0));
  }
  return fill(days, p0 * STRESS_END[kind]);
}

export const STRESS_KINDS: readonly StressKind[] = [
  "down90",
  "down80",
  "down50",
  "flat",
  "up100",
  "up500",
  "up100ThenBack",
];

export const STRESS_LABELS: Record<StressKind, string> = {
  down90: "-90%",
  down80: "-80%",
  down50: "-50%",
  flat: "flat",
  up100: "+100%",
  up500: "+500%",
  up100ThenBack: "+100% then back to p0",
};
