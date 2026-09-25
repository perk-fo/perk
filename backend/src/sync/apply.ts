/**
 * Pure-ish log application: every handler takes the transaction handle, the sync context and one decoded
 * log, and writes the derived rows. Handlers must be idempotent per (tx_hash, log_index): the caller records
 * each log in applied_logs and skips ones already present, so a crash between two logs of one range is safe
 * only because the whole range is applied in ONE database transaction (see indexer.ts).
 *
 * Numeric conventions: uint256 → bigint in, stored as numeric via `${value}` (postgres.js serialises bigint).
 * Addresses / hashes are lowercased before storage. Timestamps are unix seconds (bigint).
 * Strings from contracts (names, symbols, URIs, struct fields) go through db/text.ts before they are written: anyone
 * can put a NUL byte in a token name, and Postgres rejects it.
 * Contract reads made while applying (token metadata, a position's pool) throw when the RPC fails, which fails the
 * window so it is applied again later; only an answer the contract itself gives (a revert, no code) is stored.
 */
import type { Address, Hex } from "viem";
import type { Tx } from "../db/client";
import type { DecodedLog, SwapArgs } from "../chain/events";
import { getPositionPool, getErc20Meta, isDeterministicCallError, type Client } from "../chain/rpc";
import type { Deployment } from "../config";
import { cleanJson, cleanText, cleanUri, NAME_MAX_CHARS, SYMBOL_MAX_CHARS } from "../db/text";
import type { TrackedSet } from "./tracked";

export interface ApplyContext {
  chainId: number;
  deployment: Deployment;
  client: Client;
  tracked: TrackedSet;
  /** block number → timestamp for every block in the range being applied (pre-fetched by the indexer). */
  blockTime: Map<bigint, bigint>;
  /** tx hash → tx.from for pool swaps in the range (pre-fetched by the indexer). */
  txOrigin: Map<Hex, Address>;
  /** quote address (lowercase) → decimals; native (0x0) = 18. Filled lazily via ensureQuoteAsset. */
  quoteDecimals: Map<string, number>;
}

export const NATIVE_QUOTE = "0x0000000000000000000000000000000000000000";
/** PerkConstants.MODULE_LP_GRANT_V1 */
export const LP_GRANT_V1 = 1n << 3n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function lower(a: string): string {
  return a.toLowerCase();
}

export function tsOf(ctx: ApplyContext, log: DecodedLog): bigint {
  const t = ctx.blockTime.get(log.blockNumber);
  if (t === undefined) throw new Error(`missing block timestamp for block ${log.blockNumber}`);
  return t;
}

/** Decimal-adjusted price as a float: (quote / 10^qDec) / (meme / 10^mDec). 0 when meme is 0. */
export function priceFloat(quote: bigint, meme: bigint, quoteDecimals: number, memeDecimals: number): number {
  if (meme === 0n) return 0;
  const q = Number(quote) / 10 ** quoteDecimals;
  const m = Number(meme) / 10 ** memeDecimals;
  return m === 0 ? 0 : q / m;
}

function addr(v: unknown): string {
  return lower(String(v));
}

function hex32(v: unknown): string {
  return lower(String(v));
}

function isZeroHex(h: string): boolean {
  return /^0x0+$/i.test(h);
}

function bitmapHasLpGrant(bitmap: bigint): boolean {
  return (bitmap & LP_GRANT_V1) !== 0n;
}

function originOf(ctx: ApplyContext, txHash: string): Address | undefined {
  return ctx.txOrigin.get(lower(txHash) as Hex) ?? ctx.txOrigin.get(txHash as Hex);
}

interface LaunchDec {
  quoteDecimals: number;
  decimals: number;
}

async function launchDecimals(tx: Tx, chainId: number, meme: string): Promise<LaunchDec> {
  const rows = await tx<{ quote_decimals: number; decimals: number }[]>`
    select quote_decimals, decimals from launches where chain_id = ${chainId} and meme = ${meme}`;
  return { quoteDecimals: rows[0]?.quote_decimals ?? 18, decimals: rows[0]?.decimals ?? 18 };
}

async function touchMarket(
  tx: Tx,
  ctx: ApplyContext,
  log: DecodedLog,
  meme: string,
  quoteAmount: bigint,
  priceQuote: bigint,
  priceMeme: bigint,
): Promise<{ price: number; ts: bigint }> {
  const d = await launchDecimals(tx, ctx.chainId, meme);
  const price = priceFloat(priceQuote, priceMeme, d.quoteDecimals, d.decimals);
  const ts = tsOf(ctx, log);
  await tx`update launches set
      last_price_quote = ${priceQuote},
      last_price_meme = ${priceMeme},
      last_price = ${price},
      last_trade_at = ${ts},
      trade_count = trade_count + 1,
      volume_quote_total = volume_quote_total + ${quoteAmount},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${meme}`;
  return { price, ts };
}

/**
 * Make sure quote_assets has a row for `quote` and return its decimals. Native → OKB/18 without any RPC.
 * ERC-20 → read name/symbol/decimals once (ctx.client), insert, cache in ctx.quoteDecimals. An RPC failure throws (the
 * window is retried); a token that does not implement decimals() gets ERC-20's default of 18, one without a symbol()
 * its shortened address.
 */
export async function ensureQuoteAsset(tx: Tx, ctx: ApplyContext, quote: Address): Promise<number> {
  const q = addr(quote);
  const cached = ctx.quoteDecimals.get(q);
  if (cached !== undefined) return cached;

  const existing = await tx<{ decimals: number }[]>`
    select decimals from quote_assets where chain_id = ${ctx.chainId} and quote = ${q}`;
  if (existing[0]) {
    ctx.quoteDecimals.set(q, existing[0].decimals);
    return existing[0].decimals;
  }

  if (q === NATIVE_QUOTE) {
    await tx`insert into quote_assets (chain_id, quote, symbol, name, decimals)
      values (${ctx.chainId}, ${q}, ${"OKB"}, ${"OKB"}, ${18})
      on conflict do nothing`;
    ctx.quoteDecimals.set(q, 18);
    return 18;
  }

  const meta = await getErc20Meta(ctx.client, quote);
  const name = cleanText(meta.name, NAME_MAX_CHARS);
  const symbol = cleanText(meta.symbol, SYMBOL_MAX_CHARS) ?? q.slice(0, 10);
  const decimals = meta.decimals ?? 18;

  await tx`insert into quote_assets (chain_id, quote, symbol, name, decimals)
    values (${ctx.chainId}, ${q}, ${symbol}, ${name}, ${decimals})
    on conflict do nothing`;
  ctx.quoteDecimals.set(q, decimals);
  return decimals;
}

/** Dispatch one decoded log to its handler. Unknown events are recorded in applied_logs and otherwise ignored. */
export async function applyLog(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const key = `${log.contract}.${log.eventName}`;
  const handler = HANDLERS[key];
  if (handler) await handler(tx, ctx, log);
  await tx`insert into applied_logs (chain_id, block_number, tx_hash, log_index, address, event_name)
    values (${ctx.chainId}, ${log.blockNumber}, ${lower(log.transactionHash)}, ${log.logIndex}, ${lower(log.address)}, ${key})
    on conflict do nothing`;
}

type Handler = (tx: Tx, ctx: ApplyContext, log: DecodedLog) => Promise<void>;

/* ------------------------------------------------------------------------------------------------
 * factory
 * ---------------------------------------------------------------------------------------------- */

/**
 * LaunchCreated(launchId, meme, creator, quote, templateId, configHash)
 * Insert the launches row (status CURVE_ACTIVE) with ERC-20 meta read via ctx.client.getErc20Meta-equivalent
 * (name/symbol/decimals/totalSupply), quote_decimals via ensureQuoteAsset, lp_grant_enabled from the
 * template's module bitmap if the templates row exists (bit 3 = LP_GRANT_V1) else false until
 * LaunchTemplateSelected / HookModulesCommitted fills module_bitmap. Then ctx.tracked.addMeme(meme).
 */
export async function onLaunchCreated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    launchId: Hex;
    meme: Address;
    creator: Address;
    quote: Address;
    templateId: Hex;
    configHash: Hex;
  };
  const meme = addr(a.meme);
  const quote = addr(a.quote);
  const templateId = hex32(a.templateId);
  const quoteDecimals = await ensureQuoteAsset(tx, ctx, quote as Address);

  // Throws when the RPC fails, and the window is applied again later: a placeholder name or decimals written now
  // would stay forever. A factory-made token always answers; one that did not would keep nulls.
  const meta = await getErc20Meta(ctx.client, a.meme);
  const name = cleanText(meta.name, NAME_MAX_CHARS);
  const symbol = cleanText(meta.symbol, SYMBOL_MAX_CHARS);
  const decimals = meta.decimals ?? 18;
  const totalSupply = meta.totalSupply;
  // an unusable URI (control characters, spaces, absurd length) is stored as none; the resolver marks it invalid
  const tokenUri = cleanUri(meta.tokenURI);

  let lpGrantEnabled = false;
  let moduleBitmap = 0n;
  const tmpl = await tx<{ template: { moduleBitmap?: string | number } | null }[]>`
    select template from templates where chain_id = ${ctx.chainId} and template_id = ${templateId}`;
  if (tmpl[0]?.template && tmpl[0].template.moduleBitmap !== undefined) {
    moduleBitmap = BigInt(tmpl[0].template.moduleBitmap);
    lpGrantEnabled = bitmapHasLpGrant(moduleBitmap);
  }

  const createdAt = tsOf(ctx, log);
  await tx`insert into launches (
      chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
      module_bitmap, lp_grant_enabled, name, symbol, decimals, total_supply, status,
      created_block, created_log_index, created_tx, created_at,
      token_uri, metadata_status
    ) values (
      ${ctx.chainId}, ${meme}, ${hex32(a.launchId)}, ${addr(a.creator)}, ${quote}, ${quoteDecimals},
      ${templateId}, ${hex32(a.configHash)}, ${moduleBitmap}, ${lpGrantEnabled}, ${name}, ${symbol},
      ${decimals}, ${totalSupply}, ${1}, ${log.blockNumber}, ${log.logIndex}, ${lower(log.transactionHash)}, ${createdAt},
      ${tokenUri}, ${"pending"}
    ) on conflict do nothing`;

  ctx.tracked.addMeme(a.meme);
}

/** LaunchTemplateSelected(launchId, templateId, hookVersion, moduleBitmap, moduleParamsHash) → hook_version, module_bitmap, lp_grant_enabled (bit 3). */
export async function onLaunchTemplateSelected(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    launchId: Hex;
    templateId: Hex;
    hookVersion: number;
    moduleBitmap: bigint;
    moduleParamsHash: Hex;
  };
  const bitmap = BigInt(a.moduleBitmap);
  await tx`update launches set
      hook_version = ${Number(a.hookVersion)},
      module_bitmap = ${bitmap},
      lp_grant_enabled = ${bitmapHasLpGrant(bitmap)},
      template_id = ${hex32(a.templateId)},
      updated_at = now()
    where chain_id = ${ctx.chainId} and launch_id = ${hex32(a.launchId)}`;
}

/** LaunchStatusUpdated(meme, status, poolId) → status, pool_id (null when zero). GRADUATED → ctx.tracked.addPool. */
export async function onLaunchStatusUpdated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; status: number; poolId: Hex };
  const meme = addr(a.meme);
  const status = Number(a.status);
  const poolId = hex32(a.poolId);
  const pool = isZeroHex(poolId) ? null : poolId;
  await tx`update launches set status = ${status}, pool_id = ${pool}, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${meme}`;
  if (status === 3 && pool) ctx.tracked.addPool(pool as Hex, a.meme);
}

/* ------------------------------------------------------------------------------------------------
 * curve
 * ---------------------------------------------------------------------------------------------- */

/** CurveInitialized(meme, config) → the six curve config columns. */
export async function onCurveInitialized(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    config: {
      virtualQuoteReserve: bigint;
      virtualMemeReserve: bigint;
      curveSupply: bigint;
      poolReserveSupply: bigint;
      graduationQuoteThreshold: bigint;
      totalFeeBps: number;
    };
  };
  const c = a.config;
  await tx`update launches set
      virtual_quote_reserve = ${c.virtualQuoteReserve},
      virtual_meme_reserve = ${c.virtualMemeReserve},
      curve_supply = ${c.curveSupply},
      pool_reserve_supply = ${c.poolReserveSupply},
      graduation_quote_threshold = ${c.graduationQuoteThreshold},
      total_fee_bps = ${Number(c.totalFeeBps)},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/**
 * CurveBuy(meme, buyer, recipient, quoteGross, fee, quoteNet, memeOut)
 * → trades row (side buy, source curve, wallet = buyer, quote_amount = quoteGross, meme_amount = memeOut,
 *   price_quote = quoteNet, price_meme = memeOut, price = priceFloat(...)),
 * → launches: real_quote += quoteNet, meme_sold += memeOut, market cache (last_price*, last_trade_at,
 *   trade_count, volume_quote_total += quoteGross). Skip trades with memeOut == 0 (still count nothing).
 */
export async function onCurveBuy(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    buyer: Address;
    recipient: Address;
    quoteGross: bigint;
    fee: bigint;
    quoteNet: bigint;
    memeOut: bigint;
  };
  if (a.memeOut === 0n) return;
  const meme = addr(a.meme);
  const { price, ts } = await (async () => {
    const d = await launchDecimals(tx, ctx.chainId, meme);
    const price = priceFloat(a.quoteNet, a.memeOut, d.quoteDecimals, d.decimals);
    const ts = tsOf(ctx, log);
    await tx`update launches set
        real_quote = real_quote + ${a.quoteNet},
        meme_sold = meme_sold + ${a.memeOut},
        last_price_quote = ${a.quoteNet},
        last_price_meme = ${a.memeOut},
        last_price = ${price},
        last_trade_at = ${ts},
        trade_count = trade_count + 1,
        volume_quote_total = volume_quote_total + ${a.quoteGross},
        updated_at = now()
      where chain_id = ${ctx.chainId} and meme = ${meme}`;
    return { price, ts };
  })();
  await tx`insert into trades (
      chain_id, tx_hash, log_index, meme, block_number, ts, side, source, wallet, router,
      quote_amount, meme_amount, fee, price_quote, price_meme, price
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${meme}, ${log.blockNumber}, ${ts},
      ${"buy"}, ${"curve"}, ${addr(a.buyer)}, ${null}, ${a.quoteGross}, ${a.memeOut}, ${a.fee},
      ${a.quoteNet}, ${a.memeOut}, ${price}
    ) on conflict do nothing`;
}

/**
 * CurveSell(meme, seller, recipient, memeIn, quoteGross, fee, quoteNet)
 * → trades row (side sell, wallet = seller, quote_amount = quoteGross, meme_amount = memeIn,
 *   price_quote = quoteGross, price_meme = memeIn),
 * → launches: real_quote -= quoteGross, meme_sold -= memeIn, market cache as for buys.
 */
export async function onCurveSell(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    seller: Address;
    recipient: Address;
    memeIn: bigint;
    quoteGross: bigint;
    fee: bigint;
    quoteNet: bigint;
  };
  const meme = addr(a.meme);
  const d = await launchDecimals(tx, ctx.chainId, meme);
  const price = priceFloat(a.quoteGross, a.memeIn, d.quoteDecimals, d.decimals);
  const ts = tsOf(ctx, log);
  await tx`update launches set
      real_quote = real_quote - ${a.quoteGross},
      meme_sold = meme_sold - ${a.memeIn},
      last_price_quote = ${a.quoteGross},
      last_price_meme = ${a.memeIn},
      last_price = ${price},
      last_trade_at = ${ts},
      trade_count = trade_count + 1,
      volume_quote_total = volume_quote_total + ${a.quoteGross},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${meme}`;
  await tx`insert into trades (
      chain_id, tx_hash, log_index, meme, block_number, ts, side, source, wallet, router,
      quote_amount, meme_amount, fee, price_quote, price_meme, price
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${meme}, ${log.blockNumber}, ${ts},
      ${"sell"}, ${"curve"}, ${addr(a.seller)}, ${null}, ${a.quoteGross}, ${a.memeIn}, ${a.fee},
      ${a.quoteGross}, ${a.memeIn}, ${price}
    ) on conflict do nothing`;
}

/** CurveGraduationReached(meme, realQuote, memeSold, finalPriceX18) → curve_graduated = true, real_quote/meme_sold snapped to the event values. */
export async function onCurveGraduationReached(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; realQuote: bigint; memeSold: bigint; finalPriceX18: bigint };
  await tx`update launches set
      curve_graduated = true,
      real_quote = ${a.realQuote},
      meme_sold = ${a.memeSold},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** CurveFinalized(meme, to, memeOut, quoteOut) → curve_finalized = true. */
export async function onCurveFinalized(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; to: Address; memeOut: bigint; quoteOut: bigint };
  await tx`update launches set curve_finalized = true, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/* ------------------------------------------------------------------------------------------------
 * graduation
 * ---------------------------------------------------------------------------------------------- */

/**
 * LaunchGraduated(meme, launchId, poolId, memeToPool, quoteToPool, liquidity)
 * → graduated_block/at, meme_to_pool, quote_to_pool, pool_liquidity, pool_id, status = 3,
 *   meme_is_currency0 = meme < quote (v4 sorts currencies; native 0x0 is always currency0),
 *   ctx.tracked.addPool(poolId, meme).
 */
export async function onLaunchGraduated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    launchId: Hex;
    poolId: Hex;
    memeToPool: bigint;
    quoteToPool: bigint;
    liquidity: bigint;
  };
  const meme = addr(a.meme);
  const poolId = hex32(a.poolId);
  const rows = await tx<{ quote: string }[]>`
    select quote from launches where chain_id = ${ctx.chainId} and meme = ${meme}`;
  const quote = rows[0]?.quote ?? NATIVE_QUOTE;
  const memeIsCurrency0 = meme < quote;
  const ts = tsOf(ctx, log);
  await tx`update launches set
      graduated_block = ${log.blockNumber},
      graduated_at = ${ts},
      meme_to_pool = ${a.memeToPool},
      quote_to_pool = ${a.quoteToPool},
      pool_liquidity = ${a.liquidity},
      pool_id = ${poolId},
      status = ${3},
      meme_is_currency0 = ${memeIsCurrency0},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${meme}`;
  ctx.tracked.addPool(poolId as Hex, a.meme);
}

/* ------------------------------------------------------------------------------------------------
 * pool swaps (PoolManager) — only for tracked pool ids
 * ---------------------------------------------------------------------------------------------- */

/**
 * Swap(id, sender, amount0, amount1, ...) for a tracked pool.
 * memeDelta / quoteDelta chosen with launches.meme_is_currency0; amounts = |delta|; skip if either is 0.
 * side = quoteDelta < 0 ? buy : sell (swapper paid quote ⇒ buy). wallet = ctx.txOrigin.get(txHash) ?? sender;
 * router = sender when it differs from wallet. quote_amount/meme_amount/price_* = the absolute deltas.
 * Update the launch market cache like curve trades (real_quote/meme_sold untouched).
 */
export async function onPoolSwap(tx: Tx, ctx: ApplyContext, log: DecodedLog<SwapArgs>): Promise<void> {
  const a = log.args;
  const poolId = hex32(a.id);
  const meme = ctx.tracked.memeForPool(poolId as Hex);
  if (!meme) return;
  const m = addr(meme);
  const rows = await tx<{ meme_is_currency0: boolean | null }[]>`
    select meme_is_currency0 from launches where chain_id = ${ctx.chainId} and meme = ${m}`;
  if (!rows[0] || rows[0].meme_is_currency0 === null) return;

  const amount0 = BigInt(a.amount0);
  const amount1 = BigInt(a.amount1);
  const memeDelta = rows[0].meme_is_currency0 ? amount0 : amount1;
  const quoteDelta = rows[0].meme_is_currency0 ? amount1 : amount0;
  const memeAmount = memeDelta < 0n ? -memeDelta : memeDelta;
  const quoteAmount = quoteDelta < 0n ? -quoteDelta : quoteDelta;
  if (memeAmount === 0n || quoteAmount === 0n) return;

  await tx`update launches set last_sqrt_price_x96 = ${a.sqrtPriceX96.toString()}, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${m}`;

  const side = quoteDelta < 0n ? "buy" : "sell";
  const sender = addr(a.sender);
  const wallet = addr(originOf(ctx, log.transactionHash) ?? a.sender);
  const router = sender !== wallet ? sender : null;
  const { price, ts } = await touchMarket(tx, ctx, log, m, quoteAmount, quoteAmount, memeAmount);
  await tx`insert into trades (
      chain_id, tx_hash, log_index, meme, block_number, ts, side, source, wallet, router,
      quote_amount, meme_amount, fee, price_quote, price_meme, price
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${m}, ${log.blockNumber}, ${ts},
      ${side}, ${"pool"}, ${wallet}, ${router}, ${quoteAmount}, ${memeAmount}, ${null},
      ${quoteAmount}, ${memeAmount}, ${price}
    ) on conflict do nothing`;
}

/* ------------------------------------------------------------------------------------------------
 * meme token transfers → holder balances
 * ---------------------------------------------------------------------------------------------- */

/**
 * Transfer(from, to, value) of a tracked meme. Insert token_transfers; upsert holder_balances for both sides
 * (skip the zero address; mint/burn only touch the other side); delete rows that reach 0; recompute
 * launches.holder_count = count(holder_balances where balance > 0 and holder not excluded).
 * Performance: one statement per side, no full recount per log — maintain holder_count incrementally
 * (+1 when a balance goes 0→>0, −1 when >0→0, ignoring excluded accounts).
 */
export async function onTransfer(
  tx: Tx,
  ctx: ApplyContext,
  log: DecodedLog<{ from: Address; to: Address; value: bigint }>,
): Promise<void> {
  const meme = addr(log.address);
  const from = addr(log.args.from);
  const to = addr(log.args.to);
  const value = BigInt(log.args.value);

  await tx`insert into token_transfers (chain_id, tx_hash, log_index, meme, from_addr, to_addr, value, block_number)
    values (${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${meme}, ${from}, ${to}, ${value}, ${log.blockNumber})
    on conflict do nothing`;

  await adjustHolder(tx, ctx, meme, from, -value, log.blockNumber);
  await adjustHolder(tx, ctx, meme, to, value, log.blockNumber);
}

async function isExcluded(tx: Tx, chainId: number, meme: string, account: string): Promise<boolean> {
  const rows = await tx<{ excluded: boolean }[]>`
    select excluded from holder_exclusions
    where chain_id = ${chainId} and meme = ${meme} and account = ${account}`;
  return rows[0]?.excluded === true;
}

async function adjustHolder(
  tx: Tx,
  ctx: ApplyContext,
  meme: string,
  holder: string,
  delta: bigint,
  block: bigint,
): Promise<void> {
  if (holder === NATIVE_QUOTE || delta === 0n) return;

  const rows = await tx<{ balance: string }[]>`
    select balance from holder_balances
    where chain_id = ${ctx.chainId} and meme = ${meme} and holder = ${holder}`;
  const old = rows[0] ? BigInt(rows[0].balance) : 0n;
  const next = old + delta;

  if (next === 0n) {
    if (rows[0]) {
      await tx`delete from holder_balances
        where chain_id = ${ctx.chainId} and meme = ${meme} and holder = ${holder}`;
    }
  } else if (rows[0]) {
    await tx`update holder_balances set balance = ${next}, updated_block = ${block}
      where chain_id = ${ctx.chainId} and meme = ${meme} and holder = ${holder}`;
  } else {
    await tx`insert into holder_balances (chain_id, meme, holder, balance, updated_block)
      values (${ctx.chainId}, ${meme}, ${holder}, ${next}, ${block})
      on conflict (chain_id, meme, holder) do update set
        balance = ${next}, updated_block = ${block}`;
  }

  if (await isExcluded(tx, ctx.chainId, meme, holder)) return;
  if (old === 0n && next > 0n) {
    await tx`update launches set holder_count = holder_count + 1, updated_at = now()
      where chain_id = ${ctx.chainId} and meme = ${meme}`;
  } else if (old > 0n && next === 0n) {
    await tx`update launches set holder_count = greatest(holder_count - 1, 0), updated_at = now()
      where chain_id = ${ctx.chainId} and meme = ${meme}`;
  }
}

/* ------------------------------------------------------------------------------------------------
 * fees & rewards
 * ---------------------------------------------------------------------------------------------- */

/** FeesRouted(meme, source, amount, devShare, rewardsShare, lpShare, treasuryShare, protocolShare) → fee_events row. */
export async function onFeesRouted(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    source: number;
    amount: bigint;
    devShare: bigint;
    rewardsShare: bigint;
    lpShare: bigint;
    treasuryShare: bigint;
    protocolShare: bigint;
  };
  await tx`insert into fee_events (
      chain_id, tx_hash, log_index, meme, source, amount, dev_share, rewards_share, lp_share,
      treasury_share, protocol_share, block_number, ts
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${addr(a.meme)}, ${Number(a.source)},
      ${a.amount}, ${a.devShare}, ${a.rewardsShare}, ${a.lpShare}, ${a.treasuryShare}, ${a.protocolShare},
      ${log.blockNumber}, ${tsOf(ctx, log)}
    ) on conflict do nothing`;
}

/** DevFeesClaimed(meme, dev, amount) → reward_claims kind dev_fees. */
export async function onDevFeesClaimed(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; dev: Address; amount: bigint };
  await tx`insert into reward_claims (
      chain_id, tx_hash, log_index, meme, account, kind, amount, block_number, ts
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${addr(a.meme)}, ${addr(a.dev)},
      ${"dev_fees"}, ${a.amount}, ${log.blockNumber}, ${tsOf(ctx, log)}
    ) on conflict do nothing`;
}

/** QuoteRewardsClaimed(meme, account, quoteAmount) → reward_claims kind quote_rewards. */
export async function onQuoteRewardsClaimed(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; account: Address; quoteAmount: bigint };
  await tx`insert into reward_claims (
      chain_id, tx_hash, log_index, meme, account, kind, amount, block_number, ts
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${addr(a.meme)}, ${addr(a.account)},
      ${"quote_rewards"}, ${a.quoteAmount}, ${log.blockNumber}, ${tsOf(ctx, log)}
    ) on conflict do nothing`;
}

/** RewardEligibilityUpdated(meme, account, excluded) → holder_exclusions upsert; adjust launches.holder_count if the account currently holds a balance. */
export async function onRewardEligibilityUpdated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; account: Address; excluded: boolean };
  const meme = addr(a.meme);
  const account = addr(a.account);
  const excluded = Boolean(a.excluded);
  const prev = await tx<{ excluded: boolean }[]>`
    select excluded from holder_exclusions
    where chain_id = ${ctx.chainId} and meme = ${meme} and account = ${account}`;
  const was = prev[0]?.excluded === true;
  await tx`insert into holder_exclusions (chain_id, meme, account, excluded)
    values (${ctx.chainId}, ${meme}, ${account}, ${excluded})
    on conflict (chain_id, meme, account) do update set excluded = ${excluded}`;
  if (was === excluded) return;
  const bal = await tx<{ balance: string }[]>`
    select balance from holder_balances
    where chain_id = ${ctx.chainId} and meme = ${meme} and holder = ${account}`;
  if (!bal[0] || BigInt(bal[0].balance) <= 0n) return;
  const delta = excluded ? -1 : 1;
  await tx`update launches set holder_count = greatest(holder_count + ${delta}, 0), updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${meme}`;
}

/* ------------------------------------------------------------------------------------------------
 * LP grant vault
 * ---------------------------------------------------------------------------------------------- */

/** CampaignInitialized(meme, poolId, reserve, basePool, referralBudget) → grant_campaigns row, status AWAITING_ROOT (1). */
export async function onCampaignInitialized(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    poolId: Hex;
    reserve: bigint;
    basePool: bigint;
    referralBudget: bigint;
  };
  const ts = tsOf(ctx, log);
  await tx`insert into grant_campaigns (
      chain_id, meme, pool_id, status, reserve, base_pool, referral_budget, initialized_block, initialized_at
    ) values (
      ${ctx.chainId}, ${addr(a.meme)}, ${hex32(a.poolId)}, ${1}, ${a.reserve}, ${a.basePool}, ${a.referralBudget},
      ${log.blockNumber}, ${ts}
    ) on conflict do nothing`;
}

/** GrantRootProposed(meme, root, uri, totalBase, totalInviteeBoost, activatableAt) → root fields, status ROOT_PROPOSED (2), root_proposed_at = block ts. */
export async function onGrantRootProposed(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    meme: Address;
    root: Hex;
    uri: string;
    totalBase: bigint;
    totalInviteeBoost: bigint;
    activatableAt: bigint | number;
  };
  await tx`update grant_campaigns set
      root = ${hex32(a.root)},
      root_uri = ${cleanUri(a.uri)},
      root_total_base = ${a.totalBase},
      root_total_invitee_boost = ${a.totalInviteeBoost},
      activatable_at = ${BigInt(a.activatableAt)},
      status = ${2},
      root_proposed_at = ${tsOf(ctx, log)},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** GrantRootCancelled(meme, root) → root fields cleared, status back to AWAITING_ROOT (1). */
export async function onGrantRootCancelled(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; root: Hex };
  await tx`update grant_campaigns set
      root = null,
      root_uri = null,
      root_total_base = null,
      root_total_invitee_boost = null,
      activatable_at = null,
      root_proposed_at = null,
      status = ${1},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** GrantRootPublished(meme, root, startTime, endTime) → start_time, end_time, status ACTIVE (3). */
export async function onGrantRootPublished(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; root: Hex; startTime: bigint | number; endTime: bigint | number };
  await tx`update grant_campaigns set
      root = ${hex32(a.root)},
      start_time = ${BigInt(a.startTime)},
      end_time = ${BigInt(a.endTime)},
      status = ${3},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** CampaignCancelled(meme, memeBurned) → status CANCELLED (5), burned += memeBurned, cancelled_at. */
export async function onCampaignCancelled(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; memeBurned: bigint };
  await tx`update grant_campaigns set
      status = ${5},
      burned = burned + ${a.memeBurned},
      cancelled_at = ${tsOf(ctx, log)},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** AllocationRegistered(meme, account, baseAllocation, inviteeBoost) → grant_allocations upsert. */
export async function onAllocationRegistered(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; account: Address; baseAllocation: bigint; inviteeBoost: bigint };
  const ts = tsOf(ctx, log);
  await tx`insert into grant_allocations (
      chain_id, meme, account, base_allocation, invitee_boost, registered_block, registered_at
    ) values (
      ${ctx.chainId}, ${addr(a.meme)}, ${addr(a.account)}, ${a.baseAllocation}, ${a.inviteeBoost},
      ${log.blockNumber}, ${ts}
    ) on conflict (chain_id, meme, account) do update set
      base_allocation = ${a.baseAllocation},
      invitee_boost = ${a.inviteeBoost},
      registered_block = ${log.blockNumber},
      registered_at = ${ts}`;
}

/** InviterCreditEarned(meme, inviter, invitee, amount) → referral_credits row. */
export async function onInviterCreditEarned(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; inviter: Address; invitee: Address; amount: bigint };
  await tx`insert into referral_credits (
      chain_id, tx_hash, log_index, meme, inviter, invitee, amount, block_number
    ) values (
      ${ctx.chainId}, ${lower(log.transactionHash)}, ${log.logIndex}, ${addr(a.meme)}, ${addr(a.inviter)},
      ${addr(a.invitee)}, ${a.amount}, ${log.blockNumber}
    ) on conflict do nothing`;
}

/**
 * GrantActivated(positionId, meme, beneficiary, baseActivated, inviteeBoostActivated, inviterCreditActivated,
 * quoteDeposited, liquidity) → grant_positions row; grant_campaigns.total_activated += base+boost+credit,
 * positions_count += 1, active_positions += 1.
 */
export async function onGrantActivated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    positionId: bigint;
    meme: Address;
    beneficiary: Address;
    baseActivated: bigint;
    inviteeBoostActivated: bigint;
    inviterCreditActivated: bigint;
    quoteDeposited: bigint;
    liquidity: bigint;
  };
  const ts = tsOf(ctx, log);
  const added = a.baseActivated + a.inviteeBoostActivated + a.inviterCreditActivated;
  await tx`insert into grant_positions (
      chain_id, position_id, meme, beneficiary, base_activated, invitee_boost_activated, inviter_credit_activated,
      quote_deposited, liquidity, activated_block, activated_at, activated_tx
    ) values (
      ${ctx.chainId}, ${a.positionId}, ${addr(a.meme)}, ${addr(a.beneficiary)}, ${a.baseActivated},
      ${a.inviteeBoostActivated}, ${a.inviterCreditActivated}, ${a.quoteDeposited}, ${a.liquidity},
      ${log.blockNumber}, ${ts}, ${lower(log.transactionHash)}
    ) on conflict do nothing`;
  await tx`update grant_campaigns set
      total_activated = total_activated + ${added},
      positions_count = positions_count + 1,
      active_positions = active_positions + 1,
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** GrantFeesCollected(positionId, quoteFeesPaid, memeFeesPaid, incentivePaid) → position fee counters +=. */
export async function onGrantFeesCollected(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    positionId: bigint;
    quoteFeesPaid: bigint;
    memeFeesPaid: bigint;
    incentivePaid: bigint;
  };
  await tx`update grant_positions set
      fees_quote_paid = fees_quote_paid + ${a.quoteFeesPaid},
      fees_meme_paid = fees_meme_paid + ${a.memeFeesPaid},
      incentive_paid = incentive_paid + ${a.incentivePaid}
    where chain_id = ${ctx.chainId} and position_id = ${a.positionId}`;
}

/**
 * GrantPositionExited(positionId, quoteToUser, memeToUser, excessQuote, memeBurned, incentivePaid) → exited = true,
 * exit_* fields, exited_at/tx, incentive_paid += incentivePaid; campaign active_positions -= 1.
 */
export async function onGrantPositionExited(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    positionId: bigint;
    quoteToUser: bigint;
    memeToUser: bigint;
    excessQuote: bigint;
    memeBurned: bigint;
    incentivePaid: bigint;
  };
  const ts = tsOf(ctx, log);
  const rows = await tx<{ meme: string; exited: boolean }[]>`
    select meme, exited from grant_positions
    where chain_id = ${ctx.chainId} and position_id = ${a.positionId}`;
  await tx`update grant_positions set
      exited = true,
      exit_quote_to_user = ${a.quoteToUser},
      exit_meme_to_user = ${a.memeToUser},
      exit_excess_quote = ${a.excessQuote},
      exit_meme_burned = ${a.memeBurned},
      incentive_paid = incentive_paid + ${a.incentivePaid},
      exited_at = ${ts},
      exited_tx = ${lower(log.transactionHash)}
    where chain_id = ${ctx.chainId} and position_id = ${a.positionId}`;
  if (rows[0] && !rows[0].exited) {
    await tx`update grant_campaigns set
        active_positions = greatest(active_positions - 1, 0),
        updated_at = now()
      where chain_id = ${ctx.chainId} and meme = ${rows[0].meme}`;
  }
}

/** ExcessQuoteRouted(meme, toIncentivePool, toTreasury) → campaign excess_to_incentive / excess_to_treasury +=. */
export async function onExcessQuoteRouted(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; toIncentivePool: bigint; toTreasury: bigint };
  await tx`update grant_campaigns set
      excess_to_incentive = excess_to_incentive + ${a.toIncentivePool},
      excess_to_treasury = excess_to_treasury + ${a.toTreasury},
      updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** GrantMemeBurned(meme, amount, reason) → campaign burned += amount. */
export async function onGrantMemeBurned(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; amount: bigint; reason: Hex };
  await tx`update grant_campaigns set burned = burned + ${a.amount}, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** GrantFinalized(meme, unactivatedMemeBurned) → status EXPIRED (4), finalized_at. (burned already counted via GrantMemeBurned.) */
export async function onGrantFinalized(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; unactivatedMemeBurned: bigint };
  await tx`update grant_campaigns set status = ${4}, finalized_at = ${tsOf(ctx, log)}, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/** IncentiveSwept(meme, toTreasury) → incentive_swept += toTreasury. */
export async function onIncentiveSwept(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { meme: Address; toTreasury: bigint };
  await tx`update grant_campaigns set incentive_swept = incentive_swept + ${a.toTreasury}, updated_at = now()
    where chain_id = ${ctx.chainId} and meme = ${addr(a.meme)}`;
}

/* ------------------------------------------------------------------------------------------------
 * referral registry / registries
 * ---------------------------------------------------------------------------------------------- */

/** InviterBound(invitee, inviter, blockNumber) → referrals upsert. */
export async function onInviterBound(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { invitee: Address; inviter: Address; blockNumber: bigint | number };
  await tx`insert into referrals (chain_id, invitee, inviter, bound_block)
    values (${ctx.chainId}, ${addr(a.invitee)}, ${addr(a.inviter)}, ${BigInt(a.blockNumber)})
    on conflict (chain_id, invitee) do update set
      inviter = ${addr(a.inviter)},
      bound_block = ${BigInt(a.blockNumber)}`;
}

/** OptedIn(account, blockNumber) → opt_ins upsert (keep the earliest block). */
export async function onOptedIn(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { account: Address; blockNumber: bigint | number };
  const block = BigInt(a.blockNumber);
  await tx`insert into opt_ins (chain_id, account, block)
    values (${ctx.chainId}, ${addr(a.account)}, ${block})
    on conflict (chain_id, account) do update set block = least(opt_ins.block, ${block})`;
}

/** TemplateRegistered(templateId, template) → templates row (status PROPOSED unless already present), template jsonb with bigints as strings. */
export async function onTemplateRegistered(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { templateId: Hex; template: { status?: number } };
  const tid = hex32(a.templateId);
  const body = cleanJson(a.template);
  // registration emits no TemplateStatusUpdated: the status it starts in is the one inside the struct
  const status = Number(a.template.status ?? 0);
  await tx`insert into templates (chain_id, template_id, status, registered_block, template)
    values (${ctx.chainId}, ${tid}, ${status}, ${log.blockNumber}, ${tx.json(body as never)})
    on conflict (chain_id, template_id) do update set
      template = ${tx.json(body as never)},
      registered_block = coalesce(templates.registered_block, ${log.blockNumber})`;
}

/** TemplateStatusUpdated(templateId, status) → templates.status. */
export async function onTemplateStatusUpdated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { templateId: Hex; status: number };
  await tx`update templates set status = ${Number(a.status)}
    where chain_id = ${ctx.chainId} and template_id = ${hex32(a.templateId)}`;
}

/** AssetUpdated(quote, info) → quote_assets upsert (symbol/decimals via ensureQuoteAsset, kind/allowed/info from the struct). */
export async function onAssetUpdated(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as {
    quote: Address;
    info: { enabled: boolean; rewardCompatible: boolean; isNative: boolean; decimals: number; symbol: string };
  };
  const q = addr(a.quote) as Address;
  await ensureQuoteAsset(tx, ctx, q);
  const info = a.info;
  const decimals = Number(info.decimals);
  await tx`update quote_assets set
      symbol = coalesce(${cleanText(info.symbol, SYMBOL_MAX_CHARS)}, symbol),
      decimals = ${decimals},
      allowed = ${Boolean(info.enabled)},
      info = ${tx.json(cleanJson(info) as never)}
    where chain_id = ${ctx.chainId} and quote = ${addr(q)}`;
  ctx.quoteDecimals.set(addr(q), decimals);
}

/**
 * Admin roles held on-chain. The factory's owner is the Core Admin (every contract has the same owner; the factory is
 * the one the site reads), and the grant vault's publisher is the Grant Admin. Each change is kept as a row so a
 * reorg only deletes rows; the current holder is the latest one.
 */
async function recordChainRole(tx: Tx, ctx: ApplyContext, log: DecodedLog, role: "core" | "grant", holder: string) {
  await tx`insert into chain_role_events (chain_id, role, address, block_number, log_index)
    values (${ctx.chainId}, ${role}, ${lower(holder)}, ${log.blockNumber}, ${log.logIndex})
    on conflict do nothing`;
}

/** OwnershipTransferred(previousOwner, newOwner) on the factory. */
export async function onCoreAdminChanged(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { previousOwner: Address; newOwner: Address };
  await recordChainRole(tx, ctx, log, "core", a.newOwner);
}

/** PublisherUpdated(previous, current) on the grant vault. */
export async function onGrantAdminChanged(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { previous: Address; current: Address };
  await recordChainRole(tx, ctx, log, "grant", a.current);
}

/**
 * PositionManager ERC-721 Transfer: an ordinary LP position was minted, moved or burnt.
 *
 * These are positions a wallet holds itself, as opposed to grant positions, which the vault owns on the
 * beneficiary's behalf and which are tracked in `grant_positions`. Vault-owned ids are skipped here so the two
 * never mix in a wallet's view. On a mint the pool is resolved once through the PositionManager and matched to an
 * indexed launch; a position in a pool Perk did not create is recorded with a null meme and simply never surfaces.
 */
export async function onLpPositionTransfer(tx: Tx, ctx: ApplyContext, log: DecodedLog): Promise<void> {
  const a = log.args as { from: Address; to: Address; id: bigint };
  const vault = ctx.deployment.lpGrantVault.toLowerCase();
  const to = lower(a.to);
  const from = lower(a.from);
  const burnt = to === ZERO_ADDRESS;

  if (from === ZERO_ADDRESS) {
    // mint: resolve the pool once, then remember the position
    if (to === vault) return; // the vault's own grant positions are tracked elsewhere
    let meme: string | null = null;
    let poolId: string | null = null;
    let liquidity = 0n;
    try {
      const [key] = await getPositionPool(ctx.client, ctx.deployment.positionManager, a.id);
      poolId = key.poolId;
      liquidity = key.liquidity;
      const rows = await tx<{ meme: string }[]>`
        select meme from launches where chain_id = ${ctx.chainId} and pool_id = ${poolId} limit 1`;
      meme = rows[0]?.meme ?? null;
    } catch (err) {
      // the PositionManager refused (no such token any more): keep the position without a pool. An RPC failure is
      // not an answer, so the window is retried instead of recording the position as unmatched for good.
      if (!isDeterministicCallError(err)) throw err;
    }
    await tx`insert into lp_positions (
        chain_id, token_id, owner, meme, pool_id, liquidity, created_block, created_at
      ) values (
        ${ctx.chainId}, ${a.id}, ${to}, ${meme}, ${poolId}, ${liquidity.toString()}, ${log.blockNumber}, ${tsOf(ctx, log)}
      ) on conflict (chain_id, token_id) do update set owner = excluded.owner, updated_at = now()`;
    return;
  }

  await tx`update lp_positions set
      owner = ${burnt ? from : to},
      closed = ${burnt},
      updated_at = now()
    where chain_id = ${ctx.chainId} and token_id = ${a.id}`;
}

export const HANDLERS: Record<string, Handler> = {
  "factory.LaunchCreated": onLaunchCreated,
  "factory.LaunchTemplateSelected": onLaunchTemplateSelected,
  "factory.LaunchStatusUpdated": onLaunchStatusUpdated,
  "factory.OwnershipTransferred": onCoreAdminChanged,
  "curve.CurveInitialized": onCurveInitialized,
  "curve.CurveBuy": onCurveBuy,
  "curve.CurveSell": onCurveSell,
  "curve.CurveGraduationReached": onCurveGraduationReached,
  "curve.CurveFinalized": onCurveFinalized,
  "graduationManager.LaunchGraduated": onLaunchGraduated,
  "poolManager.Swap": onPoolSwap as unknown as Handler,
  "memeToken.Transfer": onTransfer as unknown as Handler,
  "feeRouter.FeesRouted": onFeesRouted,
  "feeRouter.DevFeesClaimed": onDevFeesClaimed,
  "distributor.QuoteRewardsClaimed": onQuoteRewardsClaimed,
  "distributor.RewardEligibilityUpdated": onRewardEligibilityUpdated,
  "lpGrantVault.CampaignInitialized": onCampaignInitialized,
  "lpGrantVault.GrantRootProposed": onGrantRootProposed,
  "lpGrantVault.GrantRootCancelled": onGrantRootCancelled,
  "lpGrantVault.GrantRootPublished": onGrantRootPublished,
  "lpGrantVault.CampaignCancelled": onCampaignCancelled,
  "lpGrantVault.AllocationRegistered": onAllocationRegistered,
  "lpGrantVault.InviterCreditEarned": onInviterCreditEarned,
  "lpGrantVault.GrantActivated": onGrantActivated,
  "lpGrantVault.GrantFeesCollected": onGrantFeesCollected,
  "lpGrantVault.GrantPositionExited": onGrantPositionExited,
  "lpGrantVault.ExcessQuoteRouted": onExcessQuoteRouted,
  "lpGrantVault.GrantMemeBurned": onGrantMemeBurned,
  "lpGrantVault.GrantFinalized": onGrantFinalized,
  "lpGrantVault.IncentiveSwept": onIncentiveSwept,
  "lpGrantVault.PublisherUpdated": onGrantAdminChanged,
  "positionManager.Transfer": onLpPositionTransfer as unknown as Handler,
  "referralRegistry.InviterBound": onInviterBound,
  "referralRegistry.OptedIn": onOptedIn,
  "templateRegistry.TemplateRegistered": onTemplateRegistered,
  "templateRegistry.TemplateStatusUpdated": onTemplateStatusUpdated,
  "assetRegistry.AssetUpdated": onAssetUpdated,
};
