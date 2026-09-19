import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Db } from "../db/client";
import { XLAYER_MAINNET } from "../config";
import type { GrantAllocationProof, GrantDataset, Hex } from "../api/types";
import { addr, hexNull, num, numNull, uint } from "../api/serialize";

export const LEAF_ENCODING = ["address", "uint256", "uint256"] as const;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

type LeafValue = [string, bigint, bigint];

export interface FetchDatasetOpts {
  chainId: number;
  ipfsGateway?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DatasetLoaderDeps {
  db: Db;
  chainId: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  ipfsGateway?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface DatasetJson {
  chainId?: unknown;
  meme?: unknown;
  allocations?: unknown;
}

interface GrantDatasetRow {
  status: string;
  uri: string | null;
  root: string | null;
  accounts: number | string | bigint | null;
  checked_at: number | string | bigint | null;
  error: string | null;
}

interface GrantLeafRow {
  account: string;
  base_allocation: string | bigint | null;
  invitee_boost: string | bigint | null;
  proof: unknown;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function joinGateway(gateway: string, cid: string): string {
  const base = gateway.endsWith("/") ? gateway : `${gateway}/`;
  return `${base}${cid.replace(/^\/+/, "")}`;
}

function ipfsToHttps(uri: string, gateway: string): string {
  let cid = uri.slice("ipfs://".length);
  if (cid.startsWith("ipfs/")) cid = cid.slice(5);
  return joinGateway(gateway, cid);
}

async function readHttpBody(res: Response, maxBytes: number): Promise<string> {
  const declared = res.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) throw new Error(`dataset exceeds ${maxBytes} bytes`);
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw new Error(`dataset exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`dataset exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Fetch a published grant dataset JSON from `https://`, `ipfs://<cid>` (via IPFS_GATEWAY,
 * default `https://ipfs.io/ipfs/`), or `file://` when chainId is not X Layer mainnet (196).
 * 10 s timeout, 5 MB cap.
 */
export async function fetchDataset(uri: string, opts: FetchDatasetOpts): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const gateway = opts.ipfsGateway ?? process.env.IPFS_GATEWAY ?? DEFAULT_IPFS_GATEWAY;

  if (uri.startsWith("file://")) {
    if (opts.chainId === XLAYER_MAINNET) throw new Error("file:// URIs are not allowed on chain 196");
    const path = fileURLToPath(uri);
    const st = statSync(path);
    if (st.size > maxBytes) throw new Error(`dataset exceeds ${maxBytes} bytes`);
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  }

  let url: string;
  if (uri.startsWith("ipfs://")) url = ipfsToHttps(uri, gateway);
  else if (uri.startsWith("https://")) url = uri;
  else throw new Error(`unsupported dataset URI scheme: ${uri.split(":", 1)[0] || uri}`);

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`dataset fetch failed: HTTP ${res.status}`);
  const text = await readHttpBody(res, maxBytes);
  return JSON.parse(text) as unknown;
}

function parseAllocations(json: DatasetJson): LeafValue[] | null {
  if (!Array.isArray(json.allocations) || json.allocations.length === 0) return null;
  const out: LeafValue[] = [];
  const seen = new Set<string>();
  for (const row of json.allocations) {
    if (!row || typeof row !== "object") return null;
    const a = row as { account?: unknown; base?: unknown; boost?: unknown };
    try {
      const account = String(a.account);
      if (!/^0x[0-9a-fA-F]{40}$/.test(account)) return null;
      const base = BigInt(a.base as string | number | bigint);
      const boost = BigInt(a.boost as string | number | bigint);
      if (base < 0n || boost < 0n) return null;
      // one leaf per account: a duplicate makes the list malformed (and would collide on the proof table's key)
      if (seen.has(account.toLowerCase())) return null;
      seen.add(account.toLowerCase());
      out.push([account, base, boost]);
    } catch {
      return null;
    }
  }
  return out;
}

function asProof(v: unknown): Hex[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).toLowerCase() as Hex);
}

async function upsertDataset(
  db: Db,
  row: {
    chainId: number;
    meme: string;
    root: string;
    uri: string;
    status: "verified" | "mismatch" | "unreachable";
    accounts: number;
    error: string | null;
    checkedAt: number;
  },
): Promise<void> {
  await db`
    insert into grant_datasets (chain_id, meme, root, uri, status, accounts, error, checked_at)
    values (
      ${row.chainId}, ${row.meme}, ${row.root}, ${row.uri}, ${row.status},
      ${row.accounts}, ${row.error}, ${row.checkedAt}
    )
    on conflict (chain_id, meme, root) do update set
      uri = excluded.uri,
      status = excluded.status,
      accounts = excluded.accounts,
      error = excluded.error,
      checked_at = excluded.checked_at
  `;
}

/**
 * Rebuild the StandardMerkleTree from a published dataset and persist it iff the tree root
 * equals the on-chain `root` and `json.meme` / `json.chainId` match. Otherwise status is
 * `mismatch` and no leaves are stored. All writes are one transaction.
 */
export async function verifyAndStore(
  db: Db,
  chainId: number,
  meme: string,
  root: string,
  uri: string,
  json: unknown,
): Promise<"verified" | "mismatch"> {
  const memeLc = meme.toLowerCase();
  const rootLc = root.toLowerCase();
  const checkedAt = unixNow();
  const body = json && typeof json === "object" ? (json as DatasetJson) : null;
  const allocations = body ? parseAllocations(body) : null;
  const memeOk = body !== null && String(body.meme).toLowerCase() === memeLc;
  const chainOk = body !== null && Number(body.chainId) === chainId;

  let status: "verified" | "mismatch" = "mismatch";
  let tree: StandardMerkleTree<LeafValue> | null = null;
  if (allocations && memeOk && chainOk) {
    try {
      tree = StandardMerkleTree.of(allocations, [...LEAF_ENCODING]);
      if (tree.root.toLowerCase() === rootLc) status = "verified";
      else tree = null;
    } catch {
      tree = null;
      status = "mismatch";
    }
  }

  await db.begin(async (tx) => {
    await upsertDataset(tx as unknown as Db, {
      chainId,
      meme: memeLc,
      root: rootLc,
      uri,
      status,
      accounts: status === "verified" && allocations ? allocations.length : 0,
      error: status === "mismatch" ? "dataset does not match on-chain root" : null,
      checkedAt,
    });
    await tx`
      delete from grant_leaves
      where chain_id = ${chainId} and meme = ${memeLc} and root = ${rootLc}
    `;
    if (status === "verified" && tree) {
      for (const [i, value] of tree.entries()) {
        const account = String(value[0]).toLowerCase();
        const base = BigInt(value[1]).toString();
        const boost = BigInt(value[2]).toString();
        const proof = tree.getProof(i).map((p) => p.toLowerCase());
        await tx`
          insert into grant_leaves (
            chain_id, meme, root, account, base_allocation, invitee_boost, proof
          ) values (
            ${chainId}, ${memeLc}, ${rootLc}, ${account}, ${base}, ${boost}, ${(tx as unknown as Db).json(proof)}
          )
        `;
      }
    }
  });
  return status;
}

async function markUnreachable(
  db: Db,
  chainId: number,
  meme: string,
  root: string,
  uri: string,
  error: string,
  checkedAt: number,
): Promise<void> {
  await upsertDataset(db, {
    chainId,
    meme: meme.toLowerCase(),
    root: root.toLowerCase(),
    uri,
    status: "unreachable",
    accounts: 0,
    error,
    checkedAt,
  });
}

interface PendingCampaign {
  meme: string;
  root: string;
  root_uri: string | null;
}

/**
 * One loader pass: campaigns with a non-null root whose (meme, root) is not yet
 * `verified` or `mismatch`. Fetch failures become `unreachable` and are retried next round.
 */
export async function loadPendingDatasets(deps: DatasetLoaderDeps): Promise<void> {
  const now = deps.now ?? unixNow;
  const rows = await deps.db<PendingCampaign[]>`
    select gc.meme, gc.root, gc.root_uri
    from grant_campaigns gc
    where gc.chain_id = ${deps.chainId}
      and gc.root is not null
      and not exists (
        select 1 from grant_datasets gd
        where gd.chain_id = gc.chain_id
          and gd.meme = gc.meme
          and gd.root = gc.root
          and gd.status in ('verified', 'mismatch')
      )
  `;
  for (const row of rows) {
    const uri = row.root_uri ?? "";
    try {
      const json = await fetchDataset(uri, {
        chainId: deps.chainId,
        ipfsGateway: deps.ipfsGateway,
        fetch: deps.fetch,
      });
      await verifyAndStore(deps.db, deps.chainId, row.meme, row.root, uri, json);
    } catch (err) {
      try {
        await markUnreachable(deps.db, deps.chainId, row.meme, row.root, uri, errMessage(err), now());
      } catch (inner) {
        deps.log?.("dataset-loader", { meme: row.meme, error: errMessage(inner) });
      }
    }
  }
}

/**
 * Background loop: load unpublished grant datasets every `everyMs` (default 30 s).
 * Never throws out of the loop. Serve-side only.
 */
export async function runDatasetLoader(
  deps: DatasetLoaderDeps,
  opts: { everyMs?: number } = {},
): Promise<void> {
  const everyMs = opts.everyMs ?? 30_000;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  const log = deps.log ?? (() => {});
  for (;;) {
    try {
      await loadPendingDatasets(deps);
    } catch (err) {
      log("dataset-loader", { error: errMessage(err) });
    }
    await sleep(everyMs);
  }
}

function mapDataset(row: GrantDatasetRow): GrantDataset {
  const status = row.status;
  const ok =
    status === "verified" || status === "mismatch" || status === "unreachable" || status === "pending"
      ? status
      : "pending";
  return {
    status: ok,
    uri: row.uri,
    root: hexNull(row.root),
    accounts: num(row.accounts),
    checkedAt: numNull(row.checked_at),
    error: row.error,
  };
}

/** Campaign's current-root dataset view for GET /v1/grants/:meme (`none` when the campaign has no root). */
export async function selectGrantDataset(
  db: Db,
  chainId: number,
  meme: string,
  root: string | null,
  uri: string | null,
): Promise<GrantDataset> {
  if (!root) {
    return { status: "none", uri: null, root: null, accounts: 0, checkedAt: null, error: null };
  }
  const rootLc = root.toLowerCase();
  const rows = await db<GrantDatasetRow[]>`
    select status, uri, root, accounts, checked_at, error
    from grant_datasets
    where chain_id = ${chainId} and meme = ${meme} and root = ${rootLc}
  `;
  if (!rows[0]) {
    return { status: "pending", uri, root: rootLc as Hex, accounts: 0, checkedAt: null, error: null };
  }
  return mapDataset(rows[0]);
}

/** Leaf + proof for `account` under (meme, root), case-insensitive on the wallet. */
export async function selectGrantLeaf(
  db: Db,
  chainId: number,
  meme: string,
  root: string,
  account: string,
): Promise<GrantAllocationProof["leaf"] & { proof: Hex[] } | null> {
  const rows = await db<GrantLeafRow[]>`
    select account, base_allocation, invitee_boost, proof
    from grant_leaves
    where chain_id = ${chainId}
      and meme = ${meme}
      and root = ${root.toLowerCase()}
      and lower(account) = ${account.toLowerCase()}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    account: addr(row.account),
    baseAllocation: uint(row.base_allocation),
    inviteeBoost: uint(row.invitee_boost),
    proof: asProof(row.proof),
  };
}
