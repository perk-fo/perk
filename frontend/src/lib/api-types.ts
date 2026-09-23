// MIRROR of backend/src/api/types.ts — keep both files identical (bun run api:types checks).
/**
 * Wire types of the read API. Mirrored verbatim in frontend/src/lib/api-types.ts — change both together.
 * All uint256 values are decimal strings; timestamps are unix seconds; addresses/hashes are lowercase hex.
 */

export type Uint = string;
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface Health {
  ok: boolean;
  chainId: number;
  cursorBlock: number;
  headBlock: number | null;
  /** headBlock - cursorBlock. Never below `confirmations` while the indexer is healthy: that part is deliberate. */
  lagBlocks: number | null;
  /** Blocks the indexer intentionally stays behind the head (reorg safety). */
  confirmations: number;
  /** now - timestamp(cursorBlock), seconds. */
  lagSeconds: number | null;
  startBlock: number;
  updatedAt: string;
  lastError: string | null;
  lastErrorAt: string | null;
  serverTime: number;
  /**
   * "catchup" while lagBlocks > config.catchupBlocks (the indexer backfills window after window without sleeping);
   * "live" otherwise (one poll per config.pollMs, only new blocks are fetched).
   */
  mode: "catchup" | "live";
}

export interface QuoteAsset {
  address: Address;
  symbol: string;
  name: string | null;
  decimals: number;
  isNative: boolean;
  kind: number | null;
}

export interface MarketStats {
  /** Last trade price in raw units: priceQuote / priceMeme. Null before the first trade. */
  lastPriceQuote: Uint | null;
  lastPriceMeme: Uint | null;
  /** Decimal-adjusted quote per meme (float, for display only). */
  lastPrice: number | null;
  /** bps change between the first and last trade inside the trailing 24h. */
  change24hBps: number;
  volume24hQuote: Uint;
  volumeTotalQuote: Uint;
  /** lastPrice × totalSupply in raw quote units. */
  marketCapQuote: Uint | null;
  tradeCount: number;
  holderCount: number;
  lastTradeAt: number | null;
}

export interface CurveState {
  virtualQuoteReserve: Uint;
  virtualMemeReserve: Uint;
  curveSupply: Uint;
  poolReserveSupply: Uint;
  graduationQuoteThreshold: Uint;
  totalFeeBps: number;
  realQuote: Uint;
  memeSold: Uint;
  /** realQuote / threshold in bps, capped at 10000. */
  progressBps: number;
  graduated: boolean;
  finalized: boolean;
}

export interface Graduation {
  block: number;
  at: number;
  memeToPool: Uint;
  quoteToPool: Uint;
  liquidity: Uint;
  memeIsCurrency0: boolean;
  /** Latest pool price, from the most recent Swap. Null until the pool has traded. Sizing a liquidity position
   *  needs it, and the testnet deployment has no StateView to read slot0 from. */
  sqrtPriceX96: Uint | null;
}

/** 0 none, 1 curve active, 2 graduation pending, 3 graduated, 4 refunding (a stuck graduation was rescued). */
export type LaunchStatus = 0 | 1 | 2 | 3 | 4;

export interface LaunchSummary {
  meme: Address;
  launchId: Hex;
  creator: Address;
  quote: Address;
  quoteSymbol: string;
  quoteDecimals: number;
  templateId: Hex;
  configHash: Hex;
  moduleBitmap: Uint;
  hookVersion: number | null;
  lpGrantEnabled: boolean;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: Uint | null;
  status: LaunchStatus;
  poolId: Hex | null;
  createdAt: number;
  createdBlock: number;
  createdTx: Hex;
  curve: CurveState | null;
  market: MarketStats;
  grantStatus: GrantStatus | null;
  /** Resolved token metadata (image, description, links); null until resolved or when the tokenURI is unusable. */
  metadata: TokenMetadataView | null;
}

/**
 * What the UI shows from a token's metadata JSON, sanitised by the API. `image` is an http(s) URL a browser can load
 * (ipfs:// is rewritten to the gateway). Links are https only.
 */
export interface TokenMetadataView {
  image: string | null;
  description: string | null;
  links: { x?: string; telegram?: string; website?: string };
}

/** POST /v1/media/image and /v1/media/metadata. */
export interface MediaUpload {
  /** goes on-chain / into metadata: ipfs://<cid> (pinata) or https://<api>/v1/media/<sha>.<ext> (local) */
  uri: string;
  /** http(s) URL a browser can display now */
  url: string;
  sha256: string;
  bytes: number;
}

export interface LaunchDetail extends LaunchSummary {
  graduation: Graduation | null;
  grant: GrantCampaign | null;
  fees: FeeTotals;
}

export interface FeeTotals {
  total: Uint;
  dev: Uint;
  rewards: Uint;
  lp: Uint;
  treasury: Uint;
  protocol: Uint;
  devClaimed: Uint;
  rewardsClaimed: Uint;
}

export interface Trade {
  id: string; // `${txHash}:${logIndex}`
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  side: "buy" | "sell";
  source: "curve" | "pool";
  wallet: Address;
  router: Address | null;
  quoteAmount: Uint;
  memeAmount: Uint;
  fee: Uint | null;
  priceQuote: Uint;
  priceMeme: Uint;
  price: number;
}

export interface TradesPage {
  trades: Trade[];
  /** Pass as `before` to fetch the next (older) page; null at the end. */
  nextCursor: string | null;
}

export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface Candle {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Quote volume in the bucket, raw units. */
  v: Uint;
  n: number;
}

export interface Holder {
  address: Address;
  balance: Uint;
  /** balance / circulating in bps. */
  shareBps: number;
}

export interface HoldersPage {
  count: number;
  /** totalSupply − Σ excluded (system) balances. */
  circulating: Uint;
  holders: Holder[];
}

/** IPerkLPGrantVault.CampaignStatus */
export type GrantStatus = 0 | 1 | 2 | 3 | 4 | 5;

export interface GrantCampaign {
  meme: Address;
  poolId: Hex | null;
  status: GrantStatus;
  reserve: Uint;
  basePool: Uint;
  referralBudget: Uint;
  root: Hex | null;
  rootUri: string | null;
  rootTotalBase: Uint | null;
  rootTotalInviteeBoost: Uint | null;
  rootProposedAt: number | null;
  activatableAt: number | null;
  startTime: number | null;
  endTime: number | null;
  totalActivated: Uint;
  burned: Uint;
  excessToIncentive: Uint;
  excessToTreasury: Uint;
  incentiveSwept: Uint;
  positionsCount: number;
  activePositions: number;
  initializedAt: number;
  finalizedAt: number | null;
  cancelledAt: number | null;
}

export interface GrantPosition {
  positionId: Uint;
  meme: Address;
  beneficiary: Address;
  baseActivated: Uint;
  inviteeBoostActivated: Uint;
  inviterCreditActivated: Uint;
  quoteDeposited: Uint;
  liquidity: Uint;
  activatedAt: number;
  activatedBlock: number;
  activatedTx: Hex;
  feesQuotePaid: Uint;
  feesMemePaid: Uint;
  incentivePaid: Uint;
  exited: boolean;
  exitedAt: number | null;
  exitedTx: Hex | null;
  exitQuoteToUser: Uint | null;
  exitMemeToUser: Uint | null;
  exitExcessQuote: Uint | null;
  exitMemeBurned: Uint | null;
}

/**
 * An ordinary liquidity position: one the wallet minted itself through the v4 PositionManager, as opposed to a
 * subsidised grant position, which the vault holds on the beneficiary's behalf. The two are never merged.
 */
export interface LpPosition {
  tokenId: Uint;
  owner: Address;
  /** null when the position is in a pool Perk did not create */
  meme: Address | null;
  poolId: Hex | null;
  liquidity: Uint;
  createdAt: number;
  createdBlock: number;
  closed: boolean;
}

export interface GrantAllocation {
  account: Address;
  baseAllocation: Uint;
  inviteeBoost: Uint;
  registeredAt: number;
}

/**
 * The published allocation list behind a campaign's root (packages/indexer output at `rootUri`), as the API sees it.
 * "verified": fetched, and the Merkle root rebuilt from it equals the on-chain root, so proofs can be served.
 */
export type GrantDatasetStatus = "none" | "pending" | "verified" | "mismatch" | "unreachable";

export interface GrantDataset {
  status: GrantDatasetStatus;
  uri: string | null;
  root: Hex | null;
  /** accounts in the verified list (0 otherwise) */
  accounts: number;
  checkedAt: number | null;
  error: string | null;
}

/** GET /v1/grants/:meme/proof/:account — what registerAllocation needs, for the campaign's current root. */
export interface GrantAllocationProof {
  meme: Address;
  root: Hex;
  leaf: { account: Address; baseAllocation: Uint; inviteeBoost: Uint };
  proof: Hex[];
}

export interface GrantDetail {
  campaign: GrantCampaign;
  positions: GrantPosition[];
  allocations: GrantAllocation[];
  referralCreditsTotal: Uint;
  dataset: GrantDataset;
}

export interface WalletRoles {
  address: Address;
  isAdmin: boolean;
  /** memes created by this wallet */
  creatorOf: Address[];
  /** memes where this wallet holds a grant position (active or exited) */
  lpOf: Address[];
  /** memes where this wallet has a registered allocation */
  allocatedIn: Address[];
  inviter: Address | null;
  optInBlock: number | null;
}

export interface WalletSummary extends WalletRoles {
  tradeCount: number;
  launches: LaunchSummary[];
  positions: GrantPosition[];
  recentTrades: Trade[];
  claims: Array<{ meme: Address; kind: "quote_rewards" | "dev_fees"; amount: Uint; timestamp: number; txHash: Hex }>;
  inviteeCount: number;
  referralCreditsEarned: Uint;
  /**
   * Memes this wallet holds (balance > 0 in holder_balances), each with its launch so the UI can price it.
   * Ordered by value in quote at the last trade price, largest first; unpriced holdings last. At most 100.
   */
  holdings: Array<{ launch: LaunchSummary; balance: Uint }>;
}

export interface Stats {
  launches: number;
  curveActive: number;
  graduated: number;
  activeGrants: number;
  quotes: number;
  trades24h: number;
  volume24hByQuote: Array<{ quote: Address; symbol: string; volume: Uint }>;
}

export interface ApiError {
  error: string;
  message: string;
}

// ------------------------------------------------------------------------------------------------ WebSocket /v1/ws
/**
 * Push channel for live views. REST stays the source of truth: a client loads history over REST, subscribes, and
 * after every reconnect re-fetches over REST to fill whatever it missed while disconnected (no server-side replay).
 */
export type WsTopic = "trades" | "health";

/** Client → server. One JSON object per text frame, at most 4 KiB. */
export type WsClientMessage =
  | { op: "subscribe"; topic: "trades"; meme: Address }
  | { op: "unsubscribe"; topic: "trades"; meme: Address }
  | { op: "subscribe"; topic: "health" }
  | { op: "unsubscribe"; topic: "health" }
  | { op: "ping"; id?: number };

/** Server → client. */
export type WsServerMessage =
  | { type: "hello"; chainId: number; serverTime: number; cursorBlock: number }
  | { type: "subscribed"; topic: WsTopic; meme?: Address }
  | { type: "unsubscribed"; topic: WsTopic; meme?: Address }
  /** Trades applied by the indexer since the previous push for this meme, newest first, same shape as REST. */
  | { type: "trades"; meme: Address; trades: Trade[]; cursorBlock: number }
  | { type: "health"; health: Health }
  | { type: "pong"; id?: number; serverTime: number }
  | { type: "error"; error: "bad_message" | "bad_address" | "too_many_subscriptions"; message: string };
