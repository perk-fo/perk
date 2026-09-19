import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import type { Address, Hex } from "viem";
import type { Db, Tx } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { Indexer } from "../src/sync/indexer";
import { readSyncState } from "../src/sync/state";
import { NATIVE_QUOTE } from "../src/sync/apply";
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
  testConfig,
  txHash,
  type MockChain,
} from "./helpers";

const CHAIN = 1952;
const MEME = "0x0000000000000000000000000000000000001111" as Address;
const CREATOR = "0x0000000000000000000000000000000000002222" as Address;
const BUYER = "0x0000000000000000000000000000000000003333" as Address;
const ROUTER = "0x0000000000000000000000000000000000005555" as Address;
const WALLET = "0x0000000000000000000000000000000000006666" as Address;
const LAUNCH_ID = (`0x${"11".repeat(32)}`) as Hex;
const TEMPLATE_ID = (`0x${"22".repeat(32)}`) as Hex;
const CONFIG_HASH = (`0x${"33".repeat(32)}`) as Hex;
const POOL_ID = (`0x${"44".repeat(32)}`) as Hex;
const OTHER_POOL = (`0x${"99".repeat(32)}`) as Hex;
const ZERO = NATIVE_QUOTE as Address;

let db: Db;

function crashingDb(inner: Db, trip: { crash: boolean }): Db {
  return new Proxy(inner, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === "begin") {
        return (cb: (tx: Tx) => Promise<unknown>) =>
          target.begin(async (tx) => {
            const out = await cb(tx as unknown as Tx);
            if (trip.crash) {
              trip.crash = false;
              throw new Error("simulated crash");
            }
            return out;
          });
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as Function).bind(target) : v;
    },
  }) as Db;
}

async function row<T extends Record<string, unknown>>(sql: Promise<T[]>): Promise<T> {
  const rows = await sql;
  return rows[0];
}

describe("indexer", () => {
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

  test("backfill 3500 blocks with LOG_PAGE 1000 issues 4 getLogs windows and cursor ends at head - confirmations", async () => {
    const confirmations = 2;
    const start = BigInt(D.blockNumber);
    const span = 3500n;
    const target = start + span - 1n;
    const head = target + BigInt(confirmations);
    const chain = emptyChain(head);
    const calls: string[] = [];
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain, calls)),
      config: testConfig({ confirmations, logPage: 1000 }),
    });
    await indexer.init();
    const result = await indexer.syncOnce();
    expect(calls.filter((c) => c === "eth_getLogs")).toHaveLength(4);
    expect(result.toBlock).toBe(target);
    const state = await readSyncState(db, CHAIN);
    expect(state?.cursorBlock).toBe(head - BigInt(confirmations));
  });

  test("crash after apply rolls back the window; rerun applies fully", async () => {
    const head = 1010n;
    const chain = emptyChain(head);
    chain.erc20.set(MEME.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n });
    chain.logs.push(
      makeLog({
        address: D.factory,
        abi: ABI_BY_CONTRACT.factory,
        eventName: "LaunchCreated",
        args: {
          launchId: LAUNCH_ID,
          meme: MEME,
          creator: CREATOR,
          quote: ZERO,
          templateId: TEMPLATE_ID,
          configHash: CONFIG_HASH,
        },
        blockNumber: 1000n,
      }),
    );
    const trip = { crash: true };
    const indexer = new Indexer({
      db: crashingDb(db, trip),
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    const before = await readSyncState(db, CHAIN);
    await expect(indexer.syncOnce()).rejects.toThrow("simulated crash");
    const mid = await readSyncState(db, CHAIN);
    expect(mid?.cursorBlock).toBe(before?.cursorBlock);
    const launches = await db`select meme from launches`;
    expect(launches).toHaveLength(0);
    expect(trip.crash).toBe(false);

    const indexer2 = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer2.init();
    await indexer2.syncOnce();
    const after = await readSyncState(db, CHAIN);
    expect(after?.cursorBlock).toBe(head);
    const rows = await db<{ meme: string }[]>`select meme from launches`;
    expect(rows).toHaveLength(1);
    expect(rows[0].meme).toBe(MEME);
  });

  test("LaunchCreated at N plus Transfer of that meme at N+1 in the same window are indexed (second pass)", async () => {
    const head = 1010n;
    const chain = emptyChain(head);
    chain.erc20.set(MEME.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n });
    chain.logs.push(
      makeLog({
        address: D.factory,
        abi: ABI_BY_CONTRACT.factory,
        eventName: "LaunchCreated",
        args: {
          launchId: LAUNCH_ID,
          meme: MEME,
          creator: CREATOR,
          quote: ZERO,
          templateId: TEMPLATE_ID,
          configHash: CONFIG_HASH,
        },
        blockNumber: 1000n,
        logIndex: 0,
      }),
      makeTransferLog({
        token: MEME,
        from: ZERO,
        to: BUYER,
        value: 77n,
        blockNumber: 1001n,
        logIndex: 0,
      }),
    );
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    await indexer.syncOnce();
    const transfers = await db<{ value: string; to_addr: string }[]>`select value, to_addr from token_transfers`;
    expect(transfers).toHaveLength(1);
    expect(BigInt(transfers[0].value)).toBe(77n);
    expect(transfers[0].to_addr).toBe(BUYER);
    const launch = await row(db<Record<string, unknown>[]>`select holder_count from launches where meme = ${MEME}`);
    expect(launch.holder_count).toBe(1);
  });

  test("Swap logs for an untracked pool id are ignored, tracked ones become trades", async () => {
    const head = 1020n;
    const chain = emptyChain(head);
    chain.erc20.set(MEME.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n });
    const swapTx = txHash(1012n, 0);
    chain.txFrom.set(swapTx, WALLET);
    chain.logs.push(
      makeSwapLog({
        poolManager: D.poolManager,
        id: OTHER_POOL,
        sender: ROUTER,
        amount0: -10n,
        amount1: 100n,
        blockNumber: 1000n,
        logIndex: 0,
      }),
      makeLog({
        address: D.factory,
        abi: ABI_BY_CONTRACT.factory,
        eventName: "LaunchCreated",
        args: {
          launchId: LAUNCH_ID,
          meme: MEME,
          creator: CREATOR,
          quote: ZERO,
          templateId: TEMPLATE_ID,
          configHash: CONFIG_HASH,
        },
        blockNumber: 1010n,
        logIndex: 0,
      }),
      makeLog({
        address: D.graduationManager,
        abi: ABI_BY_CONTRACT.graduationManager,
        eventName: "LaunchGraduated",
        args: {
          meme: MEME,
          launchId: LAUNCH_ID,
          poolId: POOL_ID,
          memeToPool: 1n,
          quoteToPool: 1n,
          liquidity: 1n,
        },
        blockNumber: 1011n,
        logIndex: 0,
      }),
      makeSwapLog({
        poolManager: D.poolManager,
        id: POOL_ID,
        sender: ROUTER,
        amount0: -50n,
        amount1: 1000n,
        blockNumber: 1012n,
        logIndex: 0,
        transactionHash: swapTx,
      }),
    );
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    await indexer.syncOnce();
    const trades = await db<{ source: string; side: string; wallet: string; router: string | null }[]>`
      select source, side, wallet, router from trades`;
    expect(trades).toHaveLength(1);
    expect(trades[0].source).toBe("pool");
    expect(trades[0].side).toBe("buy");
    expect(trades[0].wallet).toBe(WALLET);
    expect(trades[0].router).toBe(ROUTER);
  });

  test("reorg: cursor hash change rolls back and re-applies with no duplicate trades", async () => {
    const head = 1001n;
    const chain = emptyChain(head);
    chain.erc20.set(MEME.toLowerCase(), { name: "Meme", symbol: "MEME", decimals: 18, totalSupply: 1_000_000n });
    const created = makeLog({
      address: D.factory,
      abi: ABI_BY_CONTRACT.factory,
      eventName: "LaunchCreated",
      args: {
        launchId: LAUNCH_ID,
        meme: MEME,
        creator: CREATOR,
        quote: ZERO,
        templateId: TEMPLATE_ID,
        configHash: CONFIG_HASH,
      },
      blockNumber: 1000n,
      logIndex: 0,
    });
    const buy1 = makeLog({
      address: D.curve,
      abi: ABI_BY_CONTRACT.curve,
      eventName: "CurveBuy",
      args: {
        meme: MEME,
        buyer: BUYER,
        recipient: BUYER,
        quoteGross: 100n,
        fee: 1n,
        quoteNet: 99n,
        memeOut: 1000n,
      },
      blockNumber: 1001n,
      logIndex: 0,
    });
    chain.logs.push(created, buy1);
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    await indexer.syncOnce();
    expect((await db`select * from trades`).length).toBe(1);
    expect(BigInt((await row(db<{ real_quote: string }[]>`select real_quote from launches`)).real_quote)).toBe(99n);

    // Idle passes skip the reorg check; bump head so the next pass has work.
    chain.head = 1002n;
    chain.blocks.set(1001n, { hash: blockHash(1001n, 1), timestamp: 1_700_000_000n + 1001n });
    chain.logs = chain.logs.filter((l) => l.transactionHash !== buy1.transactionHash);
    chain.logs.push(
      makeLog({
        address: D.curve,
        abi: ABI_BY_CONTRACT.curve,
        eventName: "CurveBuy",
        args: {
          meme: MEME,
          buyer: BUYER,
          recipient: BUYER,
          quoteGross: 40n,
          fee: 1n,
          quoteNet: 39n,
          memeOut: 400n,
        },
        blockNumber: 1001n,
        logIndex: 0,
        transactionHash: txHash(1001n, 0, 9),
      }),
    );

    await indexer.syncOnce();
    const trades = await db<{ quote_amount: string }[]>`select quote_amount from trades`;
    expect(trades).toHaveLength(1);
    expect(BigInt(trades[0].quote_amount)).toBe(40n);
    const launch = await row(db<{ real_quote: string; trade_count: number }[]>`select real_quote, trade_count from launches`);
    expect(BigInt(launch.real_quote)).toBe(39n);
    expect(launch.trade_count).toBe(1);
  });

  test("RPC error sets last_error; next successful pass clears it", async () => {
    const chain = emptyChain(1010n);
    let fail = true;
    const base = chainHandler(chain);
    const handler = async (method: string, params: unknown[]) => {
      if (fail && method === "eth_blockNumber") throw new Error("rpc down");
      return base(method, params);
    };
    const indexer = new Indexer({
      db,
      client: mockClient(handler),
      config: testConfig({ confirmations: 0, pollMs: 20 }),
    });
    await indexer.init();
    const running = indexer.runForever();
    try {
      let errored: Awaited<ReturnType<typeof readSyncState>> = null;
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(50);
        errored = await readSyncState(db, CHAIN);
        if (errored?.lastError) break;
      }
      expect(errored?.lastError ?? "").toContain("rpc down");
      fail = false;
      let ok: Awaited<ReturnType<typeof readSyncState>> = errored;
      for (let i = 0; i < 40; i++) {
        await Bun.sleep(50);
        ok = await readSyncState(db, CHAIN);
        if (ok?.lastError === null) break;
      }
      expect(ok?.lastError).toBeNull();
    } finally {
      indexer.stop();
      await running;
    }
  });

  test("runForever stops within one poll after stop()", async () => {
    const chain = emptyChain(1005n);
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0, pollMs: 30 }),
    });
    await indexer.init();
    const running = indexer.runForever();
    await Bun.sleep(20);
    const t0 = Date.now();
    indexer.stop();
    await running;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(indexer.isStopped).toBe(true);
  });
});
