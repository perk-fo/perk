import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Address } from "./types";
import type { ApiDeps } from "./server";
import type { SyncNotice } from "../sync/notify";
import type { WsClientMessage, WsServerMessage } from "./types";
import { listenSync } from "../sync/notify";
import { readSyncState } from "../sync/state";
import { buildHealth } from "./routes/health";
import { selectTradesInRange } from "./queries";
import { mapTrade } from "./mappers";

/**
 * WebSocket push at GET /v1/ws (protocol: WsClientMessage / WsServerMessage in ./types).
 *
 * - Uses Bun's native pub/sub: a connection subscribes to `trades:<meme>` / `health`; pushes go through
 *   server.publish so fan-out cost does not grow with our code.
 * - New trades: listenSync(SYNC_CHANNEL) → for each meme in the notice that has subscribers
 *   (server.subscriberCount(topic) > 0), select that meme's trades with block_number in [fromBlock, toBlock]
 *   (add `selectTradesInRange` to queries.ts), map with mapTrade, publish one `trades` message (newest first).
 *   A notice with memes: [] (payload overflow) or a LISTEN reconnect → do this for every subscribed meme over
 *   [lastPushedBlock + 1, cursorBlock].
 * - Health: every `healthEveryMs` while `health` has subscribers, publish buildHealth() (routes/health.ts).
 * - Connection hygiene: idleTimeout 60 s with Bun's automatic pings; frames > 4 KiB close with 1009; bad JSON or an
 *   unknown op → `error` message (connection stays open); at most `maxSubscriptions` trade topics per connection;
 *   at most `maxClients` connections (extra upgrades get HTTP 503).
 * - Origin: when the request has an Origin header and config.corsOrigins does not contain it (nor "*"), refuse
 *   the upgrade with HTTP 403.
 */
export interface WsData {
  id: number;
  memes: Set<string>;
  health: boolean;
}

export interface WsHubOptions {
  healthEveryMs?: number; // default 5000
  maxSubscriptions?: number; // default 20
  maxClients?: number; // default 2000
}

export interface WsHub {
  /** Pass as Bun.serve({ websocket }). */
  websocket: WebSocketHandler<WsData>;
  /**
   * Call first in Bun.serve's fetch. Returns a Response to send (403 / 503 / 426), `true` when the request was upgraded
   * (fetch must then return undefined), or `false` when the request is not for /v1/ws (fall through to Hono).
   */
  upgrade(req: Request, server: Server<WsData>): Response | boolean;
  /** Begin LISTEN + the health ticker. Needs the server for publish; call once after Bun.serve. */
  start(server: Server<WsData>): Promise<void>;
  stop(): Promise<void>;
  /** Exposed for tests: process a notice exactly as if it had arrived over LISTEN. */
  handleNotice(n: SyncNotice): Promise<void>;
  stats(): { clients: number; tradeTopics: number };
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEALTH_TOPIC = "health";
const MAX_FRAME = 4096;

function tradesTopic(meme: string): string {
  return `trades:${meme}`;
}

function send(ws: ServerWebSocket<WsData>, msg: WsServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket already closing
  }
}

function sendError(
  ws: ServerWebSocket<WsData>,
  error: Extract<WsServerMessage, { type: "error" }>["error"],
  message: string,
): void {
  send(ws, { type: "error", error, message });
}

export function createWsHub(deps: ApiDeps, opts: WsHubOptions = {}): WsHub {
  const { db, config } = deps;
  const healthEveryMs = opts.healthEveryMs ?? 5000;
  const maxSubscriptions = opts.maxSubscriptions ?? 20;
  const maxClients = opts.maxClients ?? 2000;

  let liveServer: Server<WsData> | null = null;
  let clients = 0;
  let nextId = 1;
  const topicCounts = new Map<string, number>();
  const lastPushedBlock = new Map<string, number>();
  let listenHandle: { unlisten: () => Promise<void> } | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  function attach(server: Server<WsData>): void {
    liveServer = server;
  }

  function bumpTopic(meme: string, delta: number): void {
    const n = (topicCounts.get(meme) ?? 0) + delta;
    if (n <= 0) topicCounts.delete(meme);
    else topicCounts.set(meme, n);
  }

  async function publishHealth(): Promise<void> {
    if (!liveServer || liveServer.subscriberCount(HEALTH_TOPIC) === 0) return;
    const health = await buildHealth(db, config);
    liveServer.publish(HEALTH_TOPIC, JSON.stringify({ type: "health", health } satisfies WsServerMessage));
  }

  async function pushMeme(meme: string, fromBlock: number, toBlock: number): Promise<void> {
    if (!liveServer || liveServer.subscriberCount(tradesTopic(meme)) === 0) return;
    const rows = await selectTradesInRange(db, config.chainId, meme, fromBlock, toBlock);
    // only the newest 500 of a huge catch-up window are sent; clients keep the newest N anyway
    if (rows.length > 0) {
      const payload: WsServerMessage = { type: "trades", meme: meme as Address, trades: rows.map(mapTrade), cursorBlock: toBlock };
      liveServer.publish(tradesTopic(meme), JSON.stringify(payload));
    }
    lastPushedBlock.set(meme, Math.max(lastPushedBlock.get(meme) ?? 0, toBlock));
  }

  async function pushGapToCursor(memes: Iterable<string>): Promise<void> {
    const state = await readSyncState(db, config.chainId);
    if (!state) return;
    const cursorBlock = Number(state.cursorBlock);
    for (const meme of memes) {
      const last = lastPushedBlock.get(meme);
      const fromBlock = last === undefined ? cursorBlock + 1 : last + 1;
      if (fromBlock > cursorBlock) continue;
      await pushMeme(meme, fromBlock, cursorBlock);
    }
  }

  /**
   * Notices and reconnect gap-fills run strictly one after another: processed concurrently, a slower earlier window
   * could publish after a later one and a gap-fill could read lastPushedBlock mid-update.
   */
  let queue: Promise<void> = Promise.resolve();
  function enqueue(job: () => Promise<void>): Promise<void> {
    queue = queue.then(job).catch((err) => console.error("[ws] push failed", err));
    return queue;
  }

  async function processNotice(n: SyncNotice): Promise<void> {
    if (n.chainId !== config.chainId) return;
    if (n.memes.length === 0) {
      await pushGapToCursor([...topicCounts.keys()]);
      return;
    }
    for (const raw of n.memes) {
      await pushMeme(raw.toLowerCase(), n.fromBlock, n.toBlock);
    }
  }

  function handleNotice(n: SyncNotice): Promise<void> {
    return enqueue(() => processNotice(n));
  }

  const websocket: WebSocketHandler<WsData> = {
    idleTimeout: 60,
    maxPayloadLength: MAX_FRAME,
    sendPings: true,
    open: (ws) => {
      clients++;
      void (async () => {
        const state = await readSyncState(db, config.chainId);
        send(ws, {
          type: "hello",
          chainId: config.chainId,
          serverTime: Math.floor(Date.now() / 1000),
          cursorBlock: state ? Number(state.cursorBlock) : 0,
        });
      })();
    },
    close: (ws) => {
      clients = Math.max(0, clients - 1);
      for (const meme of ws.data.memes) bumpTopic(meme, -1);
      ws.data.memes.clear();
      ws.data.health = false;
    },
    message: (ws, raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        sendError(ws, "bad_message", "invalid JSON");
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("op" in parsed) || typeof (parsed as { op: unknown }).op !== "string") {
        sendError(ws, "bad_message", "invalid message");
        return;
      }
      const msg = parsed as WsClientMessage & { op: string; topic?: string; meme?: string; id?: number };

      if (msg.op === "ping") {
        send(ws, { type: "pong", id: msg.id, serverTime: Math.floor(Date.now() / 1000) });
        return;
      }

      if (msg.op === "subscribe" && msg.topic === "health") {
        if (!ws.data.health) {
          ws.subscribe(HEALTH_TOPIC);
          ws.data.health = true;
        }
        send(ws, { type: "subscribed", topic: "health" });
        void publishHealth();
        return;
      }

      if (msg.op === "unsubscribe" && msg.topic === "health") {
        if (ws.data.health) {
          ws.unsubscribe(HEALTH_TOPIC);
          ws.data.health = false;
        }
        send(ws, { type: "unsubscribed", topic: "health" });
        return;
      }

      if ((msg.op === "subscribe" || msg.op === "unsubscribe") && msg.topic === "trades") {
        const memeRaw = msg.meme;
        if (typeof memeRaw !== "string" || !ADDRESS_RE.test(memeRaw)) {
          sendError(ws, "bad_address", "meme must be a 0x address");
          return;
        }
        const meme = memeRaw.toLowerCase();
        if (msg.op === "subscribe") {
          if (!ws.data.memes.has(meme) && ws.data.memes.size >= maxSubscriptions) {
            sendError(ws, "too_many_subscriptions", `at most ${maxSubscriptions} trade subscriptions`);
            return;
          }
          if (!ws.data.memes.has(meme)) {
            ws.data.memes.add(meme);
            ws.subscribe(tradesTopic(meme));
            bumpTopic(meme, 1);
          }
          send(ws, { type: "subscribed", topic: "trades", meme: meme as Address });
          return;
        }
        if (ws.data.memes.delete(meme)) {
          ws.unsubscribe(tradesTopic(meme));
          bumpTopic(meme, -1);
        }
        send(ws, { type: "unsubscribed", topic: "trades", meme: meme as Address });
        return;
      }

      sendError(ws, "bad_message", "unknown op");
    },
  };

  return {
    websocket,
    upgrade(req, server) {
      attach(server);
      const url = new URL(req.url);
      if (url.pathname !== "/v1/ws") return false;
      const origin = req.headers.get("Origin");
      if (origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (clients >= maxClients) {
        return new Response("Service Unavailable", { status: 503 });
      }
      const ok = server.upgrade(req, {
        data: { id: nextId++, memes: new Set<string>(), health: false },
      });
      if (!ok) return new Response("Upgrade Required", { status: 426 });
      return true;
    },
    async start(server) {
      attach(server);
      if (started) return;
      started = true;
      listenHandle = await listenSync(
        db,
        config.chainId,
        (n) => void handleNotice(n),
        () => void enqueue(() => pushGapToCursor([...topicCounts.keys()])),
      );
      healthTimer = setInterval(() => void publishHealth(), healthEveryMs);
    },
    async stop() {
      started = false;
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      if (listenHandle) {
        await listenHandle.unlisten();
        listenHandle = null;
      }
    },
    handleNotice,
    stats() {
      return { clients, tradeTopics: topicCounts.size };
    },
  };
}
