import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../src/db/client";
import type { createApp } from "../src/api/server";
import type {
  Candle,
  CurveState,
  FeeTotals,
  Graduation,
  GrantAllocation,
  GrantCampaign,
  GrantDetail,
  GrantPosition,
  Health,
  Holder,
  HoldersPage,
  LaunchDetail,
  LaunchSummary,
  MarketStats,
  Stats,
  Trade,
  TradesPage,
  WalletRoles,
  WalletSummary,
  WalletTrade,
  WalletTradesPage,
} from "../src/api/types";
import {
  ADMIN,
  CHAIN,
  CIRCULATING,
  CREATOR_CURVE,
  CREATOR_GRAD,
  CURSOR_BLOCK,
  EXCLUDED,
  HOLDER_A,
  HOLDER_A_BAL,
  HEAD_BLOCK,
  INVITEE,
  INVITER,
  LP_1,
  LP_2,
  MEME_CURVE,
  MEME_GRAD,
  PLAIN,
  ROUTER,
  START_BLOCK,
  TRADER,
  WOKB,
  ZERO,
  makeTestApp,
  resetDb,
  seed,
  type SeedMeta,
} from "./api-helpers";

let db: Db;
let app: ReturnType<typeof createApp>;
let meta: SeedMeta;

beforeAll(async () => {
  db = await resetDb();
  meta = await seed(db);
  ({ app } = await makeTestApp(db));
});

afterAll(async () => {
  await db.end({ timeout: 5 });
});

async function get(path: string): Promise<Response> {
  return app.request(path);
}

async function json<T>(path: string, status = 200): Promise<{ body: T; res: Response }> {
  const res = await get(path);
  expect(res.status).toBe(status);
  return { body: (await res.json()) as T, res };
}

function expectAddr(v: unknown) {
  expect(typeof v).toBe("string");
  expect(v).toMatch(/^0x[0-9a-f]{40}$/);
}

function expectHex(v: unknown) {
  expect(typeof v).toBe("string");
  expect(v).toMatch(/^0x[0-9a-f]+$/);
}

function expectUint(v: unknown) {
  expect(typeof v).toBe("string");
  expect(v).toMatch(/^-?\d+$/);
}

function expectNum(v: unknown) {
  expect(typeof v).toBe("number");
  expect(Number.isFinite(v)).toBe(true);
}

function expectMarket(m: MarketStats) {
  if (m.lastPriceQuote === null) expect(m.lastPriceQuote).toBeNull();
  else expectUint(m.lastPriceQuote);
  if (m.lastPriceMeme === null) expect(m.lastPriceMeme).toBeNull();
  else expectUint(m.lastPriceMeme);
  if (m.lastPrice === null) expect(m.lastPrice).toBeNull();
  else expectNum(m.lastPrice);
  expectNum(m.change24hBps);
  expectUint(m.volume24hQuote);
  expectUint(m.volumeTotalQuote);
  if (m.marketCapQuote === null) expect(m.marketCapQuote).toBeNull();
  else expectUint(m.marketCapQuote);
  expectNum(m.tradeCount);
  expectNum(m.holderCount);
  if (m.lastTradeAt === null) expect(m.lastTradeAt).toBeNull();
  else expectNum(m.lastTradeAt);
}

function expectCurve(c: CurveState) {
  expectUint(c.virtualQuoteReserve);
  expectUint(c.virtualMemeReserve);
  expectUint(c.curveSupply);
  expectUint(c.poolReserveSupply);
  expectUint(c.graduationQuoteThreshold);
  expectNum(c.totalFeeBps);
  expectUint(c.realQuote);
  expectUint(c.memeSold);
  expectNum(c.progressBps);
  expect(typeof c.graduated).toBe("boolean");
  expect(typeof c.finalized).toBe("boolean");
}

function expectLaunchSummary(x: LaunchSummary) {
  expectAddr(x.meme);
  expectHex(x.launchId);
  expectAddr(x.creator);
  expectAddr(x.quote);
  expect(typeof x.quoteSymbol).toBe("string");
  expectNum(x.quoteDecimals);
  expectHex(x.templateId);
  expectHex(x.configHash);
  expectUint(x.moduleBitmap);
  if (x.hookVersion === null) expect(x.hookVersion).toBeNull();
  else expectNum(x.hookVersion);
  expect(typeof x.lpGrantEnabled).toBe("boolean");
  expect(typeof x.name).toBe("string");
  expect(typeof x.symbol).toBe("string");
  expectNum(x.decimals);
  if (x.totalSupply === null) expect(x.totalSupply).toBeNull();
  else expectUint(x.totalSupply);
  expect([0, 1, 2, 3]).toContain(x.status);
  if (x.poolId === null) expect(x.poolId).toBeNull();
  else expectHex(x.poolId);
  expectNum(x.createdAt);
  expectNum(x.createdBlock);
  expectHex(x.createdTx);
  if (x.curve === null) expect(x.curve).toBeNull();
  else expectCurve(x.curve);
  expectMarket(x.market);
  if (x.grantStatus === null) expect(x.grantStatus).toBeNull();
  else expect([0, 1, 2, 3, 4, 5]).toContain(x.grantStatus);
  if (x.metadata === null) expect(x.metadata).toBeNull();
  else {
    expect(typeof x.metadata).toBe("object");
    if (x.metadata.image === null) expect(x.metadata.image).toBeNull();
    else expect(typeof x.metadata.image).toBe("string");
    if (x.metadata.description === null) expect(x.metadata.description).toBeNull();
    else expect(typeof x.metadata.description).toBe("string");
    expect(typeof x.metadata.links).toBe("object");
  }
}

function expectGraduation(g: Graduation) {
  expectNum(g.block);
  expectNum(g.at);
  expectUint(g.memeToPool);
  expectUint(g.quoteToPool);
  expectUint(g.liquidity);
  expect(typeof g.memeIsCurrency0).toBe("boolean");
}

function expectFees(f: FeeTotals) {
  expectUint(f.total);
  expectUint(f.dev);
  expectUint(f.rewards);
  expectUint(f.lp);
  expectUint(f.treasury);
  expectUint(f.protocol);
  expectUint(f.devClaimed);
  expectUint(f.rewardsClaimed);
}

function expectGrantCampaign(g: GrantCampaign) {
  expectAddr(g.meme);
  if (g.poolId === null) expect(g.poolId).toBeNull();
  else expectHex(g.poolId);
  expect([0, 1, 2, 3, 4, 5]).toContain(g.status);
  expectUint(g.reserve);
  expectUint(g.basePool);
  expectUint(g.referralBudget);
  if (g.root === null) expect(g.root).toBeNull();
  else expectHex(g.root);
  if (g.rootUri === null) expect(g.rootUri).toBeNull();
  else expect(typeof g.rootUri).toBe("string");
  if (g.rootTotalBase === null) expect(g.rootTotalBase).toBeNull();
  else expectUint(g.rootTotalBase);
  if (g.rootTotalInviteeBoost === null) expect(g.rootTotalInviteeBoost).toBeNull();
  else expectUint(g.rootTotalInviteeBoost);
  if (g.rootProposedAt === null) expect(g.rootProposedAt).toBeNull();
  else expectNum(g.rootProposedAt);
  if (g.activatableAt === null) expect(g.activatableAt).toBeNull();
  else expectNum(g.activatableAt);
  if (g.startTime === null) expect(g.startTime).toBeNull();
  else expectNum(g.startTime);
  if (g.endTime === null) expect(g.endTime).toBeNull();
  else expectNum(g.endTime);
  expectUint(g.totalActivated);
  expectUint(g.burned);
  expectUint(g.quoteToTreasury);
  expect(g).not.toHaveProperty("excessToIncentive");
  expect(g).not.toHaveProperty("excessToTreasury");
  expect(g).not.toHaveProperty("incentiveSwept");
  expectNum(g.positionsCount);
  expectNum(g.activePositions);
  expectNum(g.initializedAt);
  if (g.finalizedAt === null) expect(g.finalizedAt).toBeNull();
  else expectNum(g.finalizedAt);
  if (g.cancelledAt === null) expect(g.cancelledAt).toBeNull();
  else expectNum(g.cancelledAt);
}

function expectGrantPosition(p: GrantPosition) {
  expectUint(p.positionId);
  expectAddr(p.meme);
  expectAddr(p.beneficiary);
  expectUint(p.baseActivated);
  expectUint(p.inviteeBoostActivated);
  expectUint(p.inviterCreditActivated);
  expectUint(p.quoteDeposited);
  expectUint(p.liquidity);
  expectUint(p.protocolShareWad);
  expectNum(p.activatedAt);
  expectNum(p.activatedBlock);
  expectHex(p.activatedTx);
  expectUint(p.feesQuotePaid);
  expectUint(p.feesMemePaid);
  expect(p).not.toHaveProperty("incentivePaid");
  expect(p).not.toHaveProperty("exitExcessQuote");
  expect(typeof p.exited).toBe("boolean");
  if (p.exitedAt === null) expect(p.exitedAt).toBeNull();
  else expectNum(p.exitedAt);
  if (p.exitedTx === null) expect(p.exitedTx).toBeNull();
  else expectHex(p.exitedTx);
  if (p.exitQuoteToUser === null) expect(p.exitQuoteToUser).toBeNull();
  else expectUint(p.exitQuoteToUser);
  if (p.exitMemeToUser === null) expect(p.exitMemeToUser).toBeNull();
  else expectUint(p.exitMemeToUser);
  if (p.exitQuoteToTreasury === null) expect(p.exitQuoteToTreasury).toBeNull();
  else expectUint(p.exitQuoteToTreasury);
  if (p.exitMemeBurned === null) expect(p.exitMemeBurned).toBeNull();
  else expectUint(p.exitMemeBurned);
}

function expectAllocation(a: GrantAllocation) {
  expectAddr(a.account);
  expectUint(a.baseAllocation);
  expectUint(a.inviteeBoost);
  expectUint(a.inviteeBoostEarned);
  expectNum(a.registeredAt);
}

function expectTrade(t: Trade) {
  expect(typeof t.id).toBe("string");
  expect(t.id).toBe(`${t.txHash}:${t.logIndex}`);
  expectHex(t.txHash);
  expectNum(t.logIndex);
  expectNum(t.blockNumber);
  expectNum(t.timestamp);
  expect(["buy", "sell"]).toContain(t.side);
  expect(["curve", "pool"]).toContain(t.source);
  expectAddr(t.wallet);
  if (t.router === null) expect(t.router).toBeNull();
  else expectAddr(t.router);
  expectUint(t.quoteAmount);
  expectUint(t.memeAmount);
  if (t.fee === null) expect(t.fee).toBeNull();
  else expectUint(t.fee);
  expectUint(t.priceQuote);
  expectUint(t.priceMeme);
  expectNum(t.price);
}

function expectCandle(c: Candle) {
  expectNum(c.t);
  expectNum(c.o);
  expectNum(c.h);
  expectNum(c.l);
  expectNum(c.c);
  expectUint(c.v);
  expectNum(c.n);
}

function expectHolder(h: Holder) {
  expectAddr(h.address);
  expectUint(h.balance);
  expectNum(h.shareBps);
}

function expectHealth(h: Health) {
  expect(typeof h.ok).toBe("boolean");
  expectNum(h.chainId);
  expectNum(h.cursorBlock);
  if (h.headBlock === null) expect(h.headBlock).toBeNull();
  else expectNum(h.headBlock);
  if (h.lagBlocks === null) expect(h.lagBlocks).toBeNull();
  else expectNum(h.lagBlocks);
  if (h.lagSeconds === null) expect(h.lagSeconds).toBeNull();
  else expectNum(h.lagSeconds);
  expectNum(h.startBlock);
  expect(typeof h.updatedAt).toBe("string");
  if (h.lastError === null) expect(h.lastError).toBeNull();
  else expect(typeof h.lastError).toBe("string");
  if (h.lastErrorAt === null) expect(h.lastErrorAt).toBeNull();
  else expect(typeof h.lastErrorAt).toBe("string");
  expectNum(h.serverTime);
}

function expectRoles(r: WalletRoles) {
  expectAddr(r.address);
  expect(typeof r.isAdmin).toBe("boolean");
  expect(Array.isArray(r.creatorOf)).toBe(true);
  for (const a of r.creatorOf) expectAddr(a);
  expect(Array.isArray(r.lpOf)).toBe(true);
  for (const a of r.lpOf) expectAddr(a);
  expect(Array.isArray(r.allocatedIn)).toBe(true);
  for (const a of r.allocatedIn) expectAddr(a);
  if (r.inviter === null) expect(r.inviter).toBeNull();
  else expectAddr(r.inviter);
  if (r.optInBlock === null) expect(r.optInBlock).toBeNull();
  else expectNum(r.optInBlock);
}

describe("GET /health", () => {
  test("test_health_stale_cursor_lag", async () => {
    const { body, res } = await json<Health>("/health");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectHealth(body);
    expect(body.chainId).toBe(CHAIN);
    expect(body.cursorBlock).toBe(CURSOR_BLOCK);
    expect(body.headBlock).toBe(HEAD_BLOCK);
    expect(body.lagBlocks).toBe(HEAD_BLOCK - CURSOR_BLOCK);
    expect(body.lagSeconds).toBe(body.serverTime - meta.cursorTs);
    expect(body.startBlock).toBe(START_BLOCK);
    expect(body.ok).toBe(false);
    expect(body.lastError).toBeNull();
  });

  test("test_health_ok_when_caught_up", async () => {
    await db`update sync_state set cursor_block = ${1090}, last_error = null, last_error_at = null where chain_id = ${CHAIN}`;
    try {
      const { body } = await json<Health>("/health");
      expectHealth(body);
      expect(body.lagBlocks).toBe(10);
      expect(body.ok).toBe(true);
    } finally {
      await db`update sync_state set cursor_block = ${CURSOR_BLOCK} where chain_id = ${CHAIN}`;
    }
  });
});

describe("GET /v1/launches", () => {
  test("test_list_happy_shape", async () => {
    const { body, res } = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(body.total).toBe(2);
    expect(body.launches.length).toBe(2);
    for (const row of body.launches) expectLaunchSummary(row);
  });

  test("test_list_sort_newest", async () => {
    const { body } = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?sort=newest");
    expect(body.launches.map((l) => l.meme)).toEqual([MEME_CURVE, MEME_GRAD]);
  });

  test("test_list_sort_volume", async () => {
    const { body } = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?sort=volume");
    expect(body.launches.map((l) => l.meme)).toEqual([MEME_GRAD, MEME_CURVE]);
  });

  test("test_list_sort_progress", async () => {
    const { body } = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?sort=progress");
    expect(body.launches[0].meme).toBe(MEME_GRAD);
    expect(body.launches[0].status).toBe(3);
  });

  test("test_list_sort_trades", async () => {
    const { body } = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?sort=trades");
    expect(body.launches.map((l) => l.meme)).toEqual([MEME_GRAD, MEME_CURVE]);
  });

  test("test_list_filter_status", async () => {
    const one = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?status=1");
    expect(one.body.total).toBe(1);
    expect(one.body.launches[0].meme).toBe(MEME_CURVE);
    const both = await json<{ launches: LaunchSummary[]; total: number }>("/v1/launches?status=1,3");
    expect(both.body.total).toBe(2);
  });

  test("test_list_filter_quote", async () => {
    const native = await json<{ launches: LaunchSummary[]; total: number }>(`/v1/launches?quote=${ZERO}`);
    expect(native.body.total).toBe(1);
    expect(native.body.launches[0].meme).toBe(MEME_CURVE);
    const wokb = await json<{ launches: LaunchSummary[]; total: number }>(`/v1/launches?quote=${WOKB}`);
    expect(wokb.body.total).toBe(1);
    expect(wokb.body.launches[0].meme).toBe(MEME_GRAD);
  });

  test("test_list_filter_creator", async () => {
    const { body } = await json<{ launches: LaunchSummary[]; total: number }>(`/v1/launches?creator=${CREATOR_GRAD}`);
    expect(body.total).toBe(1);
    expect(body.launches[0].meme).toBe(MEME_GRAD);
  });

  test("test_list_reverts_bad_address", async () => {
    const res = await get("/v1/launches?quote=not-an-address");
    expect(res.status).toBe(400);
  });

  test("test_list_reverts_bad_limit", async () => {
    const res = await get("/v1/launches?limit=201");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/launches/:meme", () => {
  test("test_detail_happy_shape", async () => {
    const { body, res } = await json<LaunchDetail>(`/v1/launches/${MEME_GRAD}`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3");
    expectLaunchSummary(body);
    expect(body.graduation).not.toBeNull();
    expectGraduation(body.graduation!);
    expect(body.grant).not.toBeNull();
    expectGrantCampaign(body.grant!);
    expectFees(body.fees);
    expect(body.fees.total).toBe("10000");
    expect(body.fees.devClaimed).toBe("50");
    expect(body.fees.rewardsClaimed).toBe("100");
    expect(body.curve?.progressBps).toBe(10_000);
    expect(body.market.change24hBps).toBe(meta.change24hBps);
    expect(body.market.volume24hQuote).toBe(meta.gradNewQuoteVolume.toString());
    expect(body.market.marketCapQuote).toBe(meta.marketCapQuote);
  });

  test("test_detail_curve_progress", async () => {
    const { body } = await json<LaunchDetail>(`/v1/launches/${MEME_CURVE}`);
    expectLaunchSummary(body);
    expect(body.graduation).toBeNull();
    expect(body.grant).toBeNull();
    expect(body.curve?.progressBps).toBe(1000);
    expectFees(body.fees);
  });

  test("test_detail_reverts_unknown_meme", async () => {
    const res = await get("/v1/launches/0x000000000000000000000000000000000000dead");
    expect(res.status).toBe(404);
  });

  test("test_detail_reverts_bad_address", async () => {
    const res = await get("/v1/launches/0xgg");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/launches/:meme/trades", () => {
  test("test_trades_happy_and_pagination", async () => {
    const page1 = await json<TradesPage>(`/v1/launches/${MEME_GRAD}/trades?limit=10`);
    expect(page1.res.headers.get("Cache-Control")).toBe("public, max-age=3");
    expect(page1.body.trades.length).toBe(10);
    for (const t of page1.body.trades) expectTrade(t);
    expect(page1.body.nextCursor).toBeTruthy();
    const ids1 = new Set(page1.body.trades.map((t) => t.id));

    const page2 = await json<TradesPage>(`/v1/launches/${MEME_GRAD}/trades?limit=10&before=${page1.body.nextCursor}`);
    expect(page2.body.trades.length).toBe(10);
    for (const t of page2.body.trades) expectTrade(t);
    for (const t of page2.body.trades) expect(ids1.has(t.id)).toBe(false);

    const newest = page1.body.trades[0];
    const oldestPage1 = page1.body.trades[9];
    expect(newest.blockNumber > oldestPage1.blockNumber || (newest.blockNumber === oldestPage1.blockNumber && newest.logIndex > oldestPage1.logIndex)).toBe(true);
    const page2First = page2.body.trades[0];
    expect(
      page2First.blockNumber < oldestPage1.blockNumber ||
        (page2First.blockNumber === oldestPage1.blockNumber && page2First.logIndex < oldestPage1.logIndex),
    ).toBe(true);
  });

  test("test_trades_reverts_unknown_meme", async () => {
    const res = await get("/v1/launches/0x000000000000000000000000000000000000dead/trades");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/launches/:meme/candles", () => {
  test("test_candles_bucket_math", async () => {
    const { from, to, t, o, h, l, c: close, v, n } = meta.candle;
    const { body, res } = await json<{ candles: Candle[] }>(
      `/v1/launches/${MEME_GRAD}/candles?interval=5m&from=${from}&to=${to}&limit=10`,
    );
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(body.candles.length).toBe(1);
    const candle = body.candles[0];
    expectCandle(candle);
    expect(candle.t).toBe(t);
    expect(candle.o).toBe(o);
    expect(candle.h).toBe(h);
    expect(candle.l).toBe(l);
    expect(candle.c).toBe(close);
    expect(candle.v).toBe(v);
    expect(candle.n).toBe(n);
  });

  test("test_candles_reverts_bad_interval", async () => {
    const res = await get(`/v1/launches/${MEME_GRAD}/candles?interval=2m`);
    expect(res.status).toBe(400);
  });

  test("test_candles_reverts_bad_limit", async () => {
    const res = await get(`/v1/launches/${MEME_GRAD}/candles?limit=1001`);
    expect(res.status).toBe(400);
  });

  test("test_candles_reverts_unknown_meme", async () => {
    const res = await get("/v1/launches/0x000000000000000000000000000000000000dead/candles");
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/launches/:meme/holders", () => {
  test("test_holders_share_and_exclusion", async () => {
    const { body, res } = await json<HoldersPage>(`/v1/launches/${MEME_GRAD}/holders?limit=10`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    expectNum(body.count);
    expectUint(body.circulating);
    expect(body.count).toBe(3);
    expect(body.circulating).toBe(CIRCULATING.toString());
    expect(body.holders.length).toBe(3);
    for (const h of body.holders) expectHolder(h);
    const addrs = body.holders.map((h) => h.address);
    expect(addrs).not.toContain(EXCLUDED);
    expect(addrs).not.toContain(ZERO);
    expect(body.holders[0].address).toBe(HOLDER_A);
    expect(body.holders[0].balance).toBe(HOLDER_A_BAL.toString());
    expect(body.holders[0].shareBps).toBe(Number((HOLDER_A_BAL * 10_000n) / CIRCULATING));
  });

  test("test_holders_uses_live_count_on_mismatch", async () => {
    const { body } = await json<HoldersPage>(`/v1/launches/${MEME_CURVE}/holders`);
    expect(body.count).toBe(1);
  });
});

describe("GET /v1/grants", () => {
  test("test_grants_list_happy", async () => {
    const { body, res } = await json<{ campaigns: GrantCampaign[] }>("/v1/grants");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(body.campaigns.length).toBe(1);
    expectGrantCampaign(body.campaigns[0]);
    expect(body.campaigns[0].meme).toBe(MEME_GRAD);
    expect(body.campaigns[0].status).toBe(3);
  });

  test("test_grants_list_filter_status", async () => {
    const none = await json<{ campaigns: GrantCampaign[] }>("/v1/grants?status=1");
    expect(none.body.campaigns.length).toBe(0);
    const active = await json<{ campaigns: GrantCampaign[] }>("/v1/grants?status=2,3");
    expect(active.body.campaigns.length).toBe(1);
  });
});

describe("GET /v1/grants/:meme", () => {
  test("test_grant_detail_happy", async () => {
    const { body, res } = await json<GrantDetail>(`/v1/grants/${MEME_GRAD}`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=3");
    expectGrantCampaign(body.campaign);
    expect(body.positions.length).toBe(2);
    for (const p of body.positions) expectGrantPosition(p);
    expect(body.positions[0].beneficiary).toBe(LP_1);
    expect(body.positions[0].protocolShareWad).toBe("500000000000000000");
    expect(body.positions[0].exited).toBe(false);
    expect(body.positions[0].exitQuoteToTreasury).toBeNull();
    expect(body.positions[1].exited).toBe(true);
    expect(body.positions[1].protocolShareWad).toBe("499999999999999999");
    expect(body.positions[1].exitQuoteToUser).toBe("7");
    expect(body.positions[1].exitMemeToUser).toBe("2");
    expect(body.positions[1].exitQuoteToTreasury).toBe("4");
    expect(body.positions[1].exitMemeBurned).toBe("100");
    expect(body.campaign.quoteToTreasury).toBe("4");
    expect(body.allocations.length).toBe(2);
    for (const a of body.allocations) expectAllocation(a);
    expect(body.allocations[0].baseAllocation >= body.allocations[1].baseAllocation).toBe(true);
    expect(body.allocations[0].inviteeBoostEarned).toBe("4000");
    expectUint(body.referralCreditsTotal);
    expect(body.referralCreditsTotal).toBe("5000");
    expect(body.dataset.status).toBe("pending");
    expect(body.dataset.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.dataset.accounts).toBe(0);
    expect(body.dataset.checkedAt).toBeNull();
  });

  test("test_grant_detail_reverts_unknown", async () => {
    const res = await get(`/v1/grants/${MEME_CURVE}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/grants/:meme/positions", () => {
  test("test_positions_filter_beneficiary", async () => {
    const all = await json<{ positions: GrantPosition[] }>(`/v1/grants/${MEME_GRAD}/positions`);
    expect(all.body.positions.length).toBe(2);
    for (const p of all.body.positions) expectGrantPosition(p);
    const one = await json<{ positions: GrantPosition[] }>(`/v1/grants/${MEME_GRAD}/positions?beneficiary=${LP_2}`);
    expect(one.body.positions.length).toBe(1);
    expect(one.body.positions[0].beneficiary).toBe(LP_2);
    expect(one.body.positions[0].exited).toBe(true);
  });
});

describe("GET /v1/wallets/:address/roles", () => {
  test("test_roles_admin", async () => {
    const { body, res } = await json<WalletRoles>(`/v1/wallets/${ADMIN}/roles`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expectRoles(body);
    expect(body.isAdmin).toBe(true);
    expect(body.adminRoles).toEqual(["core"]);
    expect(body.creatorOf).toEqual([]);
    expect(body.lpOf).toEqual([]);
  });

  test("test_roles_creator", async () => {
    const { body } = await json<WalletRoles>(`/v1/wallets/${CREATOR_GRAD}/roles`);
    expectRoles(body);
    expect(body.isAdmin).toBe(false);
    expect(body.creatorOf).toEqual([MEME_GRAD]);
  });

  test("test_roles_lp", async () => {
    const { body } = await json<WalletRoles>(`/v1/wallets/${LP_1}/roles`);
    expectRoles(body);
    expect(body.lpOf).toEqual([MEME_GRAD]);
    expect(body.allocatedIn).toEqual([MEME_GRAD]);
  });

  test("test_roles_plain", async () => {
    const { body } = await json<WalletRoles>(`/v1/wallets/${PLAIN}/roles`);
    expectRoles(body);
    expect(body.isAdmin).toBe(false);
    expect(body.creatorOf).toEqual([]);
    expect(body.lpOf).toEqual([]);
    expect(body.allocatedIn).toEqual([]);
    expect(body.inviter).toBeNull();
    expect(body.optInBlock).toBeNull();
  });

  test("test_roles_invitee", async () => {
    const { body } = await json<WalletRoles>(`/v1/wallets/${INVITEE}/roles`);
    expect(body.inviter).toBe(INVITER);
    expect(body.optInBlock).toBe(1006);
  });

  test("test_roles_reverts_bad_address", async () => {
    const res = await get("/v1/wallets/0x123/roles");
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/wallets/:address", () => {
  test("test_wallet_summary_happy", async () => {
    const { body, res } = await json<WalletSummary>(`/v1/wallets/${TRADER}`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expectRoles(body);
    expectNum(body.tradeCount);
    expect(body.tradeCount).toBe(meta.gradTradeCount + meta.curveTradeCount);
    expect(Array.isArray(body.launches)).toBe(true);
    for (const l of body.launches) expectLaunchSummary(l);
    expect(Array.isArray(body.positions)).toBe(true);
    for (const p of body.positions) expectGrantPosition(p);
    expect(Array.isArray(body.recentTrades)).toBe(true);
    expect(body.recentTrades.length).toBe(20);
    for (const t of body.recentTrades) expectTrade(t);
    expect(Array.isArray(body.claims)).toBe(true);
    expect(body.claims.length).toBe(1);
    expectAddr(body.claims[0].meme);
    expect(["quote_rewards", "dev_fees"]).toContain(body.claims[0].kind);
    expectUint(body.claims[0].amount);
    expectNum(body.claims[0].timestamp);
    expectHex(body.claims[0].txHash);
    expectNum(body.inviteeCount);
    expectUint(body.referralCreditsEarned);
    expect(Array.isArray(body.holdings)).toBe(true);
    for (const h of body.holdings) {
      expectLaunchSummary(h.launch);
      expectUint(h.balance);
    }
  });

  test("test_wallet_summary_holdings_priced_before_unpriced", async () => {
    const holder = "0x0000000000000000000000000000000000010bbb";
    const unpriced = "0x0000000000000000000000000000000000010ccc";
    const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    try {
      await db`
        insert into launches (
          chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
          status, created_block, created_log_index, created_tx, created_at
        ) values (
          ${CHAIN}, ${unpriced}, ${hash(0x10ccc)}, ${PLAIN}, ${ZERO}, 18, ${hash(11)}, ${hash(21)},
          1, 4000, 1, ${hash(0x10ccc)}, ${meta.now}
        )
      `;
      await db`
        insert into holder_balances (chain_id, meme, holder, balance, updated_block)
        values
          (${CHAIN}, ${MEME_GRAD}, ${holder}, ${"5000"}, 1900),
          (${CHAIN}, ${unpriced}, ${holder}, ${"999999"}, 4000)
      `;
      const { body } = await json<WalletSummary>(`/v1/wallets/${holder}`);
      expectRoles(body);
      expect(body.holdings.length).toBe(2);
      expect(body.holdings[0].launch.meme).toBe(MEME_GRAD);
      expect(body.holdings[0].balance).toBe("5000");
      expect(typeof body.holdings[0].balance).toBe("string");
      expectLaunchSummary(body.holdings[0].launch);
      expect(body.holdings[1].launch.meme).toBe(unpriced);
      expect(body.holdings[1].balance).toBe("999999");
      expect(typeof body.holdings[1].balance).toBe("string");
      expectLaunchSummary(body.holdings[1].launch);
      expect(body.holdings[1].launch.market.lastPriceQuote).toBeNull();
      expect(body.holdings[1].launch.market.lastPriceMeme).toBeNull();
    } finally {
      await db`delete from holder_balances where chain_id = ${CHAIN} and holder = ${holder}`;
      await db`delete from launches where chain_id = ${CHAIN} and meme = ${unpriced}`;
    }
  });

  test("test_wallet_summary_holdings_skips_zero_and_other_holders", async () => {
    const holder = "0x0000000000000000000000000000000000010bbb";
    const other = "0x0000000000000000000000000000000000010eee";
    const otherMeme = "0x0000000000000000000000000000000000010ddd";
    const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    try {
      await db`
        insert into launches (
          chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
          status, created_block, created_log_index, created_tx, created_at
        ) values (
          ${CHAIN}, ${otherMeme}, ${hash(0x10ddd)}, ${PLAIN}, ${ZERO}, 18, ${hash(11)}, ${hash(21)},
          1, 4001, 1, ${hash(0x10ddd)}, ${meta.now}
        )
      `;
      await db`
        insert into holder_balances (chain_id, meme, holder, balance, updated_block)
        values
          (${CHAIN}, ${MEME_GRAD}, ${holder}, ${"5000"}, 1900),
          (${CHAIN}, ${MEME_CURVE}, ${holder}, ${"0"}, 2000),
          (${CHAIN}, ${otherMeme}, ${other}, ${"888"}, 4001),
          (${CHAIN}, ${MEME_GRAD}, ${other}, ${"777"}, 1900)
      `;
      const { body } = await json<WalletSummary>(`/v1/wallets/${holder}`);
      expect(body.holdings.length).toBe(1);
      expect(body.holdings[0].launch.meme).toBe(MEME_GRAD);
      expect(body.holdings[0].balance).toBe("5000");
      expect(body.holdings.some((h) => h.launch.meme === MEME_CURVE)).toBe(false);
      expect(body.holdings.some((h) => h.launch.meme === otherMeme)).toBe(false);
      expect(body.holdings.some((h) => h.balance === "888" || h.balance === "777")).toBe(false);
    } finally {
      await db`delete from holder_balances where chain_id = ${CHAIN} and (holder = ${holder} or holder = ${other})`;
      await db`delete from launches where chain_id = ${CHAIN} and meme = ${otherMeme}`;
    }
  });

  test("test_wallet_summary_holdings_limit_100", async () => {
    const whale = "0x0000000000000000000000000000000000010aaa";
    try {
      await db`
        insert into launches (
          chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
          status, created_block, created_log_index, created_tx, created_at
        )
        select
          ${CHAIN},
          '0x' || lpad(to_hex(gs.x), 40, '0'),
          '0x' || lpad(to_hex(gs.x), 64, '0'),
          ${PLAIN},
          ${ZERO},
          18,
          '0x' || lpad(to_hex(11), 64, '0'),
          '0x' || lpad(to_hex(21), 64, '0'),
          1,
          3000,
          gs.x,
          '0x' || lpad(to_hex(gs.x), 64, '0'),
          ${meta.now}
        from generate_series(131072, 131172) as gs(x)
      `;
      await db`
        insert into holder_balances (chain_id, meme, holder, balance, updated_block)
        select
          ${CHAIN},
          '0x' || lpad(to_hex(gs.x), 40, '0'),
          ${whale},
          (gs.x - 131071)::numeric,
          3000
        from generate_series(131072, 131172) as gs(x)
      `;
      const { body } = await json<WalletSummary>(`/v1/wallets/${whale}`);
      expect(body.holdings.length).toBe(100);
      for (const h of body.holdings) {
        expectLaunchSummary(h.launch);
        expectUint(h.balance);
      }
    } finally {
      await db`delete from holder_balances where chain_id = ${CHAIN} and holder = ${whale}`;
      await db`delete from launches where chain_id = ${CHAIN} and created_block = 3000`;
    }
  });

  test("test_wallet_summary_inviter_credits", async () => {
    const { body } = await json<WalletSummary>(`/v1/wallets/${INVITER}`);
    expect(body.inviteeCount).toBe(1);
    expect(body.referralCreditsEarned).toBe("5000");
  });

  test("test_wallet_summary_creator_launches", async () => {
    const { body } = await json<WalletSummary>(`/v1/wallets/${CREATOR_CURVE}`);
    expect(body.launches.length).toBe(1);
    expect(body.launches[0].meme).toBe(MEME_CURVE);
  });
});

function newerThan(a: WalletTrade, b: WalletTrade): boolean {
  return a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);
}

describe("GET /v1/wallets/:address/trades", () => {
  test("test_wallet_trades_happy", async () => {
    const { body, res } = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=5");
    expect(body.trades.length).toBe(meta.gradTradeCount + meta.curveTradeCount);
    expect(body.nextCursor).toBeNull();
    for (const t of body.trades) {
      expectTrade(t);
      expectAddr(t.meme);
      expect(t.wallet).toBe(TRADER);
    }
    for (let i = 1; i < body.trades.length; i++) expect(newerThan(body.trades[i - 1], body.trades[i])).toBe(true);
    // one wallet, two memes: the curve launch's trades are the newest (blocks 2000+), then the graduated one's
    expect(body.trades.filter((t) => t.meme === MEME_CURVE).length).toBe(meta.curveTradeCount);
    expect(body.trades.filter((t) => t.meme === MEME_GRAD).length).toBe(meta.gradTradeCount);
    expect(body.trades[0].meme).toBe(MEME_CURVE);
    expect(body.trades[body.trades.length - 1].meme).toBe(MEME_GRAD);
    // pool swaps keep the router they went through; curve trades have none
    const pool = body.trades.filter((t) => t.source === "pool");
    expect(pool.length).toBe(13);
    for (const t of pool) expect(t.router).toBe(ROUTER);
    for (const t of body.trades.filter((t) => t.source === "curve")) expect(t.router).toBeNull();
  });

  test("test_wallet_trades_launches_once_per_meme", async () => {
    const { body } = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades`);
    expect(body.launches.map((l) => l.meme).sort()).toEqual([MEME_CURVE, MEME_GRAD].sort());
    for (const l of body.launches) expectLaunchSummary(l);
    // only the memes on the page: the newest 3 trades are all on the curve launch
    const first = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades?limit=3`);
    expect(first.body.trades.every((t) => t.meme === MEME_CURVE)).toBe(true);
    expect(first.body.launches.map((l) => l.meme)).toEqual([MEME_CURVE]);
  });

  test("test_wallet_trades_pagination", async () => {
    const all = (await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades?limit=200`)).body.trades;
    const seen: WalletTrade[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const before: string = cursor ? `&before=${cursor}` : "";
      const { body } = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades?limit=7${before}`);
      expect(body.trades.length).toBeLessThanOrEqual(7);
      expect(new Set(body.launches.map((l) => l.meme))).toEqual(new Set(body.trades.map((t) => t.meme)));
      seen.push(...body.trades);
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    // 30 trades in pages of 7: 7+7+7+7+2, and the last page carries no cursor
    expect(pages).toBe(5);
    expect(cursor).toBeNull();
    expect(seen.map((t) => t.id)).toEqual(all.map((t) => t.id));
  });

  test("test_wallet_trades_address_case_insensitive", async () => {
    const lower = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades?limit=5`);
    const upper = await json<WalletTradesPage>(`/v1/wallets/0x${TRADER.slice(2).toUpperCase()}/trades?limit=5`);
    expect(upper.body.trades.length).toBe(5);
    expect(upper.body.trades.map((t) => t.id)).toEqual(lower.body.trades.map((t) => t.id));
  });

  test("test_wallet_trades_other_wallets_excluded", async () => {
    const { body } = await json<WalletTradesPage>(`/v1/wallets/${HOLDER_A}/trades`);
    expect(body.trades).toEqual([]);
    expect(body.launches).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  test("test_wallet_trades_includes_hidden_launch", async () => {
    // moderation hides a launch from the site's lists, not from the history of a wallet that traded it
    try {
      await db`
        insert into launch_moderation (chain_id, meme, hidden, media_hidden, updated_by)
        values (${CHAIN}, ${MEME_CURVE}, true, false, ${ADMIN})
      `;
      const { body } = await json<WalletTradesPage>(`/v1/wallets/${TRADER}/trades?limit=3`);
      expect(body.trades.length).toBe(3);
      expect(body.launches.length).toBe(1);
      expect(body.launches[0].meme).toBe(MEME_CURVE);
      expect(body.launches[0].moderation?.hidden).toBe(true);
    } finally {
      await db`delete from launch_moderation where chain_id = ${CHAIN} and meme = ${MEME_CURVE}`;
    }
  });

  test("test_wallet_trades_reverts_bad_address", async () => {
    expect((await get("/v1/wallets/0x123/trades")).status).toBe(400);
  });

  test("test_wallet_trades_reverts_bad_cursor", async () => {
    expect((await get(`/v1/wallets/${TRADER}/trades?before=latest`)).status).toBe(400);
  });

  test("test_wallet_trades_reverts_bad_limit", async () => {
    expect((await get(`/v1/wallets/${TRADER}/trades?limit=0`)).status).toBe(400);
    expect((await get(`/v1/wallets/${TRADER}/trades?limit=201`)).status).toBe(400);
  });
});

describe("GET /v1/stats", () => {
  test("test_stats_happy", async () => {
    const { body, res } = await json<Stats>("/v1/stats");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    expectNum(body.launches);
    expectNum(body.curveActive);
    expectNum(body.graduated);
    expectNum(body.activeGrants);
    expectNum(body.quotes);
    expectNum(body.trades24h);
    expect(Array.isArray(body.volume24hByQuote)).toBe(true);
    expect(body.launches).toBe(2);
    expect(body.curveActive).toBe(1);
    expect(body.graduated).toBe(1);
    expect(body.activeGrants).toBe(1);
    expect(body.quotes).toBe(2);
    expect(body.trades24h).toBe(17);
    expect(body.volume24hByQuote.length).toBe(2);
    for (const v of body.volume24hByQuote) {
      expectAddr(v.quote);
      expect(typeof v.symbol).toBe("string");
      expectUint(v.volume);
    }
    const byQuote = Object.fromEntries(body.volume24hByQuote.map((v) => [v.quote, v]));
    expect(byQuote[WOKB].volume).toBe("10000");
    expect(byQuote[ZERO].volume).toBe("700");
  });
});
