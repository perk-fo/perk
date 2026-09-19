import type { Db } from "../db/client";
import { HttpError } from "./server";
import type {
  CandleRow,
  FeeTotalsRow,
  GrantAllocationRow,
  GrantCampaignRow,
  GrantPositionRow,
  HolderRow,
  LaunchRow,
  TradeRow,
} from "./mappers";
import { asBigInt } from "./serialize";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const LAUNCH_24H_SELECT = `
  coalesce(vol.volume_24h, 0) as volume_24h,
  coalesce(vol.n_24h, 0) as n_24h,
  vol.first_pq,
  vol.first_pm,
  vol.last_pq,
  vol.last_pm
`;

function launchFrom(cutoff: number) {
  return `
    from launches l
    left join quote_assets qa on qa.chain_id = l.chain_id and qa.quote = l.quote
    left join grant_campaigns gc on gc.chain_id = l.chain_id and gc.meme = l.meme
    left join lateral (
      select
        sum(t.quote_amount) as volume_24h,
        count(*)::int as n_24h,
        (array_agg(t.price_quote order by t.block_number asc, t.log_index asc))[1] as first_pq,
        (array_agg(t.price_meme order by t.block_number asc, t.log_index asc))[1] as first_pm,
        (array_agg(t.price_quote order by t.block_number desc, t.log_index desc))[1] as last_pq,
        (array_agg(t.price_meme order by t.block_number desc, t.log_index desc))[1] as last_pm
      from trades t
      where t.chain_id = l.chain_id and t.meme = l.meme and t.ts >= ${cutoff}
    ) vol on true
  `;
}

const LAUNCH_COLUMNS = `
  l.meme, l.launch_id, l.creator, l.quote,
  coalesce(qa.symbol, '?') as quote_symbol,
  l.quote_decimals,
  l.template_id, l.config_hash, l.module_bitmap, l.hook_version, l.lp_grant_enabled,
  l.name, l.symbol, l.decimals, l.total_supply, l.status, l.pool_id,
  l.created_at, l.created_block, l.created_tx, l.created_log_index,
  l.virtual_quote_reserve, l.virtual_meme_reserve, l.curve_supply, l.pool_reserve_supply,
  l.graduation_quote_threshold, l.total_fee_bps, l.real_quote, l.meme_sold,
  l.curve_graduated, l.curve_finalized,
  l.graduated_block, l.graduated_at, l.meme_to_pool, l.quote_to_pool, l.pool_liquidity, l.meme_is_currency0,
  l.last_price_quote, l.last_price_meme, l.last_price, l.last_trade_at,
  l.trade_count, l.volume_quote_total, l.holder_count,
  gc.status as grant_status,
  l.token_uri, l.metadata, l.metadata_status
`;

export function parseStatusList(raw: string | undefined, min: number, max: number, name = "status"): number[] | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new HttpError(400, "bad_param", `${name} must be comma-separated integers in [${min}, ${max}]`);
    }
    out.push(n);
  }
  return out;
}

export function parseTradeCursor(raw: string | undefined): { block: bigint; logIndex: number } | undefined {
  if (raw === undefined || raw === "") return undefined;
  const m = /^(\d+):(\d+)$/.exec(raw);
  if (!m) throw new HttpError(400, "bad_param", "before must be <block>:<logIndex>");
  return { block: BigInt(m[1]), logIndex: Number(m[2]) };
}

function launchOrderSql(sort: string): string {
  switch (sort) {
    case "volume":
      return "l.volume_quote_total desc, l.created_block desc, l.created_log_index desc";
    case "progress":
      return "(l.status = 3) desc, (coalesce(l.real_quote, 0) / nullif(l.graduation_quote_threshold, 0)) desc nulls last, l.created_block desc, l.created_log_index desc";
    case "trades":
      return "l.trade_count desc, l.created_block desc, l.created_log_index desc";
    case "newest":
      return "l.created_block desc, l.created_log_index desc";
    default:
      throw new HttpError(400, "bad_param", "sort must be newest|volume|progress|trades");
  }
}

export async function selectLaunchList(
  db: Db,
  chainId: number,
  opts: {
    statuses?: number[];
    quote?: string;
    creator?: string;
    sort: string;
    limit: number;
    offset: number;
    now: number;
  },
): Promise<{ rows: LaunchRow[]; total: number }> {
  const cutoff = opts.now - 86_400;
  const statuses = opts.statuses ?? [];
  const order = launchOrderSql(opts.sort);
  const countRows = await db<{ n: number | bigint | string }[]>`
    select count(*)::int as n
    from launches l
    where l.chain_id = ${chainId}
      ${statuses.length ? db`and l.status in ${db(statuses)}` : db``}
      ${opts.quote ? db`and l.quote = ${opts.quote}` : db``}
      ${opts.creator ? db`and l.creator = ${opts.creator}` : db``}
  `;
  const total = Number(countRows[0]?.n ?? 0);
  const rows = await db.unsafe<LaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}
     ${launchFrom(cutoff)}
     where l.chain_id = $1
       ${statuses.length ? `and l.status in (${statuses.map((_, i) => `$${i + 2}`).join(",")})` : ""}
       ${opts.quote ? `and l.quote = $${2 + statuses.length}` : ""}
       ${opts.creator ? `and l.creator = $${2 + statuses.length + (opts.quote ? 1 : 0)}` : ""}
     order by ${order}
     limit $${2 + statuses.length + (opts.quote ? 1 : 0) + (opts.creator ? 1 : 0)}
     offset $${3 + statuses.length + (opts.quote ? 1 : 0) + (opts.creator ? 1 : 0)}`,
    [
      chainId,
      ...statuses,
      ...(opts.quote ? [opts.quote] : []),
      ...(opts.creator ? [opts.creator] : []),
      opts.limit,
      opts.offset,
    ],
  );
  return { rows, total };
}

export async function selectLaunch(
  db: Db,
  chainId: number,
  meme: string,
  now: number,
): Promise<LaunchRow | null> {
  const cutoff = now - 86_400;
  const rows = await db.unsafe<LaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}
     ${launchFrom(cutoff)}
     where l.chain_id = $1 and l.meme = $2`,
    [chainId, meme],
  );
  return rows[0] ?? null;
}

export async function launchExists(db: Db, chainId: number, meme: string): Promise<boolean> {
  const rows = await db<{ ok: number }[]>`
    select 1 as ok from launches where chain_id = ${chainId} and meme = ${meme} limit 1
  `;
  return rows.length > 0;
}

export async function selectLaunchesByMemes(db: Db, chainId: number, memes: string[], now: number): Promise<LaunchRow[]> {
  if (memes.length === 0) return [];
  const cutoff = now - 86_400;
  return db.unsafe<LaunchRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}
     ${launchFrom(cutoff)}
     where l.chain_id = $1 and l.meme in (${memes.map((_, i) => `$${i + 2}`).join(",")})
     order by l.created_block desc, l.created_log_index desc`,
    [chainId, ...memes],
  );
}

export type WalletHoldingRow = LaunchRow & { balance: string | bigint };

export async function selectWalletHoldings(
  db: Db,
  chainId: number,
  holder: string,
  now: number,
  limit = 100,
): Promise<WalletHoldingRow[]> {
  const cutoff = now - 86_400;
  return db.unsafe<WalletHoldingRow[]>(
    `select ${LAUNCH_COLUMNS}, ${LAUNCH_24H_SELECT}, hb.balance
     ${launchFrom(cutoff)}
     inner join holder_balances hb on hb.chain_id = l.chain_id and hb.meme = l.meme
     where l.chain_id = $1 and hb.holder = $2 and hb.balance > 0
     order by (hb.balance * l.last_price_quote) / nullif(l.last_price_meme, 0) desc nulls last,
              hb.balance desc
     limit $3`,
    [chainId, holder, limit],
  );
}

export async function selectFeeTotals(db: Db, chainId: number, meme: string): Promise<FeeTotalsRow | undefined> {
  const rows = await db<FeeTotalsRow[]>`
    select
      coalesce((select sum(amount) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as total,
      coalesce((select sum(dev_share) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as dev,
      coalesce((select sum(rewards_share) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as rewards,
      coalesce((select sum(lp_share) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as lp,
      coalesce((select sum(treasury_share) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as treasury,
      coalesce((select sum(protocol_share) from fee_events f where f.chain_id = ${chainId} and f.meme = ${meme}), 0) as protocol,
      coalesce((select sum(amount) from reward_claims r where r.chain_id = ${chainId} and r.meme = ${meme} and r.kind = 'dev_fees'), 0) as dev_claimed,
      coalesce((select sum(amount) from reward_claims r where r.chain_id = ${chainId} and r.meme = ${meme} and r.kind = 'quote_rewards'), 0) as rewards_claimed
  `;
  return rows[0];
}

export async function selectTrades(
  db: Db,
  chainId: number,
  meme: string,
  limit: number,
  cursor?: { block: bigint; logIndex: number },
): Promise<TradeRow[]> {
  if (cursor) {
    return db<TradeRow[]>`
      select tx_hash, log_index, block_number, ts, side, source, wallet, router,
             quote_amount, meme_amount, fee, price_quote, price_meme, price
      from trades
      where chain_id = ${chainId} and meme = ${meme}
        and (block_number < ${cursor.block} or (block_number = ${cursor.block} and log_index < ${cursor.logIndex}))
      order by block_number desc, log_index desc
      limit ${limit}
    `;
  }
  return db<TradeRow[]>`
    select tx_hash, log_index, block_number, ts, side, source, wallet, router,
           quote_amount, meme_amount, fee, price_quote, price_meme, price
    from trades
    where chain_id = ${chainId} and meme = ${meme}
    order by block_number desc, log_index desc
    limit ${limit}
  `;
}

export async function selectTradesInRange(
  db: Db,
  chainId: number,
  meme: string,
  fromBlock: bigint | number,
  toBlock: bigint | number,
): Promise<TradeRow[]> {
  return db<TradeRow[]>`
    select tx_hash, log_index, block_number, ts, side, source, wallet, router,
           quote_amount, meme_amount, fee, price_quote, price_meme, price
    from trades
    where chain_id = ${chainId} and meme = ${meme}
      and block_number between ${fromBlock} and ${toBlock}
    order by block_number desc, log_index desc
    limit 500
  `;
}

export async function selectWalletTrades(db: Db, chainId: number, wallet: string, limit: number): Promise<TradeRow[]> {
  return db<TradeRow[]>`
    select tx_hash, log_index, block_number, ts, side, source, wallet, router,
           quote_amount, meme_amount, fee, price_quote, price_meme, price
    from trades
    where chain_id = ${chainId} and wallet = ${wallet}
    order by block_number desc, log_index desc
    limit ${limit}
  `;
}

export async function selectCandles(
  db: Db,
  chainId: number,
  meme: string,
  intervalSec: number,
  from: number,
  to: number,
  limit: number,
): Promise<CandleRow[]> {
  return db<CandleRow[]>`
    select t, o, h, l, c, v, n from (
      select
        (tr.ts / ${intervalSec}::bigint) * ${intervalSec}::bigint as t,
        (array_agg(tr.price order by tr.block_number asc, tr.log_index asc))[1] as o,
        max(tr.price) as h,
        min(tr.price) as l,
        (array_agg(tr.price order by tr.block_number desc, tr.log_index desc))[1] as c,
        sum(tr.quote_amount) as v,
        count(*)::int as n
      from trades tr
      where tr.chain_id = ${chainId}
        and tr.meme = ${meme}
        and tr.ts >= ${from}
        and tr.ts <= ${to}
      group by 1
      order by 1 desc
      limit ${limit}
    ) buckets
    order by t asc
  `;
}

export async function selectHolders(
  db: Db,
  chainId: number,
  meme: string,
  limit: number,
): Promise<{
  cachedCount: number;
  liveCount: number;
  circulating: bigint;
  holders: HolderRow[];
}> {
  const meta = await db<{ holder_count: number | bigint | string; total_supply: string | bigint | null; excluded_sum: string | bigint | null }[]>`
    select
      l.holder_count,
      l.total_supply,
      (
        select coalesce(sum(hb.balance), 0)
        from holder_balances hb
        where hb.chain_id = l.chain_id and hb.meme = l.meme
          and (
            hb.holder = ${ZERO_ADDRESS}
            or exists (
              select 1 from holder_exclusions he
              where he.chain_id = hb.chain_id and he.meme = hb.meme
                and he.account = hb.holder and he.excluded = true
            )
          )
      ) as excluded_sum
    from launches l
    where l.chain_id = ${chainId} and l.meme = ${meme}
  `;
  const m = meta[0];
  if (!m) throw new HttpError(404, "not_found", "launch not found");
  const supply = m.total_supply === null ? 0n : asBigInt(m.total_supply);
  const excluded = asBigInt(m.excluded_sum);
  const circulating = supply > excluded ? supply - excluded : 0n;

  const live = await db<{ n: number | bigint | string }[]>`
    select count(*)::int as n
    from holder_balances hb
    where hb.chain_id = ${chainId} and hb.meme = ${meme} and hb.balance > 0
      and hb.holder <> ${ZERO_ADDRESS}
      and not exists (
        select 1 from holder_exclusions he
        where he.chain_id = hb.chain_id and he.meme = hb.meme
          and he.account = hb.holder and he.excluded = true
      )
  `;
  const liveCount = Number(live[0]?.n ?? 0);
  const cachedCount = Number(m.holder_count);
  const holders = await db<HolderRow[]>`
    select hb.holder, hb.balance
    from holder_balances hb
    where hb.chain_id = ${chainId} and hb.meme = ${meme} and hb.balance > 0
      and hb.holder <> ${ZERO_ADDRESS}
      and not exists (
        select 1 from holder_exclusions he
        where he.chain_id = hb.chain_id and he.meme = hb.meme
          and he.account = hb.holder and he.excluded = true
      )
    order by hb.balance desc
    limit ${limit}
  `;
  return { cachedCount, liveCount, circulating, holders };
}

export async function selectGrantCampaigns(db: Db, chainId: number, statuses?: number[]): Promise<GrantCampaignRow[]> {
  const list = statuses ?? [];
  return db<GrantCampaignRow[]>`
    select meme, pool_id, status, reserve, base_pool, referral_budget, root, root_uri,
           root_total_base, root_total_invitee_boost, root_proposed_at, activatable_at,
           start_time, end_time, total_activated, burned, excess_to_incentive, excess_to_treasury,
           incentive_swept, positions_count, active_positions, initialized_at, finalized_at, cancelled_at
    from grant_campaigns
    where chain_id = ${chainId}
      ${list.length ? db`and status in ${db(list)}` : db``}
    order by initialized_block desc, initialized_at desc
  `;
}

export async function selectGrantCampaign(db: Db, chainId: number, meme: string): Promise<GrantCampaignRow | null> {
  const rows = await db<GrantCampaignRow[]>`
    select meme, pool_id, status, reserve, base_pool, referral_budget, root, root_uri,
           root_total_base, root_total_invitee_boost, root_proposed_at, activatable_at,
           start_time, end_time, total_activated, burned, excess_to_incentive, excess_to_treasury,
           incentive_swept, positions_count, active_positions, initialized_at, finalized_at, cancelled_at
    from grant_campaigns
    where chain_id = ${chainId} and meme = ${meme}
  `;
  return rows[0] ?? null;
}

export async function selectGrantPositions(
  db: Db,
  chainId: number,
  meme: string,
  beneficiary?: string,
): Promise<GrantPositionRow[]> {
  return db<GrantPositionRow[]>`
    select position_id, meme, beneficiary, base_activated, invitee_boost_activated, inviter_credit_activated,
           quote_deposited, liquidity, activated_at, activated_block, activated_tx,
           fees_quote_paid, fees_meme_paid, incentive_paid, exited, exited_at, exited_tx,
           exit_quote_to_user, exit_meme_to_user, exit_excess_quote, exit_meme_burned
    from grant_positions
    where chain_id = ${chainId} and meme = ${meme}
      ${beneficiary ? db`and beneficiary = ${beneficiary}` : db``}
    order by activated_block desc, position_id desc
  `;
}

export async function selectPositionsForWallet(db: Db, chainId: number, beneficiary: string): Promise<GrantPositionRow[]> {
  return db<GrantPositionRow[]>`
    select position_id, meme, beneficiary, base_activated, invitee_boost_activated, inviter_credit_activated,
           quote_deposited, liquidity, activated_at, activated_block, activated_tx,
           fees_quote_paid, fees_meme_paid, incentive_paid, exited, exited_at, exited_tx,
           exit_quote_to_user, exit_meme_to_user, exit_excess_quote, exit_meme_burned
    from grant_positions
    where chain_id = ${chainId} and beneficiary = ${beneficiary}
    order by activated_block desc, position_id desc
  `;
}

export async function selectGrantAllocations(db: Db, chainId: number, meme: string): Promise<GrantAllocationRow[]> {
  return db<GrantAllocationRow[]>`
    select account, base_allocation, invitee_boost, registered_at
    from grant_allocations
    where chain_id = ${chainId} and meme = ${meme}
    order by base_allocation desc
  `;
}

export async function selectReferralCreditsTotal(db: Db, chainId: number, meme: string): Promise<string> {
  const rows = await db<{ s: string | bigint | null }[]>`
    select coalesce(sum(amount), 0) as s from referral_credits where chain_id = ${chainId} and meme = ${meme}
  `;
  return String(asBigInt(rows[0]?.s));
}

export async function selectWalletRoleBits(db: Db, chainId: number, address: string): Promise<{
  creatorOf: string[];
  lpOf: string[];
  allocatedIn: string[];
  inviter: string | null;
  optInBlock: number | string | bigint | null;
  inviteeCount: number;
  referralCreditsEarned: string;
  tradeCount: number;
}> {
  const created = await db<{ meme: string }[]>`
    select meme from launches where chain_id = ${chainId} and creator = ${address}
    order by created_block desc, created_log_index desc
  `;
  const lp = await db<{ meme: string }[]>`
    select distinct meme from grant_positions where chain_id = ${chainId} and beneficiary = ${address}
  `;
  const alloc = await db<{ meme: string }[]>`
    select meme from grant_allocations where chain_id = ${chainId} and account = ${address}
    order by registered_at desc
  `;
  const ref = await db<{ inviter: string }[]>`
    select inviter from referrals where chain_id = ${chainId} and invitee = ${address}
  `;
  const opt = await db<{ block: number | string | bigint }[]>`
    select block from opt_ins where chain_id = ${chainId} and account = ${address}
  `;
  const invitees = await db<{ n: number | bigint | string }[]>`
    select count(*)::int as n from referrals where chain_id = ${chainId} and inviter = ${address}
  `;
  const credits = await db<{ s: string | bigint | null }[]>`
    select coalesce(sum(amount), 0) as s from referral_credits where chain_id = ${chainId} and inviter = ${address}
  `;
  const tradeCount = await db<{ n: number | bigint | string }[]>`
    select count(*)::int as n from trades where chain_id = ${chainId} and wallet = ${address}
  `;
  return {
    creatorOf: created.map((r) => r.meme),
    lpOf: lp.map((r) => r.meme),
    allocatedIn: alloc.map((r) => r.meme),
    inviter: ref[0]?.inviter ?? null,
    optInBlock: opt[0]?.block ?? null,
    inviteeCount: Number(invitees[0]?.n ?? 0),
    referralCreditsEarned: String(asBigInt(credits[0]?.s)),
    tradeCount: Number(tradeCount[0]?.n ?? 0),
  };
}

export interface ClaimRow {
  meme: string;
  kind: string;
  amount: string | bigint;
  ts: number | string | bigint;
  tx_hash: string;
}

export async function selectWalletClaims(db: Db, chainId: number, account: string): Promise<ClaimRow[]> {
  return db<ClaimRow[]>`
    select meme, kind, amount, ts, tx_hash
    from reward_claims
    where chain_id = ${chainId} and account = ${account}
    order by block_number desc, log_index desc
  `;
}

export async function selectStats(db: Db, chainId: number, now: number): Promise<{
  launches: number;
  curveActive: number;
  graduated: number;
  activeGrants: number;
  quotes: number;
  trades24h: number;
  volume24hByQuote: Array<{ quote: string; symbol: string; volume: string | bigint }>;
}> {
  const cutoff = now - 86_400;
  const [launchCounts] = await db<{ launches: number | bigint; curve_active: number | bigint; graduated: number | bigint }[]>`
    select
      count(*)::int as launches,
      count(*) filter (where status = 1)::int as curve_active,
      count(*) filter (where status = 3)::int as graduated
    from launches
    where chain_id = ${chainId}
  `;
  const [grants] = await db<{ n: number | bigint }[]>`
    select count(*)::int as n from grant_campaigns
    where chain_id = ${chainId} and status in (2, 3)
  `;
  const [quotes] = await db<{ n: number | bigint }[]>`
    select count(*)::int as n from quote_assets where chain_id = ${chainId}
  `;
  const [trades] = await db<{ n: number | bigint }[]>`
    select count(*)::int as n from trades where chain_id = ${chainId} and ts >= ${cutoff}
  `;
  const volume = await db<{ quote: string; symbol: string; volume: string | bigint }[]>`
    select l.quote, coalesce(qa.symbol, '?') as symbol, coalesce(sum(t.quote_amount), 0) as volume
    from trades t
    join launches l on l.chain_id = t.chain_id and l.meme = t.meme
    left join quote_assets qa on qa.chain_id = l.chain_id and qa.quote = l.quote
    where t.chain_id = ${chainId} and t.ts >= ${cutoff}
    group by l.quote, qa.symbol
    order by volume desc
  `;
  return {
    launches: Number(launchCounts?.launches ?? 0),
    curveActive: Number(launchCounts?.curve_active ?? 0),
    graduated: Number(launchCounts?.graduated ?? 0),
    activeGrants: Number(grants?.n ?? 0),
    quotes: Number(quotes?.n ?? 0),
    trades24h: Number(trades?.n ?? 0),
    volume24hByQuote: volume,
  };
}

export interface HealthRow {
  cursor_block: number | string | bigint;
  head_block: number | string | bigint | null;
  start_block: number | string | bigint;
  updated_at: Date | string;
  last_error: string | null;
  last_error_at: Date | string | null;
  cursor_ts: number | string | bigint | null;
}

export async function selectHealth(db: Db, chainId: number): Promise<HealthRow | null> {
  const rows = await db<HealthRow[]>`
    select
      s.cursor_block,
      s.head_block,
      s.start_block,
      s.updated_at,
      s.last_error,
      s.last_error_at,
      b.ts as cursor_ts
    from sync_state s
    left join blocks b on b.chain_id = s.chain_id and b.number = s.cursor_block
    where s.chain_id = ${chainId}
  `;
  return rows[0] ?? null;
}
