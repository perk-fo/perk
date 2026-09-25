/**
 * The indexer keeps going, and keeps the index right, when the chain or its RPC misbehave: strings Postgres cannot
 * hold, a log that cannot be applied, RPC failures, reorgs, a chain that changes while a window is read, and a
 * second indexer on the same database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPublicClient, custom, HttpRequestError, type Address, type Hex } from "viem";
import type { Db } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { Indexer, QUARANTINE_AFTER_FAILURES } from "../src/sync/indexer";
import { acquireIndexerLock, type IndexerLock } from "../src/sync/lock";
import { readSyncState } from "../src/sync/state";
import { NATIVE_QUOTE } from "../src/sync/apply";
import { createApp } from "../src/api/server";
import type { Health } from "../src/api/types";
import {
  ABI_BY_CONTRACT,
  TEST_DATABASE_URL,
  TEST_DEPLOYMENT as D,
  blockHash,
  chainHandler,
  emptyChain,
  makeLog,
  mockClient,
  resetDb,
  testConfig,
  type MockChain,
  type RpcHandler,
} from "./helpers";

const CHAIN = 1952;
const MEME = "0x0000000000000000000000000000000000001111" as Address;
const MEME2 = "0x0000000000000000000000000000000000001112" as Address;
const CREATOR = "0x0000000000000000000000000000000000002222" as Address;
const BUYER = "0x0000000000000000000000000000000000003333" as Address;
const TEMPLATE_ID = `0x${"22".repeat(32)}` as Hex;
const CONFIG_HASH = `0x${"33".repeat(32)}` as Hex;
const ZERO = NATIVE_QUOTE as Address;

let db: Db;

function launchLog(meme: Address, block: bigint, launchId: Hex = `0x${"11".repeat(32)}`, logIndex = 0) {
  return makeLog({
    address: D.factory,
    abi: ABI_BY_CONTRACT.factory,
    eventName: "LaunchCreated",
    args: { launchId, meme, creator: CREATOR, quote: ZERO, templateId: TEMPLATE_ID, configHash: CONFIG_HASH },
    blockNumber: block,
    logIndex,
  });
}

function buyLog(block: bigint, quoteNet: bigint, logIndex = 0) {
  return makeLog({
    address: D.curve,
    abi: ABI_BY_CONTRACT.curve,
    eventName: "CurveBuy",
    args: { meme: MEME, buyer: BUYER, recipient: BUYER, quoteGross: quoteNet + 1n, fee: 1n, quoteNet, memeOut: 1000n },
    blockNumber: block,
    logIndex,
  });
}

function withMeme(chain: MockChain, meme: Address = MEME, extra: Partial<{ name: string; symbol: string; tokenURI: string }> = {}) {
  chain.erc20.set(meme.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n, ...extra });
}

function indexerOn(handler: RpcHandler, overrides: Parameters<typeof testConfig>[0] = {}) {
  return new Indexer({ db, client: mockClient(handler), config: testConfig({ confirmations: 0, ...overrides }) });
}

async function cursor(): Promise<bigint | undefined> {
  return (await readSyncState(db, CHAIN))?.cursorBlock;
}

/** Make Postgres refuse to store one particular trade, with the given SQLSTATE. */
async function refuseTrade(tx: Hex, sqlstate: string) {
  await db.unsafe(`
    create or replace function refuse_one_trade() returns trigger language plpgsql as $$
    begin
      if new.tx_hash = '${tx.toLowerCase()}' then raise exception 'refused by test' using errcode = '${sqlstate}'; end if;
      return new;
    end $$;
    create trigger refuse_one_trade before insert on trades for each row execute function refuse_one_trade();`);
}

beforeAll(async () => {
  db = await resetDb();
});
beforeEach(async () => {
  await db.unsafe("drop schema public cascade; create schema public;");
  await migrate(db);
});
afterAll(async () => {
  await db.end({ timeout: 5 });
});

describe("strings Postgres cannot hold", () => {
  test("a NUL byte or control character in a token's name, symbol or tokenURI is dropped and indexing carries on", async () => {
    const chain = emptyChain(1010n);
    withMeme(chain, MEME, { name: "Evil\u0000", symbol: "E\u0000V\u0007", tokenURI: "https://x.example/\u0000.json" });
    withMeme(chain, MEME2, { name: `${"N".repeat(300)}\ud800`, symbol: "HON", tokenURI: "ipfs://bafyhonest" });
    chain.logs.push(launchLog(MEME, 1001n), launchLog(MEME2, 1005n, `0x${"12".repeat(32)}`));
    const indexer = indexerOn(chainHandler(chain));
    await indexer.init();
    await indexer.syncOnce();

    const rows = await db<{ name: string; symbol: string; token_uri: string | null }[]>`
      select name, symbol, token_uri from launches order by created_block`;
    expect(rows.map((r) => [r.name.length > 20 ? `${r.name.slice(0, 3)}…${r.name.length}` : r.name, r.symbol, r.token_uri])).toEqual([
      ["Evil", "EV", null],
      ["NNN…128", "HON", "ipfs://bafyhonest"],
    ]);
    expect(await cursor()).toBe(1010n);
    expect(await db`select 1 from quarantined_logs`).toHaveLength(0);
  });
});

describe("a log that cannot be applied", () => {
  test("a log whose data the database refuses is set aside and the rest of its window is applied", async () => {
    const chain = emptyChain(1005n);
    withMeme(chain);
    const bad = buyLog(1002n, 20n);
    chain.logs.push(launchLog(MEME, 1000n), buyLog(1001n, 10n), bad, buyLog(1003n, 30n));
    await refuseTrade(bad.transactionHash, "22003");
    const indexer = indexerOn(chainHandler(chain));
    await indexer.init();
    const result = await indexer.syncOnce();

    expect(result.logsApplied).toBe(3);
    expect(await cursor()).toBe(1005n);
    const launch = (await db<{ trade_count: number; real_quote: string }[]>`select trade_count, real_quote from launches`)[0]!;
    // the refused buy left nothing behind, not even its update of the launch
    expect([launch.trade_count, BigInt(launch.real_quote)]).toEqual([2, 40n]);
    const q = await db<{ event_name: string; block_number: string; attempts: number; error: string }[]>`
      select event_name, block_number, attempts, error from quarantined_logs`;
    expect(q.map((r) => [r.event_name, Number(r.block_number), r.attempts])).toEqual([["curve.CurveBuy", 1002, 1]]);
    expect(q[0]!.error).toContain("22003");
    expect(await db`select 1 from applied_logs where tx_hash = ${bad.transactionHash.toLowerCase()}`).toHaveLength(0);

    // operators see it on the health endpoint
    const health = (await (await createApp({ db, config: testConfig() }).request("/health")).json()) as Health;
    expect(health.lastError).toBe("1 chain log could not be applied and was set aside");
    expect(health.lastErrorAt).not.toBeNull();
  });

  test("a log that keeps failing for another reason is retried, then set aside", async () => {
    const chain = emptyChain(1003n);
    withMeme(chain);
    const bad = buyLog(1002n, 20n);
    chain.logs.push(launchLog(MEME, 1000n), buyLog(1001n, 10n), bad);
    await refuseTrade(bad.transactionHash, "P0001");
    const indexer = indexerOn(chainHandler(chain));
    await indexer.init();
    for (let i = 1; i < QUARANTINE_AFTER_FAILURES; i++) {
      await expect(indexer.syncOnce()).rejects.toThrow("refused by test");
      expect(await cursor()).toBe(999n);
      expect(await db`select 1 from launches`).toHaveLength(0);
    }
    await indexer.syncOnce();
    expect(await cursor()).toBe(1003n);
    expect(await db`select 1 from trades`).toHaveLength(1);
    const q = await db<{ attempts: number }[]>`select attempts from quarantined_logs`;
    expect(q.map((r) => r.attempts)).toEqual([QUARANTINE_AFTER_FAILURES]);
  });
});

describe("RPC failures", () => {
  test("token metadata the RPC fails to return is fetched again later, not stored as a placeholder", async () => {
    const chain = emptyChain(1003n);
    withMeme(chain);
    chain.logs.push(launchLog(MEME, 1001n));
    let failing = true;
    const base = chainHandler(chain);
    const indexer = indexerOn(async (method, params) => {
      const to = String((params[0] as { to?: string } | undefined)?.to ?? "").toLowerCase();
      if (failing && method === "eth_call" && to === MEME.toLowerCase()) throw new Error("upstream timeout");
      return base(method, params);
    });
    await indexer.init();
    await expect(indexer.syncOnce()).rejects.toThrow();
    expect(await db`select 1 from launches`).toHaveLength(0);
    expect(await db`select 1 from quarantined_logs`).toHaveLength(0);
    expect(await cursor()).toBe(999n);

    failing = false;
    await indexer.syncOnce();
    const rows = await db<{ name: string; symbol: string; decimals: number }[]>`select name, symbol, decimals from launches`;
    expect(rows.map((r) => [r.name, r.symbol, r.decimals])).toEqual([["Meme", "MEME", 18]]);
  });

  test("an RPC error never puts the RPC URL or its key in /health or the log", async () => {
    const rpcUrl = "https://xlayer-testnet.g.alchemy.com/v2/Zq9SECRETkey0123456789abcdefXYZ";
    const client = createPublicClient({
      cacheTime: 0,
      transport: custom(
        {
          async request() {
            throw new HttpRequestError({ url: rpcUrl, status: 503, body: { method: "eth_blockNumber" }, details: "upstream down" });
          },
        },
        { retryCount: 0 },
      ),
    });
    const config = testConfig({ rpcUrl, confirmations: 0 });
    const lines: string[] = [];
    const indexer: Indexer = new Indexer({
      db,
      client,
      config,
      log: (msg, fields) => lines.push(JSON.stringify({ msg, ...fields })),
      sleep: async () => indexer.stop(),
    });
    await indexer.init();
    await indexer.runForever();

    const health = (await (await createApp({ db, config }).request("/health")).json()) as Health;
    expect(health.lastError).toContain("HTTP 503");
    for (const text of [health.lastError ?? "", lines.join("\n")]) {
      expect(text).not.toContain("SECRETkey");
      expect(text).not.toContain("alchemy.com/v2");
    }
    expect(lines.some((l) => l.includes("indexer error"))).toBe(true);
  });
});

describe("reorgs", () => {
  test("a reorg under the cursor rebuilds the chain's index from the deployment block", async () => {
    const chain = emptyChain(1001n);
    withMeme(chain);
    const POOL = `0x${"44".repeat(32)}` as Hex;
    const vault = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number, tx?: Hex) =>
      makeLog({ address: D.lpGrantVault, abi: ABI_BY_CONTRACT.lpGrantVault, eventName, args, blockNumber: block, logIndex, transactionHash: tx });
    chain.logs.push(
      launchLog(MEME, 1000n),
      vault("CampaignInitialized", { meme: MEME, poolId: POOL, reserve: 10n, basePool: 5n, referralBudget: 5n }, 1000n, 1),
      vault(
        "GrantActivated",
        {
          positionId: 7n,
          meme: MEME,
          beneficiary: BUYER,
          baseActivated: 1n,
          inviteeBoostActivated: 0n,
          inviterCreditActivated: 0n,
          quoteDeposited: 1n,
          liquidity: 1n,
          protocolShareWad: 500_000_000_000_000_000n,
        },
        1000n,
        2,
      ),
    );
    const feeTx = `0x${"fe".repeat(32)}` as Hex;
    const fee = (block: bigint) =>
      vault("GrantFeesCollected", { positionId: 7n, quoteFeesPaid: 100n, memeFeesPaid: 0n }, block, 0, feeTx);
    const orphanStatus = makeLog({
      address: D.factory,
      abi: ABI_BY_CONTRACT.factory,
      eventName: "LaunchStatusUpdated",
      args: { meme: MEME, status: 2, poolId: `0x${"00".repeat(32)}` },
      blockNumber: 1001n,
      logIndex: 1,
    });
    chain.logs.push(fee(1001n), orphanStatus);
    // another chain in the same database, which a rebuild of this one must not touch
    await db`insert into launches (chain_id, meme, launch_id, creator, quote, template_id, config_hash, created_block,
        created_log_index, created_tx, created_at)
      values (77, '0x77', '0x1', '0x2', '0x0', '0x3', '0x4', 1, 0, '0x5', 0)`;

    const indexer = indexerOn(chainHandler(chain));
    await indexer.init();
    await indexer.syncOnce();
    expect(String((await db`select fees_quote_paid from grant_positions where position_id = 7`)[0]!.fees_quote_paid)).toBe("100");
    expect(Number((await db`select status from launches where chain_id = ${CHAIN}`)[0]!.status)).toBe(2);

    // block 1001 is replaced: the fee transaction is mined again in 1002, the status change is gone
    chain.blocks.set(1001n, { hash: blockHash(1001n, 1), timestamp: 1_700_000_000n + 1001n });
    chain.logs = chain.logs.filter((l) => l.blockNumber !== 1001n);
    chain.logs.push(fee(1002n));
    chain.head = 1002n;
    await indexer.syncOnce();

    expect(String((await db`select fees_quote_paid from grant_positions where position_id = 7`)[0]!.fees_quote_paid)).toBe("100");
    expect(Number((await db`select status from launches where chain_id = ${CHAIN}`)[0]!.status)).toBe(1);
    expect(await cursor()).toBe(1002n);
    expect(await db`select 1 from launches where chain_id = 77`).toHaveLength(1);
  });

  test("a log from a block that is no longer the chain's is not applied", async () => {
    const chain = emptyChain(1003n);
    withMeme(chain);
    chain.logs.push(launchLog(MEME, 1001n));
    let stale = true;
    const base = chainHandler(chain);
    const indexer = indexerOn(async (method, params) => {
      const out = await base(method, params);
      if (stale && method === "eth_getLogs") {
        return (out as Array<{ blockNumber: Hex }>).map((l) => ({ ...l, blockHash: blockHash(BigInt(l.blockNumber), 7) }));
      }
      return out;
    });
    await indexer.init();
    await expect(indexer.syncOnce()).rejects.toThrow("no longer on the chain");
    expect(await db`select 1 from launches`).toHaveLength(0);
    expect(await cursor()).toBe(999n);

    stale = false;
    await indexer.syncOnce();
    expect(await db`select 1 from launches`).toHaveLength(1);
  });

  test("a window whose last block changes while its logs are read is read again", async () => {
    const chain = emptyChain(1003n);
    withMeme(chain);
    chain.logs.push(launchLog(MEME, 1001n));
    let reorgDuringRead = true;
    const base = chainHandler(chain);
    const indexer = indexerOn(async (method, params) => {
      const out = await base(method, params);
      if (reorgDuringRead && method === "eth_getLogs") {
        reorgDuringRead = false;
        chain.blocks.set(1003n, { hash: blockHash(1003n, 5), timestamp: 1_700_000_000n + 1003n });
      }
      return out;
    });
    await indexer.init();
    await expect(indexer.syncOnce()).rejects.toThrow("changed while");
    expect(await cursor()).toBe(999n);
    await indexer.syncOnce();
    expect(await cursor()).toBe(1003n);
    expect((await readSyncState(db, CHAIN))?.cursorHash).toBe(blockHash(1003n, 5).toLowerCase());
  });
});

describe("one indexer per chain", () => {
  test("a second indexer on the same database cannot apply a window twice", async () => {
    const chain = emptyChain(1002n);
    withMeme(chain);
    chain.logs.push(launchLog(MEME, 1000n), buyLog(1001n, 10n));
    const a = indexerOn(chainHandler(chain));
    const b = indexerOn(chainHandler(chain));
    await a.init();
    await b.init();
    await a.syncOnce();
    await expect(b.syncOnce()).rejects.toThrow("another indexer");
    const launch = (await db<{ trade_count: number; volume_quote_total: string }[]>`select trade_count, volume_quote_total from launches`)[0]!;
    expect([launch.trade_count, BigInt(launch.volume_quote_total)]).toEqual([1, 11n]);
    expect(await db`select 1 from trades`).toHaveLength(1);
  });

  test("the indexer lock admits one holder per chain and hands over when it is released", async () => {
    const first = await acquireIndexerLock(TEST_DATABASE_URL, CHAIN, { wait: false });
    let second: IndexerLock | null = null;
    try {
      expect(first?.held).toBe(true);
      expect(await acquireIndexerLock(TEST_DATABASE_URL, CHAIN, { wait: false })).toBeNull();
      const otherChain = await acquireIndexerLock(TEST_DATABASE_URL, 77, { wait: false });
      expect(otherChain?.held).toBe(true);
      await otherChain!.release();

      const said: string[] = [];
      second = await acquireIndexerLock(TEST_DATABASE_URL, CHAIN, {
        log: (msg) => said.push(msg),
        // the first holder exits while the second waits
        sleep: async () => first!.release(),
      });
      expect(second?.held).toBe(true);
      expect(said[0]).toContain("another indexer holds the lock");
    } finally {
      await second?.release();
      await first?.release();
    }
  });

  test("an indexer without the lock does not index", async () => {
    const chain = emptyChain(1005n);
    const calls: string[] = [];
    const said: string[] = [];
    const lock: IndexerLock = { held: false, ensure: async () => false, release: async () => {} };
    const indexer: Indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain, calls)),
      config: testConfig({ confirmations: 0 }),
      lock,
      log: (msg) => said.push(msg),
      sleep: async () => indexer.stop(),
    });
    await indexer.init();
    await indexer.runForever();
    expect(calls).toEqual([]);
    expect(said).toContain("indexer lock is held by another process; waiting");
  });
});
