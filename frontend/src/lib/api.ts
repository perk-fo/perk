import { isAddress } from "viem";
import type {
  AdminAuditEntry,
  AdminLaunch,
  AdminMe,
  AdminNonce,
  AdminOperator,
  AdminSession,
  ModerationUpdate,
  QuoteAsset,
  QuoteDisplayUpdate,
  GrantAllocationProof,
  Candle,
  CandleInterval,
  GrantCampaign,
  GrantDetail,
  GrantPosition,
  Health,
  HoldersPage,
  LaunchDetail,
  LaunchSummary,
  Stats,
  TradesPage,
  WalletRoles,
  WalletSummary,
  WalletTradesPage,
  LpPosition,
  Prices,
} from "./api-types";

/** Base URL of @perk/api. The browser talks only to this service plus the public RPC; never to Alchemy. */
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * An address as a URL path segment. Paths are built from route parameters and form input, so anything that is not a
 * 0x address is refused before a request is made (the API would answer 400 bad_address anyway), and the segment is
 * percent-encoded so no value can add path segments, a query or a fragment to the request.
 */
export function addressSegment(value: string): string {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new ApiRequestError(400, "bad_address", "not a 0x address");
  }
  return encodeURIComponent(value);
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  return request<T>("GET", path, { params });
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { params?: Record<string, string | number | undefined>; body?: unknown; token?: string } = {},
): Promise<T> {
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "omit",
    });
  } catch (err) {
    throw new ApiRequestError(0, "unreachable", err instanceof Error ? err.message : "network error");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.error) code = body.error;
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => get<Health>("/health"),
  stats: () => get<Stats>("/v1/stats"),
  launches: (params: { status?: string; quote?: string; creator?: string; sort?: string; limit?: number; offset?: number } = {}) =>
    get<{ launches: LaunchSummary[]; total: number }>("/v1/launches", params),
  launch: async (meme: string) => get<LaunchDetail>(`/v1/launches/${addressSegment(meme)}`),
  trades: async (meme: string, params: { limit?: number; before?: string } = {}) =>
    get<TradesPage>(`/v1/launches/${addressSegment(meme)}/trades`, params),
  candles: async (meme: string, params: { interval: CandleInterval; from?: number; to?: number; limit?: number }) =>
    get<{ candles: Candle[] }>(`/v1/launches/${addressSegment(meme)}/candles`, params),
  holders: async (meme: string, limit = 10) => get<HoldersPage>(`/v1/launches/${addressSegment(meme)}/holders`, { limit }),
  grants: (status?: string, opts: { includeHidden?: boolean } = {}) =>
    get<{ campaigns: GrantCampaign[] }>("/v1/grants", { status, include: opts.includeHidden ? "hidden" : undefined }),
  grant: async (meme: string) => get<GrantDetail>(`/v1/grants/${addressSegment(meme)}`),
  grantPositions: async (meme: string, beneficiary?: string) =>
    get<{ positions: GrantPosition[] }>(`/v1/grants/${addressSegment(meme)}/positions`, { beneficiary }),
  walletRoles: async (address: string) => get<WalletRoles>(`/v1/wallets/${addressSegment(address)}/roles`),
  wallet: async (address: string) => get<WalletSummary>(`/v1/wallets/${addressSegment(address)}`),
  lpPositions: async (address: string) => get<{ positions: LpPosition[] }>(`/v1/wallets/${addressSegment(address)}/lp-positions`),
  walletTrades: async (address: string, params: { limit?: number; before?: string } = {}) =>
    get<WalletTradesPage>(`/v1/wallets/${addressSegment(address)}/trades`, params),
  grantProof: async (meme: string, account: string) => get<GrantAllocationProof>(`/v1/grants/${addressSegment(meme)}/proof/${addressSegment(account)}`),
  quoteAssets: () => get<{ assets: QuoteAsset[] }>("/v1/quote-assets"),
  prices: () => get<Prices>("/v1/prices"),
  featured: () => get<{ launches: LaunchSummary[] }>("/v1/launches/featured"),
};

/**
 * The admin API. Sign-in needs no token; everything else takes the session token from `adminSession`. The API
 * checks the caller's role on every call, so these are only as powerful as the wallet that signed in.
 */
export const adminApi = {
  nonce: (address: string) => request<AdminNonce>("POST", "/v1/admin/auth/nonce", { body: { address } }),
  login: (message: string, signature: string) =>
    request<AdminSession>("POST", "/v1/admin/auth/login", { body: { message, signature } }),
  logout: (token: string) => request<{ ok: boolean }>("POST", "/v1/admin/auth/logout", { token }),
  me: (token: string) => request<AdminMe>("GET", "/v1/admin/me", { token }),
  operators: (token: string) => request<{ operators: AdminOperator[] }>("GET", "/v1/admin/operators", { token }),
  addOperator: (token: string, address: string) =>
    request<{ operators: AdminOperator[] }>("POST", "/v1/admin/operators", { token, body: { address } }),
  removeOperator: async (token: string, address: string) =>
    request<{ operators: AdminOperator[] }>("DELETE", `/v1/admin/operators/${addressSegment(address)}`, { token }),
  audit: (token: string, limit = 50) => request<{ entries: AdminAuditEntry[] }>("GET", "/v1/admin/audit", { token, params: { limit } }),
  searchLaunches: (token: string, q: string) =>
    request<{ launches: AdminLaunch[] }>("GET", "/v1/admin/launches", { token, params: { q } }),
  moderated: (token: string) => request<{ launches: AdminLaunch[] }>("GET", "/v1/admin/moderation", { token }),
  setModeration: async (token: string, meme: string, update: ModerationUpdate) =>
    request<AdminLaunch>("PUT", `/v1/admin/moderation/${addressSegment(meme)}`, { token, body: update }),
  featured: (token: string) => request<{ launches: AdminLaunch[] }>("GET", "/v1/admin/featured", { token }),
  setFeatured: (token: string, memes: string[]) =>
    request<{ launches: AdminLaunch[] }>("PUT", "/v1/admin/featured", { token, body: { memes } }),
  setQuoteDisplay: async (token: string, quote: string, display: QuoteDisplayUpdate) =>
    request<QuoteAsset>("PUT", `/v1/admin/quote-assets/${addressSegment(quote)}`, { token, body: display }),
};

/** True when the error means the API is down rather than the resource missing. */
export function isApiUnreachable(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 0 || err.status >= 500);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404;
}
