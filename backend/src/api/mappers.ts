import type {
  AdminRole,
  Candle,
  CurveState,
  FeeTotals,
  Graduation,
  GrantAllocation,
  GrantCampaign,
  GrantPosition,
  GrantStatus,
  Holder,
  LaunchDetail,
  LaunchStatus,
  LaunchSummary,
  LpPosition,
  MarketStats,
  TokenMetadataView,
  Trade,
  WalletRoles,
  WalletTrade,
} from "./types";
import { addr, asBigInt, hexNull, num, numNull, uint, uintNull } from "./serialize";
import { proxiedImageUrl } from "../media/ipfsImages";

const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface LaunchRow {
  meme: string;
  launch_id: string;
  creator: string;
  quote: string;
  quote_symbol: string | null;
  quote_decimals: number | string | bigint;
  template_id: string;
  config_hash: string;
  module_bitmap: string | bigint | null;
  hook_version: number | string | bigint | null;
  lp_grant_enabled: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | string | bigint;
  total_supply: string | bigint | null;
  status: number | string | bigint;
  pool_id: string | null;
  created_at: number | string | bigint;
  created_block: number | string | bigint;
  created_tx: string;
  created_log_index?: number | string | bigint;
  virtual_quote_reserve: string | bigint | null;
  virtual_meme_reserve: string | bigint | null;
  curve_supply: string | bigint | null;
  pool_reserve_supply: string | bigint | null;
  graduation_quote_threshold: string | bigint | null;
  total_fee_bps: number | string | bigint | null;
  real_quote: string | bigint | null;
  meme_sold: string | bigint | null;
  curve_graduated: boolean | null;
  curve_finalized: boolean | null;
  graduated_block: number | string | bigint | null;
  graduated_at: number | string | bigint | null;
  meme_to_pool: string | bigint | null;
  quote_to_pool: string | bigint | null;
  pool_liquidity: string | bigint | null;
  meme_is_currency0: boolean | null;
  last_price_quote: string | bigint | null;
  last_price_meme: string | bigint | null;
  last_price: number | string | null;
  last_trade_at: number | string | bigint | null;
  trade_count: number | string | bigint;
  volume_quote_total: string | bigint | null;
  holder_count: number | string | bigint;
  grant_status: number | string | bigint | null;
  volume_24h: string | bigint | null;
  n_24h: number | string | bigint | null;
  first_pq: string | bigint | null;
  first_pm: string | bigint | null;
  last_pq: string | bigint | null;
  last_pm: string | bigint | null;
  last_sqrt_price_x96?: string | bigint | null;
  token_uri?: string | null;
  metadata?: unknown;
  metadata_status?: string | null;
  /** launch_moderation, joined by launchFrom */
  mod_hidden?: boolean | null;
  mod_media_hidden?: boolean | null;
}

export interface TradeRow {
  tx_hash: string;
  log_index: number | string | bigint;
  block_number: number | string | bigint;
  ts: number | string | bigint;
  side: string;
  source: string;
  wallet: string;
  router: string | null;
  quote_amount: string | bigint;
  meme_amount: string | bigint;
  fee: string | bigint | null;
  price_quote: string | bigint;
  price_meme: string | bigint;
  price: number | string | bigint;
}

/** A trades row with the meme it belongs to (wallet views span every meme). */
export interface WalletTradeRow extends TradeRow {
  meme: string;
}

export interface CandleRow {
  t: number | string | bigint;
  o: number | string | bigint;
  h: number | string | bigint;
  l: number | string | bigint;
  c: number | string | bigint;
  v: string | bigint | null;
  n: number | string | bigint;
}

export interface GrantCampaignRow {
  meme: string;
  pool_id: string | null;
  status: number | string | bigint;
  reserve: string | bigint | null;
  base_pool: string | bigint | null;
  referral_budget: string | bigint | null;
  root: string | null;
  root_uri: string | null;
  root_total_base: string | bigint | null;
  root_total_invitee_boost: string | bigint | null;
  root_proposed_at: number | string | bigint | null;
  activatable_at: number | string | bigint | null;
  start_time: number | string | bigint | null;
  end_time: number | string | bigint | null;
  total_activated: string | bigint | null;
  burned: string | bigint | null;
  excess_to_incentive: string | bigint | null;
  excess_to_treasury: string | bigint | null;
  incentive_swept: string | bigint | null;
  positions_count: number | string | bigint | null;
  active_positions: number | string | bigint | null;
  initialized_at: number | string | bigint;
  finalized_at: number | string | bigint | null;
  cancelled_at: number | string | bigint | null;
}

export interface GrantPositionRow {
  position_id: string | bigint;
  meme: string;
  beneficiary: string;
  base_activated: string | bigint | null;
  invitee_boost_activated: string | bigint | null;
  inviter_credit_activated: string | bigint | null;
  quote_deposited: string | bigint | null;
  liquidity: string | bigint | null;
  activated_at: number | string | bigint;
  activated_block: number | string | bigint;
  activated_tx: string;
  fees_quote_paid: string | bigint | null;
  fees_meme_paid: string | bigint | null;
  incentive_paid: string | bigint | null;
  exited: boolean;
  exited_at: number | string | bigint | null;
  exited_tx: string | null;
  exit_quote_to_user: string | bigint | null;
  exit_excess_quote: string | bigint | null;
  exit_meme_to_user: string | bigint | null;
  exit_meme_burned: string | bigint | null;
}

export interface GrantAllocationRow {
  account: string;
  base_allocation: string | bigint | null;
  invitee_boost: string | bigint | null;
  registered_at: number | string | bigint;
}

export interface FeeTotalsRow {
  total: string | bigint | null;
  dev: string | bigint | null;
  rewards: string | bigint | null;
  lp: string | bigint | null;
  treasury: string | bigint | null;
  protocol: string | bigint | null;
  dev_claimed: string | bigint | null;
  rewards_claimed: string | bigint | null;
}

export interface HolderRow {
  holder: string;
  balance: string | bigint;
}

/** progressBps = min(10000, real_quote * 10000 / threshold). */
export function progressBps(realQuote: bigint, threshold: bigint): number {
  if (threshold <= 0n) return 0;
  const bps = (realQuote * 10_000n) / threshold;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/**
 * bps change between the first and last trade of a window. 0 when fewer than 2 trades.
 * ((lastQ/lastM) - (firstQ/firstM)) / (firstQ/firstM) * 10000, integer division toward 0.
 */
export function change24hBps(n: number, firstQ: bigint, firstM: bigint, lastQ: bigint, lastM: bigint): number {
  if (n < 2 || firstQ === 0n || firstM === 0n || lastM === 0n) return 0;
  const lastP = lastQ * firstM;
  const firstP = firstQ * lastM;
  if (firstP === 0n) return 0;
  return Number(((lastP - firstP) * 10_000n) / firstP);
}

/** last_price_quote * total_supply / last_price_meme. Null when no trade or zero meme side. */
export function marketCapQuote(lastQ: bigint | null, lastM: bigint | null, supply: bigint | null): string | null {
  if (lastQ === null || lastM === null || lastM === 0n || supply === null) return null;
  return (lastQ * supply / lastM).toString();
}

export function mapMarket(row: LaunchRow): MarketStats {
  const n24 = num(row.n_24h);
  const lastQ = row.last_price_quote === null || row.last_price_quote === undefined ? null : asBigInt(row.last_price_quote);
  const lastM = row.last_price_meme === null || row.last_price_meme === undefined ? null : asBigInt(row.last_price_meme);
  const supply = row.total_supply === null || row.total_supply === undefined ? null : asBigInt(row.total_supply);
  return {
    lastPriceQuote: uintNull(row.last_price_quote),
    lastPriceMeme: uintNull(row.last_price_meme),
    lastPrice: row.last_price === null || row.last_price === undefined ? null : num(row.last_price),
    change24hBps: change24hBps(n24, asBigInt(row.first_pq), asBigInt(row.first_pm), asBigInt(row.last_pq), asBigInt(row.last_pm)),
    volume24hQuote: uint(row.volume_24h),
    volumeTotalQuote: uint(row.volume_quote_total),
    marketCapQuote: marketCapQuote(lastQ, lastM, supply),
    tradeCount: num(row.trade_count),
    holderCount: num(row.holder_count),
    lastTradeAt: numNull(row.last_trade_at),
  };
}

export function mapCurve(row: LaunchRow): CurveState | null {
  if (row.virtual_quote_reserve === null || row.virtual_quote_reserve === undefined) return null;
  const real = asBigInt(row.real_quote);
  const threshold = asBigInt(row.graduation_quote_threshold);
  return {
    virtualQuoteReserve: uint(row.virtual_quote_reserve),
    virtualMemeReserve: uint(row.virtual_meme_reserve),
    curveSupply: uint(row.curve_supply),
    poolReserveSupply: uint(row.pool_reserve_supply),
    graduationQuoteThreshold: uint(row.graduation_quote_threshold),
    totalFeeBps: num(row.total_fee_bps),
    realQuote: uint(row.real_quote),
    memeSold: uint(row.meme_sold),
    progressBps: progressBps(real, threshold),
    graduated: Boolean(row.curve_graduated),
    finalized: Boolean(row.curve_finalized),
  };
}

export function mapGraduation(row: LaunchRow): Graduation | null {
  if (row.graduated_block === null || row.graduated_block === undefined) return null;
  return {
    block: num(row.graduated_block),
    at: num(row.graduated_at),
    memeToPool: uint(row.meme_to_pool),
    quoteToPool: uint(row.quote_to_pool),
    liquidity: uint(row.pool_liquidity),
    memeIsCurrency0: Boolean(row.meme_is_currency0),
    sqrtPriceX96: uintNull(row.last_sqrt_price_x96),
  };
}

export function mapTokenMetadata(row: LaunchRow): TokenMetadataView | null {
  if (String(row.metadata_status ?? "") !== "ok") return null;
  const m = row.metadata;
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as { image?: unknown; description?: unknown; links?: unknown };
  const linksRaw = o.links && typeof o.links === "object" && !Array.isArray(o.links) ? (o.links as Record<string, unknown>) : {};
  const links: TokenMetadataView["links"] = {};
  if (typeof linksRaw.x === "string") links.x = linksRaw.x;
  if (typeof linksRaw.telegram === "string") links.telegram = linksRaw.telegram;
  if (typeof linksRaw.website === "string") links.website = linksRaw.website;
  return {
    image: typeof o.image === "string" ? proxiedImageUrl(o.image) : null,
    description: typeof o.description === "string" && o.description.length > 0 ? o.description : null,
    links,
  };
}

export function mapLpPosition(row: {
  token_id: string | bigint;
  owner: string;
  meme: string | null;
  pool_id: string | null;
  liquidity: string | bigint;
  created_at: string | number;
  created_block: string | number;
  closed: boolean;
}): LpPosition {
  return {
    tokenId: uint(row.token_id),
    owner: addr(row.owner),
    meme: row.meme === null ? null : addr(row.meme),
    poolId: hexNull(row.pool_id),
    liquidity: uint(row.liquidity),
    createdAt: num(row.created_at),
    createdBlock: num(row.created_block),
    closed: row.closed,
  };
}

export function mapLaunchSummary(row: LaunchRow): LaunchSummary {
  const pool = hexNull(row.pool_id);
  const hidden = Boolean(row.mod_hidden);
  const mediaHidden = hidden || Boolean(row.mod_media_hidden);
  return {
    meme: addr(row.meme),
    launchId: (row.launch_id.toLowerCase() || ZERO_HASH) as `0x${string}`,
    creator: addr(row.creator),
    quote: addr(row.quote),
    quoteSymbol: row.quote_symbol ?? "?",
    quoteDecimals: num(row.quote_decimals),
    templateId: (row.template_id.toLowerCase() || ZERO_HASH) as `0x${string}`,
    configHash: (row.config_hash.toLowerCase() || ZERO_HASH) as `0x${string}`,
    moduleBitmap: uint(row.module_bitmap),
    hookVersion: numNull(row.hook_version),
    lpGrantEnabled: Boolean(row.lp_grant_enabled),
    name: row.name ?? "",
    symbol: row.symbol ?? "",
    decimals: num(row.decimals),
    totalSupply: uintNull(row.total_supply),
    status: num(row.status) as LaunchStatus,
    poolId: pool,
    createdAt: num(row.created_at),
    createdBlock: num(row.created_block),
    createdTx: row.created_tx.toLowerCase() as `0x${string}`,
    curve: mapCurve(row),
    market: mapMarket(row),
    grantStatus: row.grant_status === null || row.grant_status === undefined ? null : (num(row.grant_status) as GrantStatus),
    metadata: mediaHidden ? null : mapTokenMetadata(row),
    moderation: hidden || mediaHidden ? { hidden, mediaHidden } : null,
  };
}

export function mapLaunchDetail(row: LaunchRow, grant: GrantCampaign | null, fees: FeeTotals): LaunchDetail {
  return {
    ...mapLaunchSummary(row),
    graduation: mapGraduation(row),
    grant,
    fees,
  };
}

export function mapTrade(row: TradeRow): Trade {
  const tx = row.tx_hash.toLowerCase() as `0x${string}`;
  const logIndex = num(row.log_index);
  return {
    id: `${tx}:${logIndex}`,
    txHash: tx,
    logIndex,
    blockNumber: num(row.block_number),
    timestamp: num(row.ts),
    side: row.side === "sell" ? "sell" : "buy",
    source: row.source === "pool" ? "pool" : "curve",
    wallet: addr(row.wallet),
    router: row.router ? addr(row.router) : null,
    quoteAmount: uint(row.quote_amount),
    memeAmount: uint(row.meme_amount),
    fee: uintNull(row.fee),
    priceQuote: uint(row.price_quote),
    priceMeme: uint(row.price_meme),
    price: num(row.price),
  };
}

export function mapWalletTrade(row: WalletTradeRow): WalletTrade {
  return { ...mapTrade(row), meme: addr(row.meme) };
}

export function mapCandle(row: CandleRow): Candle {
  return {
    t: num(row.t),
    o: num(row.o),
    h: num(row.h),
    l: num(row.l),
    c: num(row.c),
    v: uint(row.v),
    n: num(row.n),
  };
}

export function mapHolder(row: HolderRow, circulating: bigint): Holder {
  const balance = asBigInt(row.balance);
  const shareBps = circulating > 0n ? Number((balance * 10_000n) / circulating) : 0;
  return {
    address: addr(row.holder),
    balance: uint(row.balance),
    shareBps,
  };
}

export function mapGrantCampaign(row: GrantCampaignRow): GrantCampaign {
  return {
    meme: addr(row.meme),
    poolId: hexNull(row.pool_id),
    status: num(row.status) as GrantStatus,
    reserve: uint(row.reserve),
    basePool: uint(row.base_pool),
    referralBudget: uint(row.referral_budget),
    root: hexNull(row.root),
    rootUri: row.root_uri,
    rootTotalBase: uintNull(row.root_total_base),
    rootTotalInviteeBoost: uintNull(row.root_total_invitee_boost),
    rootProposedAt: numNull(row.root_proposed_at),
    activatableAt: numNull(row.activatable_at),
    startTime: numNull(row.start_time),
    endTime: numNull(row.end_time),
    totalActivated: uint(row.total_activated),
    burned: uint(row.burned),
    excessToIncentive: uint(row.excess_to_incentive),
    excessToTreasury: uint(row.excess_to_treasury),
    incentiveSwept: uint(row.incentive_swept),
    positionsCount: num(row.positions_count),
    activePositions: num(row.active_positions),
    initializedAt: num(row.initialized_at),
    finalizedAt: numNull(row.finalized_at),
    cancelledAt: numNull(row.cancelled_at),
  };
}

export function mapGrantPosition(row: GrantPositionRow): GrantPosition {
  return {
    positionId: uint(row.position_id),
    meme: addr(row.meme),
    beneficiary: addr(row.beneficiary),
    baseActivated: uint(row.base_activated),
    inviteeBoostActivated: uint(row.invitee_boost_activated),
    inviterCreditActivated: uint(row.inviter_credit_activated),
    quoteDeposited: uint(row.quote_deposited),
    liquidity: uint(row.liquidity),
    activatedAt: num(row.activated_at),
    activatedBlock: num(row.activated_block),
    activatedTx: row.activated_tx.toLowerCase() as `0x${string}`,
    feesQuotePaid: uint(row.fees_quote_paid),
    feesMemePaid: uint(row.fees_meme_paid),
    incentivePaid: uint(row.incentive_paid),
    exited: Boolean(row.exited),
    exitedAt: numNull(row.exited_at),
    exitedTx: hexNull(row.exited_tx),
    exitQuoteToUser: uintNull(row.exit_quote_to_user),
    exitMemeToUser: uintNull(row.exit_meme_to_user),
    exitExcessQuote: uintNull(row.exit_excess_quote),
    exitMemeBurned: uintNull(row.exit_meme_burned),
  };
}

export function mapGrantAllocation(row: GrantAllocationRow): GrantAllocation {
  return {
    account: addr(row.account),
    baseAllocation: uint(row.base_allocation),
    inviteeBoost: uint(row.invitee_boost),
    registeredAt: num(row.registered_at),
  };
}

export function mapFeeTotals(row: FeeTotalsRow | undefined): FeeTotals {
  if (!row) {
    return {
      total: "0",
      dev: "0",
      rewards: "0",
      lp: "0",
      treasury: "0",
      protocol: "0",
      devClaimed: "0",
      rewardsClaimed: "0",
    };
  }
  return {
    total: uint(row.total),
    dev: uint(row.dev),
    rewards: uint(row.rewards),
    lp: uint(row.lp),
    treasury: uint(row.treasury),
    protocol: uint(row.protocol),
    devClaimed: uint(row.dev_claimed),
    rewardsClaimed: uint(row.rewards_claimed),
  };
}

export function mapWalletRoles(
  address: `0x${string}`,
  adminRoles: AdminRole[],
  creatorOf: string[],
  lpOf: string[],
  allocatedIn: string[],
  inviter: string | null,
  optInBlock: number | string | bigint | null,
): WalletRoles {
  return {
    address: addr(address),
    isAdmin: adminRoles.length > 0,
    adminRoles,
    creatorOf: creatorOf.map((a) => addr(a)),
    lpOf: lpOf.map((a) => addr(a)),
    allocatedIn: allocatedIn.map((a) => addr(a)),
    inviter: inviter ? addr(inviter) : null,
    optInBlock: numNull(optInBlock),
  };
}
