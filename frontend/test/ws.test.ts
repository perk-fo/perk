import { describe, expect, test } from "bun:test";
import { mergeTrades, PerkSocket, reconnectDelay, wsUrl } from "@/lib/ws";
import type { Trade, WsServerMessage } from "@/lib/api-types";

const MEME = "0x00000000000000000000000000000000000000aa" as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trade(block: number, logIndex = 0): Trade {
  return {
    id: `0x${block}:${logIndex}`, txHash: "0x01", logIndex, blockNumber: block, timestamp: block, side: "buy", source: "curve",
    wallet: "0x0000000000000000000000000000000000000001", router: null, quoteAmount: "1", memeAmount: "1", fee: null,
    priceQuote: "1", priceMeme: "1", price: 1,
  };
}

/** In-memory stand-in for a browser WebSocket; the test drives open / message / close. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  push(m: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
}

function socket(extra: Partial<ConstructorParameters<typeof PerkSocket>[0]> = {}) {
  FakeSocket.all = [];
  return new PerkSocket({ url: "ws://x/v1/ws", create: (u) => new FakeSocket(u), delay: () => 5, idleCloseMs: 20, ...extra });
}

describe("pure helpers", () => {
  test("reconnectDelay grows exponentially, caps at 15 s, jitters 50–100%", () => {
    expect(reconnectDelay(0, () => 1)).toBe(500);
    expect(reconnectDelay(0, () => 0)).toBe(250);
    expect(reconnectDelay(3, () => 1)).toBe(4000);
    expect(reconnectDelay(20, () => 1)).toBe(15_000);
  });
  test("wsUrl maps http(s) to ws(s)", () => {
    expect(wsUrl("http://localhost:8787")).toBe("ws://localhost:8787/v1/ws");
    expect(wsUrl("https://api.perk.xyz")).toBe("wss://api.perk.xyz/v1/ws");
  });
  test("mergeTrades dedupes, orders newest first, caps", () => {
    const merged = mergeTrades([trade(5), trade(3)], [trade(7), trade(5), trade(6, 1)], 3);
    expect(merged.map((t) => t.blockNumber)).toEqual([7, 6, 5]);
  });
});

describe("PerkSocket", () => {
  test("connects lazily and sends the subscription on open", () => {
    const s = socket();
    expect(FakeSocket.all).toHaveLength(0);
    s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: MEME }, onMessage: () => {} });
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0].open();
    expect(FakeSocket.all[0].sent).toEqual([{ op: "subscribe", topic: "trades", meme: MEME }]);
    expect(s.status).toBe("open");
    s.shutdown();
  });

  test("routes trades to the matching subscriber only", () => {
    const s = socket();
    const got: WsServerMessage[] = [];
    const other: WsServerMessage[] = [];
    s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: MEME }, onMessage: (m) => got.push(m) });
    s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: "0x00000000000000000000000000000000000000bb" }, onMessage: (m) => other.push(m) });
    FakeSocket.all[0].open();
    FakeSocket.all[0].push({ type: "trades", meme: MEME, trades: [trade(1)], cursorBlock: 1 });
    expect(got).toHaveLength(1);
    expect(other).toHaveLength(0);
    s.shutdown();
  });

  test("reconnects after a drop, re-subscribes, and asks subscribers to resync", async () => {
    const s = socket();
    let resyncs = 0;
    s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: MEME }, onMessage: () => {}, onResync: () => resyncs++ });
    FakeSocket.all[0].open();
    expect(resyncs).toBe(0); // first open is not a resync
    FakeSocket.all[0].drop();
    expect(s.status).toBe("closed");
    await sleep(20);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1].open();
    expect(FakeSocket.all[1].sent).toEqual([{ op: "subscribe", topic: "trades", meme: MEME }]);
    expect(resyncs).toBe(1);
    s.shutdown();
  });

  test("keeps retrying while the server is down", async () => {
    const s = socket();
    s.subscribe({ msg: { op: "subscribe", topic: "health" }, onMessage: () => {} });
    FakeSocket.all[0].drop();
    await sleep(20);
    FakeSocket.all[1].drop();
    await sleep(20);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(3);
    s.shutdown();
  });

  test("a silent socket is declared dead and replaced", async () => {
    const s = socket({ pingMs: 10, deadMs: 25 });
    s.subscribe({ msg: { op: "subscribe", topic: "health" }, onMessage: () => {} });
    FakeSocket.all[0].open();
    await sleep(80);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(FakeSocket.all.length).toBeGreaterThanOrEqual(2);
    s.shutdown();
  });

  test("pings while healthy", async () => {
    const s = socket({ pingMs: 10, deadMs: 1000 });
    s.subscribe({ msg: { op: "subscribe", topic: "health" }, onMessage: () => {} });
    FakeSocket.all[0].open();
    await sleep(35);
    expect(FakeSocket.all[0].sent.filter((m) => (m as { op: string }).op === "ping").length).toBeGreaterThanOrEqual(2);
    s.shutdown();
  });

  test("shared topic: one subscribe frame, unsubscribe only after the last listener leaves, idle close", async () => {
    const s = socket();
    const a = s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: MEME }, onMessage: () => {} });
    FakeSocket.all[0].open();
    const b = s.subscribe({ msg: { op: "subscribe", topic: "trades", meme: MEME }, onMessage: () => {} });
    expect(FakeSocket.all[0].sent).toHaveLength(1);
    a();
    expect(FakeSocket.all[0].sent).toHaveLength(1);
    b();
    expect(FakeSocket.all[0].sent.at(-1)).toEqual({ op: "unsubscribe", topic: "trades", meme: MEME });
    await sleep(40);
    expect(FakeSocket.all[0].closed).toBe(true);
    expect(s.status).toBe("idle");
  });
});
