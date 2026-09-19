import type {
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
  LpPosition,
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

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(API_URL + path);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { accept: "application/json" } });
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
  launch: (meme: string) => get<LaunchDetail>(`/v1/launches/${meme}`),
  trades: (meme: string, params: { limit?: number; before?: string } = {}) =>
    get<TradesPage>(`/v1/launches/${meme}/trades`, params),
  candles: (meme: string, params: { interval: CandleInterval; from?: number; to?: number; limit?: number }) =>
    get<{ candles: Candle[] }>(`/v1/launches/${meme}/candles`, params),
  holders: (meme: string, limit = 10) => get<HoldersPage>(`/v1/launches/${meme}/holders`, { limit }),
  grants: (status?: string) => get<{ campaigns: GrantCampaign[] }>("/v1/grants", { status }),
  grant: (meme: string) => get<GrantDetail>(`/v1/grants/${meme}`),
  grantPositions: (meme: string, beneficiary?: string) =>
    get<{ positions: GrantPosition[] }>(`/v1/grants/${meme}/positions`, { beneficiary }),
  walletRoles: (address: string) => get<WalletRoles>(`/v1/wallets/${address}/roles`),
  wallet: (address: string) => get<WalletSummary>(`/v1/wallets/${address}`),
  lpPositions: (address: string) => get<{ positions: LpPosition[] }>(`/v1/wallets/${address}/lp-positions`),
  grantProof: (meme: string, account: string) => get<GrantAllocationProof>(`/v1/grants/${meme}/proof/${account}`),
};

/** True when the error means the API is down rather than the resource missing. */
export function isApiUnreachable(err: unknown): boolean {
  return err instanceof ApiRequestError && (err.status === 0 || err.status >= 500);
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 404;
}
