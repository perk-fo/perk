import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import type { Db } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { createApp } from "../src/api/server";
import { createWsHub } from "../src/api/ws";
import type { Health, Trade, WsServerMessage } from "../src/api/types";
import { initSyncState, recordHead } from "../src/sync/state";
import type { SyncNotice } from "../src/sync/notify";
import { CHAIN, makeTestApp, MEME_CURVE, MEME_GRAD, resetDb, testConfig, TRADER } from "./api-helpers";

let db: Db;

const ALLOWED_ORIGIN = "http://localhost:3000";
const OTHER_MEME = "0x0000000000000000000000000000000000000c99" as Address;

function h32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function tx(n: number): Hex {
  return h32(0x20000 + n);
}

function addrN(n: number): Address {
  return `0x${n.toString(16).padStart(40, "0")}` as Address;
}

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/ws`;
}

function servePort(server: { port: number | undefined }): number {
  if (server.port === undefined) throw new Error("server.port is undefined");
  return server.port;
}

function openWs(port: number, origin = ALLOWED_ORIGIN): WebSocket {
  return new WebSocket(wsUrl(port), { headers: { Origin: origin } } as unknown as string[]);
}

function parseMsg(ev: MessageEvent): WsServerMessage {
  return JSON.parse(String(ev.data)) as WsServerMessage;
}

function collect(ws: WebSocket): WsServerMessage[] {
  const out: WsServerMessage[] = [];
  ws.addEventListener("message", (ev) => out.push(parseMsg(ev)));
  return out;
}

async function waitFor(
  inbox: WsServerMessage[],
  pred: (m: WsServerMessage) => boolean,
  timeoutMs = 2000,
): Promise<WsServerMessage> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const hit = inbox.find(pred);
    if (hit) return hit;
    await Bun.sleep(10);
  }
  throw new Error(`timeout waiting for ws message: ${JSON.stringify(inbox)}`);
}

async function waitOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("ws open timeout")), 2000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    });
  });
}

async function insertLaunch(meme: Address): Promise<void> {
  await db`
    insert into launches (
      chain_id, meme, launch_id, creator, quote, template_id, config_hash,
      name, symbol, created_block, created_log_index, created_tx, created_at
    ) values (
      ${CHAIN}, ${meme}, ${h32(1)}, ${TRADER}, ${"0x0000000000000000000000000000000000000000"},
      ${h32(11)}, ${h32(21)}, 'T', 'T', 1000, 0, ${tx(1)}, 1700000000
    )
    on conflict (chain_id, meme) do nothing
  `;
}

async function insertTrade(opts: {
  meme: Address;
  block: number;
  log: number;
  quote: bigint;
  memeAmt: bigint;
  price: number;
}): Promise<void> {
  await db`
    insert into trades (
      chain_id, tx_hash, log_index, meme, block_number, ts, side, source, wallet, router,
      quote_amount, meme_amount, fee, price_quote, price_meme, price
    ) values (
      ${CHAIN}, ${tx(opts.block * 100 + opts.log)}, ${opts.log}, ${opts.meme}, ${opts.block}, ${1700000000 + opts.block},
      'buy', 'curve', ${TRADER}, null, ${opts.quote.toString()}, ${opts.memeAmt.toString()}, ${"1"},
      ${opts.quote.toString()}, ${opts.memeAmt.toString()}, ${opts.price}
    )
  `;
}

describe("websocket", () => {
  beforeAll(async () => {
    db = await resetDb();
  });
  beforeEach(async () => {
    await db.unsafe("drop schema public cascade; create schema public;");
    await migrate(db);
    await initSyncState(db, CHAIN, 1000n);
    await recordHead(db, CHAIN, 1100n, 1_700_001_100n);
  });
  afterAll(async () => {
    await db.end({ timeout: 5 });
  });

  test("test_ws_hello_subscribe_ping", async () => {
    const config = testConfig({ corsOrigins: [ALLOWED_ORIGIN] });
    const hub = createWsHub({ db, config });
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        const u = hub.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return new Response("no", { status: 404 });
      },
      websocket: hub.websocket,
    });
    await hub.start(server);
    const ws = openWs(servePort(server));
    const inbox = collect(ws);
    try {
      await waitOpen(ws);
      const hello = await waitFor(inbox, (m) => m.type === "hello");
      expect(hello.type).toBe("hello");
      if (hello.type === "hello") {
        expect(hello.chainId).toBe(CHAIN);
        expect(hello.cursorBlock).toBe(999);
      }

      ws.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: MEME_CURVE }));
      const sub = await waitFor(inbox, (m) => m.type === "subscribed");
      expect(sub).toMatchObject({ type: "subscribed", topic: "trades", meme: MEME_CURVE });

      ws.send(JSON.stringify({ op: "ping", id: 7 }));
      const pong = await waitFor(inbox, (m) => m.type === "pong");
      expect(pong).toMatchObject({ type: "pong", id: 7 });
    } finally {
      ws.close();
      await hub.stop();
      server.stop(true);
    }
  });

  test("test_ws_handleNotice_trades_newest_first_and_isolated", async () => {
    const config = testConfig({ corsOrigins: [ALLOWED_ORIGIN] });
    const app = createApp({ db, config });
    const hub = createWsHub({ db, config });
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        const u = hub.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return app.fetch(req);
      },
      websocket: hub.websocket,
    });
    await hub.start(server);

    await insertLaunch(MEME_CURVE);
    await insertLaunch(MEME_GRAD);
    await insertTrade({ meme: MEME_CURVE, block: 2001, log: 0, quote: 10n, memeAmt: 100n, price: 0.1 });
    await insertTrade({ meme: MEME_CURVE, block: 2002, log: 1, quote: 20n, memeAmt: 50n, price: 0.4 });
    await insertTrade({ meme: MEME_GRAD, block: 2002, log: 0, quote: 99n, memeAmt: 1n, price: 99 });

    const a = openWs(servePort(server));
    const b = openWs(servePort(server));
    const inboxA = collect(a);
    const inboxB = collect(b);
    try {
      await waitOpen(a);
      await waitOpen(b);
      await waitFor(inboxA, (m) => m.type === "hello");
      await waitFor(inboxB, (m) => m.type === "hello");
      a.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: MEME_CURVE }));
      b.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: OTHER_MEME }));
      await waitFor(inboxA, (m) => m.type === "subscribed");
      await waitFor(inboxB, (m) => m.type === "subscribed");

      const notice: SyncNotice = { chainId: CHAIN, fromBlock: 2001, toBlock: 2002, memes: [MEME_CURVE] };
      await hub.handleNotice(notice);

      const tradesMsg = await waitFor(inboxA, (m) => m.type === "trades");
      expect(tradesMsg.type).toBe("trades");
      if (tradesMsg.type !== "trades") throw new Error("unreachable");
      expect(tradesMsg.meme).toBe(MEME_CURVE);
      expect(tradesMsg.trades.map((t) => t.blockNumber)).toEqual([2002, 2001]);

      const rest = await app.request(`/v1/launches/${MEME_CURVE}/trades?limit=50`);
      const page = (await rest.json()) as { trades: Trade[] };
      const restInRange = page.trades.filter((t) => t.blockNumber >= 2001 && t.blockNumber <= 2002);
      expect(tradesMsg.trades).toEqual(restInRange);

      await Bun.sleep(100);
      expect(inboxB.some((m) => m.type === "trades")).toBe(false);
    } finally {
      a.close();
      b.close();
      await hub.stop();
      server.stop(true);
    }
  });

  test("test_ws_unsubscribe_bad_message_bad_address_too_many", async () => {
    const config = testConfig({ corsOrigins: [ALLOWED_ORIGIN] });
    const hub = createWsHub({ db, config });
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        const u = hub.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return new Response("no", { status: 404 });
      },
      websocket: hub.websocket,
    });
    await hub.start(server);
    const ws = openWs(servePort(server));
    const inbox = collect(ws);
    try {
      await waitOpen(ws);
      await waitFor(inbox, (m) => m.type === "hello");

      ws.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: MEME_CURVE }));
      await waitFor(inbox, (m) => m.type === "subscribed");
      ws.send(JSON.stringify({ op: "unsubscribe", topic: "trades", meme: MEME_CURVE }));
      await waitFor(inbox, (m) => m.type === "unsubscribed");

      await insertLaunch(MEME_CURVE);
      await insertTrade({ meme: MEME_CURVE, block: 2100, log: 0, quote: 1n, memeAmt: 1n, price: 1 });
      const before = inbox.length;
      await hub.handleNotice({ chainId: CHAIN, fromBlock: 2100, toBlock: 2100, memes: [MEME_CURVE] });
      await Bun.sleep(150);
      expect(inbox.slice(before).some((m) => m.type === "trades")).toBe(false);

      ws.send("not-json");
      const bad = await waitFor(inbox, (m) => m.type === "error" && m.error === "bad_message");
      expect(bad).toMatchObject({ type: "error", error: "bad_message" });
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: "not-an-address" }));
      await waitFor(inbox, (m) => m.type === "error" && m.error === "bad_address");

      for (let i = 1; i <= 20; i++) {
        ws.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: addrN(i) }));
        await waitFor(inbox, (m) => m.type === "subscribed" && m.topic === "trades" && m.meme === addrN(i));
      }
      ws.send(JSON.stringify({ op: "subscribe", topic: "trades", meme: addrN(21) }));
      await waitFor(inbox, (m) => m.type === "error" && m.error === "too_many_subscriptions");
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
      await hub.stop();
      server.stop(true);
    }
  });

  test("test_ws_origin_forbidden_and_allowed", async () => {
    const config = testConfig({ corsOrigins: [ALLOWED_ORIGIN] });
    const hub = createWsHub({ db, config });
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        const u = hub.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return new Response("no", { status: 404 });
      },
      websocket: hub.websocket,
    });
    await hub.start(server);
    try {
      const forbidden = await fetch(`http://127.0.0.1:${servePort(server)}/v1/ws`, {
        headers: { Origin: "http://evil.example" },
      });
      expect(forbidden.status).toBe(403);

      const ws = openWs(servePort(server), ALLOWED_ORIGIN);
      const inbox = collect(ws);
      await waitOpen(ws);
      await waitFor(inbox, (m) => m.type === "hello");
      ws.close();
    } finally {
      await hub.stop();
      server.stop(true);
    }
  });

  test("test_ws_health_push_within_interval", async () => {
    const config = testConfig({ corsOrigins: [ALLOWED_ORIGIN] });
    const hub = createWsHub({ db, config }, { healthEveryMs: 50 });
    const server = Bun.serve({
      port: 0,
      fetch: (req, srv) => {
        const u = hub.upgrade(req, srv);
        if (u === true) return undefined;
        if (u) return u;
        return new Response("no", { status: 404 });
      },
      websocket: hub.websocket,
    });
    await hub.start(server);
    const ws = openWs(servePort(server));
    const inbox = collect(ws);
    try {
      await waitOpen(ws);
      await waitFor(inbox, (m) => m.type === "hello");
      ws.send(JSON.stringify({ op: "subscribe", topic: "health" }));
      await waitFor(inbox, (m) => m.type === "subscribed" && m.topic === "health");
      const health = await waitFor(inbox, (m) => m.type === "health", 500);
      expect(health.type).toBe("health");
      if (health.type === "health") {
        expect(health.health.mode === "live" || health.health.mode === "catchup").toBe(true);
        expect(health.health.chainId).toBe(CHAIN);
      }
    } finally {
      ws.close();
      await hub.stop();
      server.stop(true);
    }
  });

  test("test_health_route_includes_mode", async () => {
    const { app } = makeTestApp(db, { catchupBlocks: 200 });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body.mode).toBe("live");
  });
});
