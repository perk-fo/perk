import type { Address, Hex } from "viem";
import type { Db } from "../src/db/client";
import { resetDb, testConfig, TEST_DEPLOYMENT } from "./helpers";
import { createApp } from "../src/api/server";
import type { AppConfig } from "../src/config";

export { resetDb, testConfig, TEST_DEPLOYMENT };

export const CHAIN = 1952;

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const WOKB: Address = "0x00000000000000000000000000000000000000bb";
export const MEME_CURVE: Address = "0x0000000000000000000000000000000000000c01";
export const MEME_GRAD: Address = "0x0000000000000000000000000000000000000c02";
export const CREATOR_CURVE: Address = "0x0000000000000000000000000000000000000a01";
export const CREATOR_GRAD: Address = "0x0000000000000000000000000000000000000a02";
export const TRADER: Address = "0x0000000000000000000000000000000000000b01";
export const HOLDER_A: Address = "0x0000000000000000000000000000000000000b02";
export const HOLDER_B: Address = "0x0000000000000000000000000000000000000b03";
export const LP_1: Address = "0x0000000000000000000000000000000000000d01";
export const LP_2: Address = "0x0000000000000000000000000000000000000d02";
export const PLAIN: Address = "0x0000000000000000000000000000000000000e01";
export const EXCLUDED: Address = TEST_DEPLOYMENT.curve.toLowerCase() as Address;
export const INVITER: Address = "0x0000000000000000000000000000000000000f01";
export const INVITEE: Address = "0x0000000000000000000000000000000000000f02";
export const ROUTER: Address = "0x0000000000000000000000000000000000000ee1";
export const ADMIN: Address = TEST_DEPLOYMENT.protocolOwner.toLowerCase() as Address;

export const TOTAL_SUPPLY = 1_000_000n;
export const EXCLUDED_BAL = 200_000n;
export const ZERO_BAL = 100_000n;
export const HOLDER_A_BAL = 400_000n;
export const HOLDER_B_BAL = 250_000n;
export const LP_1_BAL = 50_000n;
export const CIRCULATING = TOTAL_SUPPLY - EXCLUDED_BAL - ZERO_BAL; // 700000

export const CURSOR_BLOCK = 1000;
export const HEAD_BLOCK = 1100;
export const START_BLOCK = 900;

export interface SeedMeta {
  now: number;
  cursorTs: number;
  candle: { t: number; o: number; h: number; l: number; c: number; v: string; n: number; from: number; to: number };
  gradNewQuoteVolume: bigint;
  change24hBps: number;
  marketCapQuote: string;
  gradTradeCount: number;
  curveTradeCount: number;
}

function h32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function tx(n: number): Hex {
  return h32(0x10000 + n);
}

export async function seed(db: Db): Promise<SeedMeta> {
  const now = Math.floor(Date.now() / 1000);
  const cursorTs = now - 3600;
  const candleBase = now - 108_000;
  const candleT = Math.floor(candleBase / 300) * 300;
  const oldTs = now - 172_800;
  const newTs = now - 600;

  await db`
    insert into sync_state (chain_id, cursor_block, cursor_hash, start_block, head_block, head_time, last_error)
    values (${CHAIN}, ${CURSOR_BLOCK}, ${h32(CURSOR_BLOCK)}, ${START_BLOCK}, ${HEAD_BLOCK}, ${now}, null)
  `;
  await db`
    insert into blocks (chain_id, number, hash, ts)
    values (${CHAIN}, ${CURSOR_BLOCK}, ${h32(CURSOR_BLOCK)}, ${cursorTs})
  `;
  // what the indexer records from the factory's OwnershipTransferred at deployment
  await db`
    insert into chain_role_events (chain_id, role, address, block_number, log_index)
    values (${CHAIN}, 'core', ${ADMIN}, ${START_BLOCK}, 0)
  `;

  await db`
    insert into quote_assets (chain_id, quote, symbol, name, decimals, kind, allowed)
    values
      (${CHAIN}, ${ZERO}, 'OKB', 'OKB', 18, 0, true),
      (${CHAIN}, ${WOKB}, 'WOKB', 'Wrapped OKB', 18, 1, true)
  `;

  await db`
    insert into launches (
      chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
      hook_version, module_bitmap, lp_grant_enabled, name, symbol, decimals, total_supply,
      status, pool_id, created_block, created_log_index, created_tx, created_at,
      virtual_quote_reserve, virtual_meme_reserve, curve_supply, pool_reserve_supply,
      graduation_quote_threshold, total_fee_bps, real_quote, meme_sold,
      curve_graduated, curve_finalized,
      last_price_quote, last_price_meme, last_price, last_trade_at,
      trade_count, volume_quote_total, holder_count
    ) values (
      ${CHAIN}, ${MEME_CURVE}, ${h32(1)}, ${CREATOR_CURVE}, ${ZERO}, 18, ${h32(11)}, ${h32(21)},
      1, ${"8"}, false, 'CurveCoin', 'CRV', 18, ${"500000"},
      1, null, 2000, 1, ${tx(1)}, ${now - 10_000},
      ${"10000"}, ${"1000000"}, ${"800000"}, ${"150000"},
      ${"1000"}, 100, ${"100"}, ${"50"},
      false, false,
      ${"10"}, ${"10"}, ${1.0}, ${newTs},
      7, ${"700"}, 99
    )
  `;

  await db`
    insert into launches (
      chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
      hook_version, module_bitmap, lp_grant_enabled, name, symbol, decimals, total_supply,
      status, pool_id, created_block, created_log_index, created_tx, created_at,
      virtual_quote_reserve, virtual_meme_reserve, curve_supply, pool_reserve_supply,
      graduation_quote_threshold, total_fee_bps, real_quote, meme_sold,
      curve_graduated, curve_finalized,
      graduated_block, graduated_at, meme_to_pool, quote_to_pool, pool_liquidity, meme_is_currency0,
      last_price_quote, last_price_meme, last_price, last_trade_at,
      trade_count, volume_quote_total, holder_count
    ) values (
      ${CHAIN}, ${MEME_GRAD}, ${h32(2)}, ${CREATOR_GRAD}, ${WOKB}, 18, ${h32(12)}, ${h32(22)},
      1, ${"8"}, true, 'GradCoin', 'GRD', 18, ${TOTAL_SUPPLY.toString()},
      3, ${h32(99)}, 1500, 2, ${tx(2)}, ${now - 20_000},
      ${"10000"}, ${"1000000"}, ${"800000"}, ${"150000"},
      ${"1000"}, 100, ${"1000"}, ${"800"},
      true, true,
      1700, ${now - 15_000}, ${"150000"}, ${"1000"}, ${"999"}, true,
      ${"200"}, ${"100"}, ${2.0}, ${newTs},
      23, ${"50000"}, 3
    )
  `;

  let n = 10;
  const insertTrade = async (row: {
    meme: Address;
    block: number;
    log: number;
    ts: number;
    side: "buy" | "sell";
    source: "curve" | "pool";
    wallet: Address;
    router: Address | null;
    quote: bigint;
    memeAmt: bigint;
    fee: bigint | null;
    pq: bigint;
    pm: bigint;
    price: number;
  }) => {
    n += 1;
    await db`
      insert into trades (
        chain_id, tx_hash, log_index, meme, block_number, ts, side, source, wallet, router,
        quote_amount, meme_amount, fee, price_quote, price_meme, price
      ) values (
        ${CHAIN}, ${tx(n)}, ${row.log}, ${row.meme}, ${row.block}, ${row.ts}, ${row.side}, ${row.source},
        ${row.wallet}, ${row.router}, ${row.quote.toString()}, ${row.memeAmt.toString()},
        ${row.fee === null ? null : row.fee.toString()}, ${row.pq.toString()}, ${row.pm.toString()}, ${row.price}
      )
    `;
  };

  for (let i = 0; i < 10; i++) {
    await insertTrade({
      meme: MEME_GRAD,
      block: 1600 + i,
      log: 0,
      ts: oldTs,
      side: i % 2 === 0 ? "buy" : "sell",
      source: "curve",
      wallet: TRADER,
      router: null,
      quote: 500n,
      memeAmt: 500n,
      fee: 5n,
      pq: 50n,
      pm: 50n,
      price: 1,
    });
  }

  const candlePrices = [1, 3, 2];
  const candleQuotes = [10n, 20n, 30n];
  for (let i = 0; i < 3; i++) {
    await insertTrade({
      meme: MEME_GRAD,
      block: 1800 + i,
      log: 0,
      ts: candleT + 10 * (i + 1),
      side: "buy",
      source: "pool",
      wallet: TRADER,
      router: ROUTER,
      quote: candleQuotes[i],
      memeAmt: 10n,
      fee: null,
      pq: BigInt(candlePrices[i] * 100),
      pm: 100n,
      price: candlePrices[i],
    });
  }

  for (let i = 0; i < 10; i++) {
    const first = i === 0;
    const last = i === 9;
    const pq = first ? 100n : last ? 200n : 150n;
    const price = first ? 1 : last ? 2 : 1.5;
    await insertTrade({
      meme: MEME_GRAD,
      block: 1900 + i,
      log: i,
      ts: newTs + i,
      side: "buy",
      source: "pool",
      wallet: TRADER,
      router: ROUTER,
      quote: 1000n,
      memeAmt: 100n,
      fee: null,
      pq,
      pm: 100n,
      price,
    });
  }

  for (let i = 0; i < 7; i++) {
    await insertTrade({
      meme: MEME_CURVE,
      block: 2000 + i,
      log: 0,
      ts: newTs,
      side: "buy",
      source: "curve",
      wallet: TRADER,
      router: null,
      quote: 100n,
      memeAmt: 100n,
      fee: 1n,
      pq: 10n,
      pm: 10n,
      price: 1,
    });
  }

  await db`
    insert into holder_exclusions (chain_id, meme, account, excluded)
    values (${CHAIN}, ${MEME_GRAD}, ${EXCLUDED}, true)
  `;
  await db`
    insert into holder_balances (chain_id, meme, holder, balance, updated_block)
    values
      (${CHAIN}, ${MEME_GRAD}, ${HOLDER_A}, ${HOLDER_A_BAL.toString()}, 1900),
      (${CHAIN}, ${MEME_GRAD}, ${HOLDER_B}, ${HOLDER_B_BAL.toString()}, 1900),
      (${CHAIN}, ${MEME_GRAD}, ${LP_1}, ${LP_1_BAL.toString()}, 1900),
      (${CHAIN}, ${MEME_GRAD}, ${EXCLUDED}, ${EXCLUDED_BAL.toString()}, 1900),
      (${CHAIN}, ${MEME_GRAD}, ${ZERO}, ${ZERO_BAL.toString()}, 1900),
      (${CHAIN}, ${MEME_CURVE}, ${HOLDER_A}, ${"1000"}, 2000)
  `;

  await db`
    insert into fee_events (
      chain_id, tx_hash, log_index, meme, source, amount, dev_share, rewards_share,
      lp_share, treasury_share, protocol_share, block_number, ts
    ) values (
      ${CHAIN}, ${tx(900)}, 0, ${MEME_GRAD}, 1,
      ${"10000"}, ${"4000"}, ${"3000"}, ${"1000"}, ${"1500"}, ${"500"}, 1700, ${now - 15_000}
    )
  `;
  await db`
    insert into reward_claims (chain_id, tx_hash, log_index, meme, account, kind, amount, block_number, ts)
    values
      (${CHAIN}, ${tx(901)}, 0, ${MEME_GRAD}, ${TRADER}, 'quote_rewards', ${"100"}, 1905, ${newTs}),
      (${CHAIN}, ${tx(902)}, 1, ${MEME_GRAD}, ${CREATOR_GRAD}, 'dev_fees', ${"50"}, 1906, ${newTs})
  `;

  await db`
    insert into grant_campaigns (
      chain_id, meme, pool_id, status, reserve, base_pool, referral_budget, root, root_uri,
      root_total_base, root_total_invitee_boost, root_proposed_at, activatable_at, start_time, end_time,
      total_activated, burned, quote_to_treasury,
      positions_count, active_positions, initialized_block, initialized_at
    ) values (
      ${CHAIN}, ${MEME_GRAD}, ${h32(99)}, 3, ${"150000"}, ${"120000"}, ${"30000"}, ${h32(77)}, 'ipfs://root',
      ${"100000"}, ${"20000"}, ${now - 14_000}, ${now - 13_000}, ${now - 12_000}, ${now + 86_400},
      ${"80000"}, ${"0"}, ${"4"},
      2, 1, 1710, ${now - 14_500}
    )
  `;

  await db`
    insert into grant_positions (
      chain_id, position_id, meme, beneficiary, base_activated, invitee_boost_activated, inviter_credit_activated,
      quote_deposited, liquidity, protocol_share_wad, activated_block, activated_at, activated_tx,
      fees_quote_paid, fees_meme_paid, exited
    ) values (
      ${CHAIN}, ${"1"}, ${MEME_GRAD}, ${LP_1}, ${"40000"}, ${"5000"}, ${"0"},
      ${"10"}, ${"1000"}, ${"500000000000000000"}, 1720, ${now - 11_000}, ${tx(910)},
      ${"3"}, ${"1"}, false
    )
  `;
  await db`
    insert into grant_positions (
      chain_id, position_id, meme, beneficiary, base_activated, invitee_boost_activated, inviter_credit_activated,
      quote_deposited, liquidity, protocol_share_wad, activated_block, activated_at, activated_tx,
      fees_quote_paid, fees_meme_paid,
      exited, exited_at, exited_tx, exit_quote_to_user, exit_meme_to_user, exit_quote_to_treasury, exit_meme_burned
    ) values (
      ${CHAIN}, ${"2"}, ${MEME_GRAD}, ${LP_2}, ${"30000"}, ${"0"}, ${"5000"},
      ${"8"}, ${"800"}, ${"499999999999999999"}, 1715, ${now - 12_000}, ${tx(911)},
      ${"1"}, ${"1"},
      true, ${now - 5000}, ${tx(912)}, ${"7"}, ${"2"}, ${"4"}, ${"100"}
    )
  `;

  await db`
    insert into grant_allocations (
      chain_id, meme, account, base_allocation, invitee_boost, invitee_boost_earned, registered_block, registered_at
    ) values
      (${CHAIN}, ${MEME_GRAD}, ${LP_1}, ${"40000"}, ${"5000"}, ${"4000"}, 1712, ${now - 13_500}),
      (${CHAIN}, ${MEME_GRAD}, ${INVITEE}, ${"10000"}, ${"2000"}, ${"0"}, 1713, ${now - 13_400})
  `;
  await db`
    insert into referral_credits (chain_id, tx_hash, log_index, meme, inviter, invitee, amount, block_number)
    values (${CHAIN}, ${tx(920)}, 0, ${MEME_GRAD}, ${INVITER}, ${INVITEE}, ${"5000"}, 1720)
  `;
  await db`
    insert into referrals (chain_id, invitee, inviter, bound_block)
    values (${CHAIN}, ${INVITEE}, ${INVITER}, 1005)
  `;
  await db`
    insert into opt_ins (chain_id, account, block)
    values (${CHAIN}, ${INVITEE}, 1006)
  `;

  return {
    now,
    cursorTs,
    candle: { t: candleT, o: 1, h: 3, l: 1, c: 2, v: "60", n: 3, from: candleT, to: candleT + 299 },
    gradNewQuoteVolume: 10_000n,
    change24hBps: 10_000,
    marketCapQuote: ((200n * TOTAL_SUPPLY) / 100n).toString(),
    gradTradeCount: 23,
    curveTradeCount: 7,
  };
}

export function makeTestApp(db: Db, overrides: Partial<AppConfig> = {}) {
  const config = testConfig(overrides);
  return { app: createApp({ db, config }), config };
}
