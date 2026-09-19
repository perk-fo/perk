/**
 * Live push from the Perk API over WebSocket (/v1/ws, protocol in api-types WsClientMessage / WsServerMessage).
 *
 * REST stays the source of truth. The socket only speeds things up, and a gap is always repaired over REST:
 *   - one shared connection per tab, opened lazily on the first subscription and closed 15 s after the last one;
 *   - reconnect with exponential backoff + jitter (0.5 s → 15 s), immediately on `online` / tab becoming visible;
 *   - heartbeat: ping every 20 s; if nothing arrives for 45 s the socket is treated as dead and replaced;
 *   - on every (re)open all subscriptions are re-sent, and `onResync` fires on each subscriber after a *re*connect
 *     so it can re-fetch what it missed while offline (the server does not replay).
 */
import type { Trade, WsClientMessage, WsServerMessage } from "./api-types";
import { API_URL } from "./api";

export type WsStatus = "idle" | "connecting" | "open" | "closed";

/** Backoff before reconnect attempt `attempt` (0-based): 500 ms · 2^attempt capped at 15 s, scaled by 50–100% jitter. */
export function reconnectDelay(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.5 + rand() * 0.5));
}

/** Merge pushed trades into a newest-first list: dedupe by id, keep newest first, cap at `limit`. */
export function mergeTrades(existing: Trade[], incoming: Trade[], limit: number): Trade[] {
  const seen = new Set<string>();
  const out: Trade[] = [];
  for (const t of [...incoming, ...existing]) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  out.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  return out.slice(0, limit);
}

export function wsUrl(apiUrl: string = API_URL): string {
  return `${apiUrl.replace(/^http/, "ws")}/v1/ws`;
}

interface Sub {
  key: string; // "trades:<meme>" | "health"
  msg: WsClientMessage;
  onMessage: (m: WsServerMessage) => void;
  onResync?: () => void;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "readyState"> & {
  onopen: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
};

export interface PerkSocketOptions {
  url?: string;
  create?: (url: string) => SocketLike;
  pingMs?: number;
  deadMs?: number;
  idleCloseMs?: number;
  /** Backoff schedule; defaults to reconnectDelay. */
  delay?: (attempt: number) => number;
  /** Window-like target for `online` / `visibilitychange`; omitted in tests. */
  env?: { addEventListener: (type: string, fn: () => void) => void; isVisible: () => boolean } | null;
}

export class PerkSocket {
  status: WsStatus = "idle";
  private ws: SocketLike | null = null;
  private subs = new Set<Sub>();
  private attempt = 0;
  private everOpened = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeen = 0;
  private pingId = 0;
  private statusListeners = new Set<() => void>();
  private readonly url: string;
  private readonly create: (url: string) => SocketLike;
  private readonly pingMs: number;
  private readonly deadMs: number;
  private readonly idleCloseMs: number;
  private readonly delay: (attempt: number) => number;

  constructor(opts: PerkSocketOptions = {}) {
    this.url = opts.url ?? wsUrl();
    this.create = opts.create ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.pingMs = opts.pingMs ?? 20_000;
    this.deadMs = opts.deadMs ?? 45_000;
    this.idleCloseMs = opts.idleCloseMs ?? 15_000;
    this.delay = opts.delay ?? ((a) => reconnectDelay(a));
    const env = opts.env;
    if (env) {
      const kick = () => {
        if (this.subs.size > 0 && this.status !== "open" && this.status !== "connecting") this.connectNow();
      };
      env.addEventListener("online", kick);
      env.addEventListener("visibilitychange", () => env.isVisible() && kick());
    }
  }

  /** Subscribe; returns the unsubscribe function. */
  subscribe(sub: Omit<Sub, "key">): () => void {
    const entry: Sub = { ...sub, key: keyOf(sub.msg) };
    this.subs.add(entry);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.status === "open") {
      if (this.countKey(entry.key) === 1) this.send(entry.msg);
    } else if (this.status === "idle" || this.status === "closed") {
      if (!this.retryTimer) this.connectNow();
    }
    return () => {
      if (!this.subs.delete(entry)) return;
      if (this.status === "open" && this.countKey(entry.key) === 0) this.send(unsubscribeOf(entry.msg));
      if (this.subs.size === 0) this.idleTimer = setTimeout(() => this.shutdown(), this.idleCloseMs);
    };
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Close for good (tests / page teardown). */
  shutdown(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
    this.setStatus("idle");
  }

  private connectNow(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.setStatus("connecting");
    let ws: SocketLike;
    try {
      ws = this.create(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      this.lastSeen = Date.now();
      this.setStatus("open");
      const sent = new Set<string>();
      for (const s of this.subs) {
        if (sent.has(s.key)) continue;
        sent.add(s.key);
        this.send(s.msg);
      }
      if (reconnected) for (const s of this.subs) s.onResync?.();
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastSeen > this.deadMs) {
          ws.close(); // onclose schedules the reconnect
          return;
        }
        this.send({ op: "ping", id: ++this.pingId });
      }, this.pingMs);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastSeen = Date.now();
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as WsServerMessage;
      } catch {
        return;
      }
      const key = msg.type === "trades" ? `trades:${msg.meme.toLowerCase()}` : msg.type === "health" ? "health" : null;
      if (!key) return;
      for (const s of this.subs) if (s.key === key) s.onMessage(msg);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.subs.size === 0) {
        this.setStatus("idle");
        return;
      }
      this.setStatus("closed");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = this.delay(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.subs.size > 0) this.connectNow();
    }, delay);
  }

  private send(msg: WsClientMessage): void {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  private countKey(key: string): number {
    let n = 0;
    for (const s of this.subs) if (s.key === key) n++;
    return n;
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.pingTimer = this.retryTimer = this.idleTimer = null;
  }

  private setStatus(s: WsStatus): void {
    if (this.status === s) return;
    this.status = s;
    for (const fn of this.statusListeners) fn();
  }
}

function keyOf(msg: WsClientMessage): string {
  return "meme" in msg ? `trades:${msg.meme.toLowerCase()}` : msg.op === "ping" ? "ping" : "health";
}

function unsubscribeOf(msg: WsClientMessage): WsClientMessage {
  if ("meme" in msg) return { op: "unsubscribe", topic: "trades", meme: msg.meme };
  return { op: "unsubscribe", topic: "health" };
}

let shared: PerkSocket | null = null;
/** The tab's shared socket (browser only). */
export function perkSocket(): PerkSocket {
  if (!shared) {
    shared = new PerkSocket({
      env:
        typeof window === "undefined"
          ? null
          : {
              addEventListener: (type, fn) =>
                (type === "visibilitychange" ? document : window).addEventListener(type, fn),
              isVisible: () => document.visibilityState === "visible",
            },
    });
  }
  return shared;
}
