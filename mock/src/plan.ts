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
  /**
   * Where this launch is headed, in basis points of its graduation threshold: 10_000 graduates at the end of its
   * trading window; anything lower settles there and keeps trading on the curve, so the lists show launches at
   * every stage rather than only graduated ones.
   */
  goalBps: number;
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
  ["Staking Panda", "PANDA", "Eats bamboo, compounds hourly."],
  ["Validator Fox", "FOX", "Signs every block, sly about it."],
  ["Airdrop Bunny", "BUNNY", "Hops from claim to claim."],
  ["Block Bear", "BEAR", "Hibernates through every dip."],
  ["Degen Duck", "DUCK", "Quacks at every green candle."],
  ["Harbor Seal", "SEAL", "Stamps every transaction twice."],
  ["Genesis Koala", "KOALA", "Slept through block zero."],
  ["Hodl Hamster", "HAMSTER", "Stuffs its cheeks, never sells."],
  ["Mint Kitten", "KITTEN", "Knocks tokens off the table."],
  ["Pixel Pig", "PIG", "Oinks in eight bits."],
  ["Relay Pup", "PUP", "Fetches messages across chains."],
  ["Snapshot Owl", "OWL", "Remembers every balance at midnight."],
  ["Iceberg Penguin", "BERG", "Slides into every pool."],
  ["Hash Hedgehog", "HEDGE", "Spiky about collisions."],
  ["Treasury Tiger", "TIGER", "Purrs at every timelock."],
  ["Launch Lion", "LION", "Roars at every new pool."],
  ["Merge Monkey", "MONKEY", "Swings between branches."],
  ["Timelock Turtle", "TURTLE", "Slow, steady, always on time."],
  ["Sequencer Squirrel", "SQRL", "Orders every nut in sequence."],
  ["Deploy Deer", "DEER", "Bounds from testnet to mainnet."],
];

export interface PlanOptions {
  /** unix seconds the plan starts from */
  startAt: number;
  /**
   * The opening batch: launched a few minutes apart and traded briskly, so most of it graduates within the first hour
   * and the market has real history to show from the start.
   */
  bootstrap: number;
  bootstrapSpacingSeconds: number;
  bootstrapWindowSeconds: number;
  bootstrapTradesPerHour: number;
  /** after the opening batch: tokens released one every `spacingSeconds` */
  queued: number;
  spacingSeconds: number;
  /** curve trades per hour, per token */
  tradesPerHour: number;
  /** how long a token trades on the curve before it reaches its goal */
  tradeWindowSeconds: number;
  seed: number;
  quoteAssets: string[];
}

export const DEFAULTS: Omit<PlanOptions, "startAt" | "quoteAssets"> = {
  bootstrap: 12,
  bootstrapSpacingSeconds: 4 * 60,
  bootstrapWindowSeconds: 45 * 60,
  bootstrapTradesPerHour: 18,
  queued: 30,
  spacingSeconds: 2 * 3600,
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

/** Share of launches after the opening batch that graduate; the rest settle between 20% and 92% of their threshold. */
const GRADUATING_SHARE = 0.55;

export function buildPlan(opts: PlanOptions): TokenSpec[] {
  const rand = rng(opts.seed);
  // a separate stream, so the goals do not shift the trade times
  const fate = rng(opts.seed ^ 0x9e3779b9);
  const total = opts.bootstrap + opts.queued;
  const specs: TokenSpec[] = [];
  for (let i = 0; i < total; i++) {
    const entry = NAMES[i % NAMES.length]!;
    const opening = i < opts.bootstrap;
    const launchAt = opening
      ? opts.startAt + i * opts.bootstrapSpacingSeconds
      : opts.startAt + opts.bootstrap * opts.bootstrapSpacingSeconds + (i - opts.bootstrap + 1) * opts.spacingSeconds;
    const tradeAt = opening
      ? tradeTimes(launchAt + 60, opts.bootstrapWindowSeconds, opts.bootstrapTradesPerHour, rand)
      : tradeTimes(launchAt + 60, opts.tradeWindowSeconds, opts.tradesPerHour, rand);
    // in the opening batch two in three graduate, the rest settle at different stages; afterwards it is a draw
    const graduates = opening ? i % 3 !== 2 : fate() < GRADUATING_SHARE;
    const settle = 2_000 + Math.round(fate() * 7_200);
    // alternate quote assets so the lists show more than one market
    const quote = opts.quoteAssets[i % opts.quoteAssets.length] ?? "native";
    specs.push({
      index: i,
      name: entry[0],
      symbol: entry[1],
      description: `${entry[2]} Simulated testnet token.`,
      quote,
      launchAt,
      tradeAt,
      goalBps: graduates ? 10_000 : settle,
      salt: `0x${(opts.seed + i).toString(16).padStart(64, "0")}`,
    });
  }
  return specs;
}
