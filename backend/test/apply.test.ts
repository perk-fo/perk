import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import type { Address, Hex } from "viem";
import {
  decodePerkLog,
  decodeSwapLog,
  decodeTransferLog,
  perkContracts,
  type DecodedLog,
  type PerkContract,
  type RawLog,
} from "../src/chain/events";
import { applyLog, NATIVE_QUOTE, type ApplyContext } from "../src/sync/apply";
import { TrackedSet } from "../src/sync/tracked";
import { migrate } from "../src/db/migrate";
import type { Db, Tx } from "../src/db/client";
import {
  ABI_BY_CONTRACT,
  TEST_DEPLOYMENT as D,
  blockHash,
  chainHandler,
  emptyChain,
  makeLog,
  makeSwapLog,
  makeTransferLog,
  mockClient,
  resetDb,
  type MockChain,
  type MockLog,
} from "./helpers";

const CHAIN = 1952;
const MEME = "0x0000000000000000000000000000000000001111" as Address;
const MEME2 = "0x0000000000000000000000000000000000001112" as Address;
const CREATOR = "0x0000000000000000000000000000000000002222" as Address;
const BUYER = "0x0000000000000000000000000000000000003333" as Address;
const SELLER = "0x0000000000000000000000000000000000004444" as Address;
const ROUTER = "0x0000000000000000000000000000000000005555" as Address;
const WALLET = "0x0000000000000000000000000000000000006666" as Address;
const EXCLUDED = "0x0000000000000000000000000000000000007777" as Address;
const HI_QUOTE = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
const LAUNCH_ID = (`0x${"11".repeat(32)}`) as Hex;
const LAUNCH_ID2 = (`0x${"12".repeat(32)}`) as Hex;
const TEMPLATE_ID = (`0x${"22".repeat(32)}`) as Hex;
const CONFIG_HASH = (`0x${"33".repeat(32)}`) as Hex;
const POOL_ID = (`0x${"44".repeat(32)}`) as Hex;
const POOL_ID2 = (`0x${"45".repeat(32)}`) as Hex;
const ROOT = (`0x${"66".repeat(32)}`) as Hex;
const ZERO = NATIVE_QUOTE as Address;

let db: Db;
let chain: MockChain;
let ctx: ApplyContext;

function perkMap() {
  const m = new Map<string, { name: PerkContract; abi: readonly unknown[] }>();
  for (const c of perkContracts(D)) m.set(c.address.toLowerCase(), { name: c.name, abi: c.abi });
  return m;
}

function asRaw(log: MockLog): RawLog {
  return {
    address: log.address,
    blockNumber: log.blockNumber,
    blockHash: blockHash(log.blockNumber),
    transactionHash: log.transactionHash,
    logIndex: log.logIndex,
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  };
}

function decodeMade(log: MockLog): DecodedLog {
  const raw = asRaw(log);
  if (log.address.toLowerCase() === D.poolManager.toLowerCase()) {
    const d = decodeSwapLog(raw);
    if (!d) throw new Error("swap decode failed");
    return d;
  }
  const perk = decodePerkLog(raw, perkMap());
  if (perk) return perk;
  const t = decodeTransferLog(raw);
  if (t) return t;
  throw new Error(`decode failed for ${log.topics[0]}`);
}

async function apply(log: MockLog): Promise<void> {
  ctx.blockTime.set(log.blockNumber, 1_700_000_000n + log.blockNumber);
  const decoded = decodeMade(log);
  await db.begin(async (tx) => {
    await applyLog(tx as unknown as Tx, ctx, decoded);
  });
}

function factoryLog(eventName: string, args: Record<string, unknown>, block: bigint, idx = 0): MockLog {
  return makeLog({ address: D.factory, abi: ABI_BY_CONTRACT.factory, eventName, args, blockNumber: block, logIndex: idx });
}
function curveLog(eventName: string, args: Record<string, unknown>, block: bigint, idx = 0): MockLog {
  return makeLog({ address: D.curve, abi: ABI_BY_CONTRACT.curve, eventName, args, blockNumber: block, logIndex: idx });
}
function vaultLog(eventName: string, args: Record<string, unknown>, block: bigint, idx = 0): MockLog {
  return makeLog({
    address: D.lpGrantVault,
    abi: ABI_BY_CONTRACT.lpGrantVault,
    eventName,
    args,
    blockNumber: block,
    logIndex: idx,
  });
}

async function seedLaunch(opts?: {
  meme?: Address;
  launchId?: Hex;
  quote?: Address;
  template?: boolean;
  logIndex?: number;
  block?: bigint;
}): Promise<void> {
  const meme = opts?.meme ?? MEME;
  const launchId = opts?.launchId ?? LAUNCH_ID;
  const quote = opts?.quote ?? ZERO;
  chain.erc20.set(meme.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n });
  if (quote !== ZERO) {
    chain.erc20.set(quote.toLowerCase(), { name: "USD", symbol: "USD", decimals: 18, totalSupply: 0n });
  }
  if (opts?.template !== false) {
    await db`insert into templates (chain_id, template_id, status, template)
      values (${CHAIN}, ${TEMPLATE_ID}, 2, ${db.json({ moduleBitmap: (8n).toString() })})
      on conflict do nothing`;
  }
  await apply(
    factoryLog(
      "LaunchCreated",
      {
        launchId,
        meme,
        creator: CREATOR,
        quote,
        templateId: TEMPLATE_ID,
        configHash: CONFIG_HASH,
      },
      opts?.block ?? 1000n,
      opts?.logIndex ?? 0,
    ),
  );
}

async function launchRow(meme = MEME) {
  const rows = await db<Record<string, unknown>[]>`
    select * from launches where chain_id = ${CHAIN} and meme = ${meme.toLowerCase()}`;
  return rows[0];
}

describe("apply", () => {
  beforeAll(async () => {
    db = await resetDb();
  });
  beforeEach(async () => {
    await db.unsafe("drop schema public cascade; create schema public;");
    await migrate(db);
    chain = emptyChain(2000n);
    chain.erc20.set(MEME.toLowerCase(), {
      name: "Meme",
      symbol: "MEME",
      decimals: 18,
      totalSupply: 1_000_000n,
      tokenURI: "ipfs://QmLaunchMeta",
    });
    chain.erc20.set(MEME2.toLowerCase(), { name: "Meme2", symbol: "MEM2", decimals: 18, totalSupply: 1_000_000n });
    ctx = {
      chainId: CHAIN,
      deployment: D,
      client: mockClient(chainHandler(chain)),
      tracked: new TrackedSet(),
      blockTime: new Map(),
      txOrigin: new Map(),
      quoteDecimals: new Map(),
    };
  });
  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  describe("factory", () => {
    test("launch created + template selected sets lp_grant_enabled from bit 3", async () => {
      await db`insert into templates (chain_id, template_id, status, template)
        values (${CHAIN}, ${TEMPLATE_ID}, 2, ${db.json({ moduleBitmap: (8n).toString() })})`;
      await apply(
        factoryLog(
          "LaunchCreated",
          {
            launchId: LAUNCH_ID,
            meme: MEME,
            creator: CREATOR,
            quote: ZERO,
            templateId: TEMPLATE_ID,
            configHash: CONFIG_HASH,
          },
          1000n,
        ),
      );
      let row = await launchRow();
      expect(row.lp_grant_enabled).toBe(true);
      expect(row.status).toBe(1);
      expect(row.name).toBe("Meme");
      expect(row.symbol).toBe("MEME");
      expect(row.metadata_status).toBe("pending");
      expect(row.token_uri).toBe("ipfs://QmLaunchMeta");
      expect(ctx.tracked.memes.has(MEME)).toBe(true);

      await apply(
        factoryLog(
          "LaunchTemplateSelected",
          {
            launchId: LAUNCH_ID,
            templateId: TEMPLATE_ID,
            hookVersion: 1,
            moduleBitmap: 0n,
            moduleParamsHash: CONFIG_HASH,
          },
          1000n,
          1,
        ),
      );
      row = await launchRow();
      expect(row.lp_grant_enabled).toBe(false);
      expect(row.hook_version).toBe(1);

      await apply(
        factoryLog(
          "LaunchTemplateSelected",
          {
            launchId: LAUNCH_ID,
            templateId: TEMPLATE_ID,
            hookVersion: 1,
            moduleBitmap: 8n,
            moduleParamsHash: CONFIG_HASH,
          },
          1000n,
          2,
        ),
      );
      row = await launchRow();
      expect(row.lp_grant_enabled).toBe(true);
    });
  });

  describe("curve", () => {
    test("buy/sell fold real_quote/meme_sold and market cache; sell after buy reduces real_quote", async () => {
      await seedLaunch();
      await apply(
        curveLog(
          "CurveBuy",
          {
            meme: MEME,
            buyer: BUYER,
            recipient: BUYER,
            quoteGross: 100n,
            fee: 1n,
            quoteNet: 99n,
            memeOut: 1000n,
          },
          1001n,
        ),
      );
      let row = await launchRow();
      expect(BigInt(row.real_quote as string)).toBe(99n);
      expect(BigInt(row.meme_sold as string)).toBe(1000n);
      expect(BigInt(row.last_price_quote as string)).toBe(99n);
      expect(BigInt(row.last_price_meme as string)).toBe(1000n);
      expect(row.trade_count).toBe(1);
      expect(BigInt(row.volume_quote_total as string)).toBe(100n);
      expect(row.last_price).toBeCloseTo(0.099);

      await apply(
        curveLog(
          "CurveSell",
          {
            meme: MEME,
            seller: SELLER,
            recipient: SELLER,
            memeIn: 400n,
            quoteGross: 30n,
            fee: 1n,
            quoteNet: 29n,
          },
          1002n,
        ),
      );
      row = await launchRow();
      expect(BigInt(row.real_quote as string)).toBe(69n);
      expect(BigInt(row.meme_sold as string)).toBe(600n);
      expect(row.trade_count).toBe(2);
      expect(BigInt(row.volume_quote_total as string)).toBe(130n);
      expect(BigInt(row.last_price_quote as string)).toBe(30n);

      const trades = await db<{ side: string; quote_amount: string }[]>`
        select side, quote_amount from trades where chain_id = ${CHAIN} order by block_number`;
      expect(trades.map((t) => t.side)).toEqual(["buy", "sell"]);
    });

    test("CurveBuy with memeOut 0 is skipped", async () => {
      await seedLaunch();
      await apply(
        curveLog(
          "CurveBuy",
          {
            meme: MEME,
            buyer: BUYER,
            recipient: BUYER,
            quoteGross: 10n,
            fee: 0n,
            quoteNet: 10n,
            memeOut: 0n,
          },
          1001n,
        ),
      );
      const row = await launchRow();
      expect(row.trade_count).toBe(0);
      expect(BigInt(row.real_quote as string)).toBe(0n);
    });
  });

  describe("pool swaps", () => {
    async function graduate(meme: Address, launchId: Hex, quote: Address, poolId: Hex, idx = 0): Promise<void> {
      await seedLaunch({ meme, launchId, quote, logIndex: idx, block: 1000n + BigInt(idx) });
      await apply(
        makeLog({
          address: D.graduationManager,
          abi: ABI_BY_CONTRACT.graduationManager,
          eventName: "LaunchGraduated",
          args: {
            meme,
            launchId,
            poolId,
            memeToPool: 1n,
            quoteToPool: 1n,
            liquidity: 1n,
          },
          blockNumber: 1010n + BigInt(idx),
          logIndex: idx,
        }),
      );
    }

    test("pool swap side detection for both meme_is_currency0 values, wallet = tx.from, router set", async () => {
      await graduate(MEME, LAUNCH_ID, HI_QUOTE, POOL_ID);
      let row = await launchRow(MEME);
      expect(row.meme_is_currency0).toBe(true);

      const tx1 = (`0x${"aa".repeat(32)}`) as Hex;
      ctx.txOrigin.set(tx1, WALLET);
      await apply(
        makeSwapLog({
          poolManager: D.poolManager,
          id: POOL_ID,
          sender: ROUTER,
          amount0: 1000n,
          amount1: -50n,
          blockNumber: 1011n,
          transactionHash: tx1,
        }),
      );
      const buyTrade = await db<{ side: string; wallet: string; router: string | null; source: string }[]>`
        select side, wallet, router, source from trades where meme = ${MEME} order by log_index`;
      expect(buyTrade[0].side).toBe("buy");
      expect(buyTrade[0].wallet).toBe(WALLET);
      expect(buyTrade[0].router).toBe(ROUTER);
      expect(buyTrade[0].source).toBe("pool");

      await graduate(MEME2, LAUNCH_ID2, ZERO, POOL_ID2, 1);
      row = await launchRow(MEME2);
      expect(row.meme_is_currency0).toBe(false);

      const tx2 = (`0x${"bb".repeat(32)}`) as Hex;
      ctx.txOrigin.set(tx2, WALLET);
      await apply(
        makeSwapLog({
          poolManager: D.poolManager,
          id: POOL_ID2,
          sender: WALLET,
          amount0: -50n,
          amount1: 1000n,
          blockNumber: 1012n,
          transactionHash: tx2,
        }),
      );
      const buy2 = await db<{ side: string; wallet: string; router: string | null }[]>`
        select side, wallet, router from trades where meme = ${MEME2.toLowerCase()}`;
      expect(buy2[0].side).toBe("buy");
      expect(buy2[0].wallet).toBe(WALLET);
      expect(buy2[0].router).toBeNull();

      await apply(
        makeSwapLog({
          poolManager: D.poolManager,
          id: POOL_ID2,
          sender: ROUTER,
          amount0: 50n,
          amount1: -1000n,
          blockNumber: 1013n,
          logIndex: 1,
          transactionHash: (`0x${"cc".repeat(32)}`) as Hex,
        }),
      );
      const sell2 = await db<{ side: string }[]>`
        select side from trades where meme = ${MEME2.toLowerCase()} order by block_number, log_index`;
      expect(sell2[1].side).toBe("sell");
    });
  });

  describe("meme token transfers", () => {
    test("transfer mint/burn/transfer and holder_count increments/decrements, excluded account never counted", async () => {
      await seedLaunch();

      await apply(
        makeTransferLog({
          token: MEME,
          from: ZERO,
          to: BUYER,
          value: 100n,
          blockNumber: 1020n,
        }),
      );
      let row = await launchRow();
      expect(row.holder_count).toBe(1);
      let bals = await db<{ holder: string; balance: string }[]>`
        select holder, balance from holder_balances where meme = ${MEME} order by holder`;
      expect(bals).toHaveLength(1);
      expect(bals[0].holder).toBe(BUYER);
      expect(BigInt(bals[0].balance)).toBe(100n);

      await apply(
        makeTransferLog({
          token: MEME,
          from: BUYER,
          to: SELLER,
          value: 40n,
          blockNumber: 1021n,
        }),
      );
      row = await launchRow();
      expect(row.holder_count).toBe(2);

      await apply(
        makeTransferLog({
          token: MEME,
          from: BUYER,
          to: ZERO,
          value: 60n,
          blockNumber: 1022n,
        }),
      );
      row = await launchRow();
      expect(row.holder_count).toBe(1);
      const afterBurn = await db<{ holder: string }[]>`select holder from holder_balances where meme = ${MEME}`;
      expect(afterBurn.map((b) => b.holder)).toEqual([SELLER]);

      await apply(
        makeLog({
          address: D.distributor,
          abi: ABI_BY_CONTRACT.distributor,
          eventName: "RewardEligibilityUpdated",
          args: { meme: MEME, account: EXCLUDED, excluded: true },
          blockNumber: 1023n,
        }),
      );
      await apply(
        makeTransferLog({
          token: MEME,
          from: ZERO,
          to: EXCLUDED,
          value: 999n,
          blockNumber: 1024n,
        }),
      );
      row = await launchRow();
      expect(row.holder_count).toBe(1);
      const afterExcl = await db<{ holder: string }[]>`select holder from holder_balances where meme = ${MEME} order by holder`;
      expect(afterExcl).toHaveLength(2);
    });
  });

  describe("LP grant vault", () => {
    test("grant lifecycle init → root proposed → published → activated ×2 → fees → exit → excess routed → finalized", async () => {
      await seedLaunch();
      await apply(
        vaultLog(
          "CampaignInitialized",
          { meme: MEME, poolId: POOL_ID, reserve: 1000n, basePool: 800n, referralBudget: 200n },
          1100n,
        ),
      );
      let c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(1);

      await apply(
        vaultLog(
          "GrantRootProposed",
          {
            meme: MEME,
            root: ROOT,
            uri: "ipfs://x",
            totalBase: 800n,
            totalInviteeBoost: 80n,
            activatableAt: 1_800_000_000n,
          },
          1101n,
        ),
      );
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(2);
      expect(c.root).toBe(ROOT);

      await apply(
        vaultLog(
          "GrantRootPublished",
          { meme: MEME, root: ROOT, startTime: 1_800_000_000n, endTime: 1_900_000_000n },
          1102n,
        ),
      );
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(3);

      await apply(
        vaultLog(
          "GrantActivated",
          {
            positionId: 1n,
            meme: MEME,
            beneficiary: BUYER,
            baseActivated: 10n,
            inviteeBoostActivated: 1n,
            inviterCreditActivated: 2n,
            quoteDeposited: 5n,
            liquidity: 100n,
          },
          1103n,
        ),
      );
      await apply(
        vaultLog(
          "GrantActivated",
          {
            positionId: 2n,
            meme: MEME,
            beneficiary: SELLER,
            baseActivated: 20n,
            inviteeBoostActivated: 0n,
            inviterCreditActivated: 0n,
            quoteDeposited: 8n,
            liquidity: 200n,
          },
          1104n,
        ),
      );
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.positions_count).toBe(2);
      expect(c.active_positions).toBe(2);
      expect(BigInt(c.total_activated as string)).toBe(33n);

      await apply(
        vaultLog(
          "GrantFeesCollected",
          { positionId: 1n, quoteFeesPaid: 3n, memeFeesPaid: 4n, incentivePaid: 1n },
          1105n,
        ),
      );
      const pos = (
        await db<Record<string, unknown>[]>`select * from grant_positions where position_id = ${1n}`
      )[0];
      expect(BigInt(pos.fees_quote_paid as string)).toBe(3n);
      expect(BigInt(pos.incentive_paid as string)).toBe(1n);

      await apply(
        vaultLog(
          "GrantPositionExited",
          { positionId: 1n, quoteToUser: 4n, memeToUser: 3n, excessQuote: 1n, memeBurned: 2n, incentivePaid: 7n },
          1106n,
        ),
      );
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.active_positions).toBe(1);
      const exited = (
        await db<Record<string, unknown>[]>`select * from grant_positions where position_id = ${1n}`
      )[0];
      expect(exited.exited).toBe(true);
      expect(BigInt(exited.incentive_paid as string)).toBe(8n);
      expect(BigInt(exited.exit_quote_to_user as string)).toBe(4n);
      expect(BigInt(exited.exit_meme_to_user as string)).toBe(3n);
      expect(BigInt(exited.fees_meme_paid as string)).toBe(4n);

      await apply(
        vaultLog("ExcessQuoteRouted", { meme: MEME, toIncentivePool: 11n, toTreasury: 9n }, 1107n),
      );
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(BigInt(c.excess_to_incentive as string)).toBe(11n);
      expect(BigInt(c.excess_to_treasury as string)).toBe(9n);

      await apply(vaultLog("GrantMemeBurned", { meme: MEME, amount: 50n, reason: ROOT }, 1108n));
      await apply(vaultLog("GrantFinalized", { meme: MEME, unactivatedMemeBurned: 50n }, 1109n));
      c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(4);
      expect(BigInt(c.burned as string)).toBe(50n);
      expect(c.finalized_at).not.toBeNull();
    });

    test("root cancelled resets to AWAITING_ROOT", async () => {
      await seedLaunch();
      await apply(
        vaultLog(
          "CampaignInitialized",
          { meme: MEME, poolId: POOL_ID, reserve: 1n, basePool: 1n, referralBudget: 0n },
          1100n,
        ),
      );
      await apply(
        vaultLog(
          "GrantRootProposed",
          {
            meme: MEME,
            root: ROOT,
            uri: "ipfs://x",
            totalBase: 1n,
            totalInviteeBoost: 0n,
            activatableAt: 1n,
          },
          1101n,
        ),
      );
      await apply(vaultLog("GrantRootCancelled", { meme: MEME, root: ROOT }, 1102n));
      const c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(1);
      expect(c.root).toBeNull();
    });

    test("campaign cancelled", async () => {
      await seedLaunch();
      await apply(
        vaultLog(
          "CampaignInitialized",
          { meme: MEME, poolId: POOL_ID, reserve: 10n, basePool: 8n, referralBudget: 2n },
          1100n,
        ),
      );
      await apply(vaultLog("CampaignCancelled", { meme: MEME, memeBurned: 10n }, 1101n));
      const c = (await db<Record<string, unknown>[]>`select * from grant_campaigns where meme = ${MEME}`)[0];
      expect(c.status).toBe(5);
      expect(BigInt(c.burned as string)).toBe(10n);
      expect(c.cancelled_at).not.toBeNull();
    });
  });

  describe("ordinary LP positions", () => {
    test("mint records the position, transfer moves it, burn closes it, vault mints are skipped", async () => {
      const ALICE = "0x00000000000000000000000000000000000000a5" as Address;
      const BOB = "0x00000000000000000000000000000000000000b5" as Address;
      const pmLog = (args: Record<string, unknown>, block: bigint): MockLog =>
        makeLog({
          address: D.positionManager,
          abi: ABI_BY_CONTRACT.positionManager,
          eventName: "Transfer",
          args,
          blockNumber: block,
          logIndex: 0,
        });

      // mint to alice: no matching launch pool, so meme stays null but the position is still tracked
      await apply(pmLog({ from: ZERO, to: ALICE, id: 7n }, 1200n));
      let row = (await db<Record<string, unknown>[]>`select * from lp_positions where token_id = 7`)[0];
      expect(row).toBeDefined();
      expect(row.owner).toBe(ALICE.toLowerCase());
      expect(row.closed).toBe(false);

      // the vault's own grant positions must never appear here
      await apply(pmLog({ from: ZERO, to: D.lpGrantVault, id: 8n }, 1201n));
      expect(await db`select 1 from lp_positions where token_id = 8`).toHaveLength(0);

      // transfer reassigns the owner
      await apply(pmLog({ from: ALICE, to: BOB, id: 7n }, 1202n));
      row = (await db<Record<string, unknown>[]>`select * from lp_positions where token_id = 7`)[0];
      expect(row.owner).toBe(BOB.toLowerCase());
      expect(row.closed).toBe(false);

      // burn closes it
      await apply(pmLog({ from: BOB, to: ZERO, id: 7n }, 1203n));
      row = (await db<Record<string, unknown>[]>`select * from lp_positions where token_id = 7`)[0];
      expect(row.closed).toBe(true);
    });
  });
});
