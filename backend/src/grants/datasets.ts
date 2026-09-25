import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Db } from "../db/client";
import { XLAYER_MAINNET } from "../config";
import type { GrantAllocationProof, GrantDataset, Hex } from "../api/types";
import { addr, hexNull, num, numNull, uint } from "../api/serialize";
import { errorText } from "../log";
import { FetchFailedError, fetchPublic, UrlRefusedError, type LookupFn } from "../net/fetchPublic";

export const LEAF_ENCODING = ["address", "uint256", "uint256"] as const;
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs/";

type LeafValue = [string, bigint, bigint];

export interface FetchDatasetOpts {
  chainId: number;
  ipfsGateway?: string;
  fetch?: typeof globalThis.fetch;
  /** DNS for the outbound fetch guard; tests inject one so nothing leaves the machine. */
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
  /** Read file:// URIs: local development only (config.allowFileDatasetUris), never on chain 196. */
  allowFileUris?: boolean;
}

export interface DatasetLoaderDeps {
  db: Db;
  chainId: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  ipfsGateway?: string;
  fetch?: typeof globalThis.fetch;
  lookup?: LookupFn;
  allowFileUris?: boolean;
  now?: () => number;
}

/** A dataset could not be loaded, for a reason whose message is safe to publish (GrantDataset.error). */
export class DatasetError extends Error {
  override name = "DatasetError";
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

/** What GrantDataset.error shows: the message of a DatasetError, a generic text for anything else. */
function publicDatasetError(err: unknown): string {
  return err instanceof DatasetError ? err.message : "the dataset could not be loaded";
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

/**
 * Fetch a published grant dataset JSON from `https://` or `ipfs://<cid>` (via IPFS_GATEWAY, default
 * `https://ipfs.io/ipfs/`), through the outbound fetch guard (net/fetchPublic.ts: public hosts only, every redirect
 * checked, no downgrade to http). `file://` only when `allowFileUris` (local development) and never on chain 196: the
 * URI is whatever the grant publisher put on chain. 10 s timeout, 5 MB cap. Failures throw DatasetError.
 */
export async function fetchDataset(uri: string, opts: FetchDatasetOpts): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? FETCH_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const gateway = opts.ipfsGateway ?? process.env.IPFS_GATEWAY ?? DEFAULT_IPFS_GATEWAY;

  if (uri.startsWith("file://")) {
    if (opts.chainId === XLAYER_MAINNET) throw new DatasetError("file:// URIs are not allowed on chain 196");
    if (!opts.allowFileUris) throw new DatasetError("file:// URIs are not read by this API");
    let text: string;
    try {
      const path = fileURLToPath(uri);
      if (statSync(path).size > maxBytes) throw new DatasetError(`dataset exceeds ${maxBytes} bytes`);
      text = readFileSync(path, "utf8");
    } catch (err) {
      if (err instanceof DatasetError) throw err;
      throw new DatasetError("the dataset file cannot be read", { cause: err });
    }
    return parseDatasetJson(text);
  }

  let url: string;
  if (uri.startsWith("ipfs://")) url = ipfsToHttps(uri, gateway);
  else if (uri.startsWith("https://")) url = uri;
  else throw new DatasetError("unsupported dataset URI scheme");

  let bytes: Uint8Array;
  try {
    bytes = await fetchPublic(url, { fetch: opts.fetch, lookup: opts.lookup, timeoutMs, maxBytes });
  } catch (err) {
    if (err instanceof UrlRefusedError || err instanceof FetchFailedError) {
      throw new DatasetError(`dataset fetch failed: ${err.message}`, { cause: err });
    }
    throw new DatasetError("dataset fetch failed", { cause: err });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new DatasetError("the dataset is not valid UTF-8", { cause: err });
  }
  return parseDatasetJson(text);
}

function parseDatasetJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new DatasetError("the dataset is not valid JSON", { cause: err });
  }
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
 * `verified` or `mismatch`. Fetch failures become `unreachable` and are retried next round; the stored error is a
 * DatasetError message or a generic text, and the details go to the log.
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
        lookup: deps.lookup,
        allowFileUris: deps.allowFileUris,
      });
      await verifyAndStore(deps.db, deps.chainId, row.meme, row.root, uri, json);
    } catch (err) {
      deps.log?.("dataset-loader", { meme: row.meme, error: errorText(err) });
      try {
        await markUnreachable(deps.db, deps.chainId, row.meme, row.root, uri, publicDatasetError(err), now());
      } catch (inner) {
        deps.log?.("dataset-loader", { meme: row.meme, error: errorText(inner) });
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
      log("dataset-loader", { error: errorText(err) });
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
