import type { Hex } from "viem";
import type { Db, Tx } from "../db/client";
import type { Client } from "../chain/rpc";
import { getHeader } from "../chain/rpc";
import { NATIVE_QUOTE } from "./apply";

/**
 * Reorg detection: the stored hash of the cursor block must still be the chain's hash for that number.
 * Returns the highest block ≤ cursor whose stored hash matches the chain (walking back through `blocks`),
 * or null when the cursor is intact. X Layer is a zk-rollup with a single sequencer, so this is defensive;
 * CONFIRMATIONS already keeps the indexer off the very tip.
 */
export async function findReorgPoint(
  db: Db,
  client: Client,
  chainId: number,
  cursorBlock: bigint,
  cursorHash: string | null,
): Promise<bigint | null> {
  if (!cursorHash) return null;
  const current = await getHeader(client, cursorBlock);
  if (current.hash.toLowerCase() === cursorHash.toLowerCase()) return null;

  const rows = await db<{ number: string; hash: string }[]>`
    select number, hash from blocks
    where chain_id = ${chainId} and number < ${cursorBlock}
    order by number desc
    limit ${Number(REORG_MAX_DEPTH)}`;

  for (const row of rows) {
    const n = BigInt(row.number);
    if (cursorBlock - n > REORG_MAX_DEPTH) {
      throw new Error(`reorg deeper than ${REORG_MAX_DEPTH} blocks`);
    }
    const header = await getHeader(client, n);
    if (header.hash.toLowerCase() === row.hash.toLowerCase()) return n;
  }
  throw new Error(`reorg deeper than ${REORG_MAX_DEPTH} blocks`);
}

/**
 * Roll every table back to `block` (inclusive of that block's state) inside one transaction, then set the
 * cursor to `block`. Strategy:
 *  - delete rows with block_number > block from: trades, token_transfers, fee_events, reward_claims,
 *    referral_credits, applied_logs, blocks, chain_role_events;
 *  - launches created after `block` are deleted; surviving launches get their fold columns recomputed from
 *    trades/token_transfers ≤ block (real_quote, meme_sold, market cache, holder_count);
 *  - holder_balances recomputed from token_transfers for affected memes;
 *  - grant_* / referrals / opt_ins / templates / quote_assets are rebuilt by replaying applied logs is NOT
 *    possible (raw logs are not stored), so instead their rows touched after `block` are deleted and the
 *    indexer re-scans from `block + 1`; positions/allocations/credits carry a block column for that purpose,
 *    grant_campaigns uses initialized_block plus a full re-scan of the vault's logs since graduation.
 * Reorgs deeper than REORG_MAX_DEPTH (default 200) throw and require an operator to reset.
 */
export async function rollbackTo(tx: Tx, chainId: number, block: bigint, newCursorHash: Hex): Promise<void> {
  await tx`delete from trades where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from token_transfers where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from fee_events where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from reward_claims where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from referral_credits where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from applied_logs where chain_id = ${chainId} and block_number > ${block}`;
  await tx`delete from blocks where chain_id = ${chainId} and number > ${block}`;
  await tx`delete from chain_role_events where chain_id = ${chainId} and block_number > ${block}`;

  await tx`delete from grant_positions where chain_id = ${chainId} and activated_block > ${block}`;
  await tx`delete from grant_allocations where chain_id = ${chainId} and registered_block > ${block}`;
  await tx`delete from grant_campaigns where chain_id = ${chainId} and initialized_block > ${block}`;

  await tx`delete from launches where chain_id = ${chainId} and created_block > ${block}`;

  await tx`delete from holder_balances where chain_id = ${chainId}`;
  await tx`
    insert into holder_balances (chain_id, meme, holder, balance, updated_block)
    select ${chainId}, meme, holder, sum(delta), max(blk)
    from (
      select meme, to_addr as holder, value as delta, block_number as blk
      from token_transfers
      where chain_id = ${chainId} and to_addr <> ${NATIVE_QUOTE}
      union all
      select meme, from_addr as holder, -value as delta, block_number as blk
      from token_transfers
      where chain_id = ${chainId} and from_addr <> ${NATIVE_QUOTE}
    ) s
    group by meme, holder
    having sum(delta) <> 0`;

  await tx`
    update launches l set
      real_quote = coalesce((
        select sum(case
          when source = 'curve' and side = 'buy' then price_quote
          when source = 'curve' and side = 'sell' then -quote_amount
          else 0 end)
        from trades t where t.chain_id = l.chain_id and t.meme = l.meme
      ), 0),
      meme_sold = coalesce((
        select sum(case
          when source = 'curve' and side = 'buy' then meme_amount
          when source = 'curve' and side = 'sell' then -meme_amount
          else 0 end)
        from trades t where t.chain_id = l.chain_id and t.meme = l.meme
      ), 0),
      trade_count = coalesce((
        select count(*)::int from trades t where t.chain_id = l.chain_id and t.meme = l.meme
      ), 0),
      volume_quote_total = coalesce((
        select sum(quote_amount) from trades t where t.chain_id = l.chain_id and t.meme = l.meme
      ), 0),
      last_price_quote = (
        select price_quote from trades t
        where t.chain_id = l.chain_id and t.meme = l.meme
        order by block_number desc, log_index desc limit 1
      ),
      last_price_meme = (
        select price_meme from trades t
        where t.chain_id = l.chain_id and t.meme = l.meme
        order by block_number desc, log_index desc limit 1
      ),
      last_price = (
        select price from trades t
        where t.chain_id = l.chain_id and t.meme = l.meme
        order by block_number desc, log_index desc limit 1
      ),
      last_trade_at = (
        select ts from trades t
        where t.chain_id = l.chain_id and t.meme = l.meme
        order by block_number desc, log_index desc limit 1
      ),
      holder_count = coalesce((
        select count(*)::int from holder_balances hb
        left join holder_exclusions he
          on he.chain_id = hb.chain_id and he.meme = hb.meme and he.account = hb.holder and he.excluded
        where hb.chain_id = l.chain_id and hb.meme = l.meme and hb.balance > 0
          and coalesce(he.excluded, false) = false
      ), 0),
      updated_at = now()
    where l.chain_id = ${chainId}`;

  await tx`
    update grant_campaigns c set
      total_activated = coalesce((
        select sum(base_activated + invitee_boost_activated + inviter_credit_activated)
        from grant_positions p
        where p.chain_id = c.chain_id and p.meme = c.meme
      ), 0),
      positions_count = coalesce((
        select count(*)::int from grant_positions p
        where p.chain_id = c.chain_id and p.meme = c.meme
      ), 0),
      active_positions = coalesce((
        select count(*)::int from grant_positions p
        where p.chain_id = c.chain_id and p.meme = c.meme and not p.exited
      ), 0),
      updated_at = now()
    where c.chain_id = ${chainId}`;

  await tx`update sync_state set
      cursor_block = ${block},
      cursor_hash = ${newCursorHash.toLowerCase()},
      updated_at = now()
    where chain_id = ${chainId}`;
}

export const REORG_MAX_DEPTH = 200n;
