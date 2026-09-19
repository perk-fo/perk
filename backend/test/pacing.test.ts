import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import type { Address, Hex } from "viem";
import type { Db, Tx } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { Indexer } from "../src/sync/indexer";
import { listenSync, type SyncNotice } from "../src/sync/notify";
import { readSyncState, recordHead } from "../src/sync/state";
import { NATIVE_QUOTE } from "../src/sync/apply";
import {
  ABI_BY_CONTRACT,
  TEST_DEPLOYMENT as D,
  chainHandler,
  emptyChain,
  makeLog,
  mockClient,
  resetDb,
  testConfig,
} from "./helpers";

const CHAIN = 1952;
const MEME = "0x0000000000000000000000000000000000001111" as Address;
const CREATOR = "0x0000000000000000000000000000000000002222" as Address;
const BUYER = "0x0000000000000000000000000000000000003333" as Address;
const LAUNCH_ID = (`0x${"11".repeat(32)}`) as Hex;
const TEMPLATE_ID = (`0x${"22".repeat(32)}`) as Hex;
const CONFIG_HASH = (`0x${"33".repeat(32)}`) as Hex;
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

async function waitNotices(got: SyncNotice[], n: number, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (got.length < n && Date.now() - t0 < timeoutMs) await Bun.sleep(20);
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

describe("pacing", () => {

  test("test_syncOnce_idle_one_rpc_live", async () => {
    const calls: string[] = [];
    const cursor = BigInt(D.blockNumber) - 1n;
    const chain = emptyChain(cursor);
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain, calls)),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    const result = await indexer.syncOnce();
    expect(calls).toEqual(["eth_blockNumber"]);
    expect(result.mode).toBe("live");
    expect(result.lag).toBe(0n);
    expect(result.fromBlock).toBeNull();
    expect(result.logsApplied).toBe(0);
  });

  test("test_syncOnce_catchup_runForever_sleeps_when_live", async () => {
    const pollMs = 1500;
    const catchupBlocks = 200;
    const logPage = 100;
    const cursor = BigInt(D.blockNumber) - 1n;
    const lag = 5000n;
    const head = cursor + lag;
    const chain = emptyChain(head);
    const sleeps: number[] = [];
    let indexer!: Indexer;
    indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0, pollMs, catchupBlocks, logPage }),
      sleep: async (ms) => {
        sleeps.push(ms);
        indexer.stop();
      },
    });
    await indexer.init();
    const first = await indexer.syncOnce();
    expect(first.mode).toBe("catchup");
    expect(first.lag > BigInt(catchupBlocks)).toBe(true);
    expect(sleeps).toHaveLength(0);

    await indexer.runForever();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(pollMs);
    const state = await readSyncState(db, CHAIN);
    expect(state?.cursorBlock).toBe(head);
  });

  test("test_catchup_gap_finished_in_one_pass_sleeps", async () => {
    // gap 1500 > catchupBlocks (200) but within 20 windows of 100: one pass reaches the target, so the loop must
    // sleep instead of spinning — "caught up" means the pass reached its target, not lag <= catchupBlocks.
    const pollMs = 7;
    const cursor = BigInt(D.blockNumber) - 1n;
    const head = cursor + 1500n;
    const sleeps: number[] = [];
    const passes: string[] = [];
    let indexer!: Indexer;
    indexer = new Indexer({
      db,
      client: mockClient(chainHandler(emptyChain(head), passes)),
      config: testConfig({ confirmations: 0, pollMs, catchupBlocks: 200, logPage: 100 }),
      sleep: async (ms) => {
        sleeps.push(ms);
        indexer.stop();
      },
    });
    await indexer.init();
    const r = await indexer.syncOnce();
    expect(r.mode).toBe("catchup");
    expect(r.reachedTarget).toBe(true);
    expect(r.lag).toBe(0n);
    indexer.stop();
    (indexer as unknown as { stopped: boolean }).stopped = false;
    await indexer.runForever();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(pollMs);
  });

  test("test_idle_pass_with_unchanged_head_writes_nothing", async () => {
    const cursor = BigInt(D.blockNumber) - 1n;
    const indexer = new Indexer({ db, client: mockClient(chainHandler(emptyChain(cursor))), config: testConfig({ confirmations: 0 }) });
    await indexer.init();
    await indexer.syncOnce();
    const before = await db<{ updated_at: Date }[]>`select updated_at from sync_state where chain_id = ${CHAIN}`;
    await Bun.sleep(15);
    await indexer.syncOnce();
    const after = await db<{ updated_at: Date }[]>`select updated_at from sync_state where chain_id = ${CHAIN}`;
    expect(after[0].updated_at.getTime()).toBe(before[0].updated_at.getTime());
  });

  test("test_runForever_live_apply_then_sleep", async () => {
    const pollMs = 42;
    const chain = emptyChain(1050n);
    const sleeps: number[] = [];
    let indexer!: Indexer;
    indexer = new Indexer({
      db,
      client: mockClient(chainHandler(chain)),
      config: testConfig({ confirmations: 0, pollMs, catchupBlocks: 200 }),
      sleep: async (ms) => {
        sleeps.push(ms);
        indexer.stop();
      },
    });
    await indexer.init();
    await indexer.runForever();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeLessThanOrEqual(pollMs);
    const state = await readSyncState(db, CHAIN);
    expect(state?.cursorBlock).toBe(1050n);
  });

  test("test_recordHead_null_keeps_head_time", async () => {
    const indexer = new Indexer({
      db,
      client: mockClient(chainHandler(emptyChain(1000n))),
      config: testConfig({ confirmations: 0 }),
    });
    await indexer.init();
    await recordHead(db, CHAIN, 1000n, 1_700_000_111n);
    let state = await readSyncState(db, CHAIN);
    expect(state?.headBlock).toBe(1000n);
    expect(state?.headTime).toBe(1_700_000_111n);
    await recordHead(db, CHAIN, 1005n, null);
    state = await readSyncState(db, CHAIN);
    expect(state?.headBlock).toBe(1005n);
    expect(state?.headTime).toBe(1_700_000_111n);
  });
});

describe("notify", () => {

  test("test_notifySync_committed_window_delivers_notice", async () => {
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
      makeLog({
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
      }),
    );
    const notices: SyncNotice[] = [];
    const { unlisten } = await listenSync(db, CHAIN, (n) => notices.push(n));
    try {
      const indexer = new Indexer({
        db,
        client: mockClient(chainHandler(chain)),
        config: testConfig({ confirmations: 0 }),
      });
      await indexer.init();
      await indexer.syncOnce();
      await waitNotices(notices, 1);
      expect(notices).toHaveLength(1);
      expect(notices[0].chainId).toBe(CHAIN);
      expect(notices[0].memes).toEqual([MEME]);
      expect(notices[0].fromBlock).toBeLessThanOrEqual(1001);
      expect(notices[0].toBlock).toBeGreaterThanOrEqual(1001);
    } finally {
      await unlisten();
    }
  });

  test("test_notifySync_rolled_back_window_delivers_nothing", async () => {
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
      makeLog({
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
      }),
    );
    const notices: SyncNotice[] = [];
    const { unlisten } = await listenSync(db, CHAIN, (n) => notices.push(n));
    try {
      const trip = { crash: true };
      const indexer = new Indexer({
        db: crashingDb(db, trip),
        client: mockClient(chainHandler(chain)),
        config: testConfig({ confirmations: 0 }),
      });
      await indexer.init();
      await expect(indexer.syncOnce()).rejects.toThrow("simulated crash");
      await Bun.sleep(200);
      expect(notices).toHaveLength(0);
    } finally {
      await unlisten();
    }
  });
});
