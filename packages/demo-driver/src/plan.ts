/**
 * The launch schedule and each token's trade times, generated once and then persisted. Everything is derived from a
 * seed so a restart — or a move to another machine — replays exactly the same plan.
 */

/** Deterministic PRNG (mulberry32); the driver must replay identically after a restart. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TokenSpec {
  index: number;
  name: string;
  symbol: string;
  description: string;
  /** "native" (OKB) or a key of deployment.quoteAssets */
  quote: string;
  /** unix seconds */
  launchAt: number;
  /** unix seconds, one per planned curve trade */
  tradeAt: number[];
  salt: string;
}

const NAMES: Array<[string, string, string]> = [
  ["Ledger Frog", "LFROG", "The frog that reconciles every block."],
  ["Gas Goblin", "GOBLIN", "Hoards gwei, spends it all on jpegs."],
  ["Mempool Moth", "MOTH", "Drawn to every pending transaction."],
  ["Rollup Raccoon", "RACOON", "Batches your snacks into one proof."],
  ["Slippage Sloth", "SLOTH", "Arrives late, fills anyway."],
  ["Nonce Newt", "NEWT", "Strictly sequential, never skips."],
  ["Oracle Otter", "OTTER", "Floats on medians."],
  ["Bridge Badger", "BADGER", "Digs tunnels between chains."],
  ["Faucet Ferret", "FERRET", "Always thirsty for testnet drip."],
  ["Calldata Crow", "CROW", "Collects shiny bytes."],
  ["Liquidity Lynx", "LYNX", "Prowls the full range."],
  ["Testnet Tapir", "TAPIR", "Happiest where nothing is real."],
  ["Gwei Gecko", "GECKO", "Sticks to the base fee."],
  ["Merkle Mole", "MOLE", "Burrows down to the leaf."],
  ["Hook Heron", "HERON", "Waits at the pool edge."],
  ["Epoch Egret", "EGRET", "Counts slots, ignores clocks."],
  ["Vault Vole", "VOLE", "Small, but it locks up well."],
  ["Curve Coyote", "COYOTE", "Runs the bonding curve nightly."],
  ["Shard Shrew", "SHREW", "Tiny appetite, constant activity."],
  ["Quorum Quail", "QUAIL", "Never moves without the others."],
  ["Basefee Bison", "BISON", "Stampedes when blocks fill."],
  ["Proof Puffin", "PUFFIN", "Carries witnesses in its beak."],
];

export interface PlanOptions {
  /** unix seconds the plan starts from */
  startAt: number;
  /** tokens launched right away */
  immediate: number;
  /** tokens released afterwards, one every `spacingSeconds` */
  queued: number;
  spacingSeconds: number;
  /** curve trades per hour, per token */
  tradesPerHour: number;
  /** how long a token trades on the curve before it should graduate */
  tradeWindowSeconds: number;
  seed: number;
  quoteAssets: string[];
}

export const DEFAULTS: Omit<PlanOptions, "startAt" | "quoteAssets"> = {
  immediate: 2,
  queued: 20,
  spacingSeconds: 3 * 3600,
  tradesPerHour: 10,
  tradeWindowSeconds: 2 * 3600,
  seed: 0x5045524b,
};

/**
 * Trade times across `windowSeconds`, random but not clustered: the window is cut into one slot per trade and a
 * time is drawn inside each slot. That keeps the average rate at `tradesPerHour` and still looks irregular.
 */
export function tradeTimes(startAt: number, windowSeconds: number, tradesPerHour: number, rand: () => number): number[] {
  const count = Math.max(1, Math.round((windowSeconds / 3600) * tradesPerHour));
  const slot = windowSeconds / count;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // keep a margin at both ends of the slot so two neighbouring trades cannot land in the same second
    out.push(Math.round(startAt + i * slot + (0.1 + 0.8 * rand()) * slot));
  }
  return out;
}

export function buildPlan(opts: PlanOptions): TokenSpec[] {
  const rand = rng(opts.seed);
  const total = opts.immediate + opts.queued;
  const specs: TokenSpec[] = [];
  for (let i = 0; i < total; i++) {
    const entry = NAMES[i % NAMES.length]!;
    const launchAt =
      i < opts.immediate ? opts.startAt : opts.startAt + (i - opts.immediate + 1) * opts.spacingSeconds;
    // alternate quote assets so the lists show more than one market
    const quote = opts.quoteAssets[i % opts.quoteAssets.length] ?? "native";
    specs.push({
      index: i,
      name: entry[0],
      symbol: entry[1],
      description: entry[2],
      quote,
      launchAt,
      tradeAt: tradeTimes(launchAt + 60, opts.tradeWindowSeconds, opts.tradesPerHour, rand),
      salt: `0x${(opts.seed + i).toString(16).padStart(64, "0")}`,
    });
  }
  return specs;
}
