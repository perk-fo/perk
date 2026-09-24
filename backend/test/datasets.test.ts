import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { type Address, type Hex } from "viem";
import type { Db } from "../src/db/client";
import type { createApp } from "../src/api/server";
import type { ApiError, GrantAllocationProof, GrantDetail } from "../src/api/types";
import { CHAIN, makeTestApp, resetDb } from "./api-helpers";
import {
  fetchDataset,
  LEAF_ENCODING,
  loadPendingDatasets,
  verifyAndStore,
} from "../src/grants/datasets";

const ACC_A = "0x1abc000000000000000000000000000000000001" as Address;
const ACC_B = "0x2def000000000000000000000000000000000002" as Address;
const ACC_UNKNOWN = "0x9999999999999999999999999999999999999999" as Address;
const MEME_V = "0x0000000000000000000000000000000000000c11" as Address;
const MEME_M = "0x0000000000000000000000000000000000000c12" as Address;
const MEME_U = "0x0000000000000000000000000000000000000c13" as Address;
const MEME_R = "0x0000000000000000000000000000000000000c14" as Address;
const MEME_N = "0x0000000000000000000000000000000000000c15" as Address;
const WRONG_ROOT = `0x${"11".repeat(32)}` as Hex;

const LEAF_TYPES = [...LEAF_ENCODING];

let db: Db;
let app: ReturnType<typeof createApp>;
const tmpFiles: string[] = [];

beforeAll(async () => {
  db = await resetDb();
  ({ app } = await makeTestApp(db));
});

afterAll(async () => {
  for (const f of tmpFiles) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  await db.end({ timeout: 5 });
});

function writeJson(name: string, json: unknown): string {
  const path = join(import.meta.dir, name);
  writeFileSync(path, JSON.stringify(json));
  tmpFiles.push(path);
  return pathToFileURL(path).href;
}

function buildDataset(
  chainId: number,
  meme: Address,
  allocations: Array<{ account: Address; base: bigint; boost: bigint }>,
) {
  const values = allocations.map((a) => [a.account, a.base, a.boost] as [string, bigint, bigint]);
  const tree = StandardMerkleTree.of(values, LEAF_TYPES);
  const json = {
    chainId,
    meme,
    root: tree.root,
    allocations: allocations.map((a) => ({
      account: a.account,
      base: a.base.toString(),
      boost: a.boost.toString(),
    })),
  };
  return { tree, json, root: tree.root.toLowerCase() as Hex };
}

async function insertCampaign(meme: Address, root: string | null, uri: string | null): Promise<void> {
  await db`
    insert into grant_campaigns (
      chain_id, meme, status, reserve, base_pool, referral_budget,
      root, root_uri, initialized_block, initialized_at
    ) values (
      ${CHAIN}, ${meme}, 2, 0, 0, 0,
      ${root}, ${uri}, 1, 1
    )
    on conflict (chain_id, meme) do update set
      root = excluded.root,
      root_uri = excluded.root_uri,
      status = excluded.status
  `;
}

async function get(path: string): Promise<Response> {
  return app.request(path);
}

describe("fetchDataset", () => {
  test("test_fetchDataset_reverts_file_on_chain_196", async () => {
    await expect(fetchDataset("file:///tmp/perk-grant-dataset.json", { chainId: 196 })).rejects.toThrow(
      /file:\/\/ URIs are not allowed on chain 196/,
    );
  });

  test("test_fetchDataset_ipfs_uses_gateway_without_network", async () => {
    let requested: string | undefined;
    const json = { ok: true };
    const body = await fetchDataset("ipfs://QmTestCid/dataset.json", {
      chainId: CHAIN,
      ipfsGateway: "https://ipfs.io/ipfs/",
      fetch: (async (url) => {
        requested = String(url);
        return new Response(JSON.stringify(json), { status: 200 });
      }) as typeof fetch,
    });
    expect(requested).toBe("https://ipfs.io/ipfs/QmTestCid/dataset.json");
    expect(body).toEqual(json);
  });
});

describe("verifyAndStore + proof routes", () => {
  const allocs = [
    { account: ACC_A, base: 1000n, boost: 10n },
    { account: ACC_B, base: 2000n, boost: 0n },
  ];
  const verified = buildDataset(CHAIN, MEME_V, allocs);

  beforeAll(async () => {
    const uri = writeJson("dataset-verified.json", verified.json);
    await insertCampaign(MEME_V, verified.root, uri);
    const status = await verifyAndStore(db, CHAIN, MEME_V, verified.root, uri, verified.json);
    expect(status).toBe("verified");
  });

  test("test_verifyAndStore_verified_and_proofs_verify", async () => {
    const detailRes = await get(`/v1/grants/${MEME_V}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as GrantDetail;
    expect(detail.dataset.status).toBe("verified");
    expect(detail.dataset.accounts).toBe(2);
    expect(detail.dataset.root).toBe(verified.root);

    for (const a of allocs) {
      const res = await get(`/v1/grants/${MEME_V}/proof/${a.account}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
      const body = (await res.json()) as GrantAllocationProof;
      expect(body.meme).toBe(MEME_V);
      expect(body.root).toBe(verified.root);
      expect(body.leaf.account).toBe(a.account);
      expect(body.leaf.baseAllocation).toBe(a.base.toString());
      expect(body.leaf.inviteeBoost).toBe(a.boost.toString());
      expect(Array.isArray(body.proof)).toBe(true);
      const ok = StandardMerkleTree.verify(
        body.root,
        LEAF_TYPES,
        [a.account, BigInt(body.leaf.baseAllocation), BigInt(body.leaf.inviteeBoost)],
        body.proof,
      );
      expect(ok).toBe(true);
    }
  });

  test("test_proof_account_lookup_case_insensitive", async () => {
    const mixed = (`0x${ACC_A.slice(2).toUpperCase()}`) as Address;
    expect(mixed).not.toBe(ACC_A);
    const res = await get(`/v1/grants/${MEME_V}/proof/${mixed}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantAllocationProof;
    expect(body.leaf.account).toBe(ACC_A);
  });

  test("test_proof_reverts_unknown_account_not_listed", async () => {
    const res = await get(`/v1/grants/${MEME_V}/proof/${ACC_UNKNOWN}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiError;
    expect(body.error).toBe("not_listed");
  });

  test("test_verifyAndStore_mismatch_stores_no_leaves_proof_409", async () => {
    const mismatch = buildDataset(CHAIN, MEME_M, allocs);
    const uri = writeJson("dataset-mismatch.json", mismatch.json);
    await insertCampaign(MEME_M, WRONG_ROOT, uri);
    const status = await verifyAndStore(db, CHAIN, MEME_M, WRONG_ROOT, uri, mismatch.json);
    expect(status).toBe("mismatch");
    const leaves = await db<{ n: number }[]>`
      select count(*)::int as n from grant_leaves
      where chain_id = ${CHAIN} and meme = ${MEME_M} and root = ${WRONG_ROOT}
    `;
    expect(Number(leaves[0].n)).toBe(0);

    const res = await get(`/v1/grants/${MEME_M}/proof/${ACC_A}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiError;
    expect(body.error).toBe("dataset_unverified");
    expect(body.message).toBe("mismatch");
  });

  test("test_verifyAndStore_duplicate_account_is_mismatch", async () => {
    // a list naming one account twice is malformed even if its root matches: reject, store nothing, no retry loop
    const MEME_D = "0x0000000000000000000000000000000000000c16" as Address;
    const dup = buildDataset(CHAIN, MEME_D, [...allocs, allocs[0]]);
    const uri = writeJson("dataset-dup.json", dup.json);
    await insertCampaign(MEME_D, dup.root, uri);
    const status = await verifyAndStore(db, CHAIN, MEME_D, dup.root, uri, dup.json);
    expect(status).toBe("mismatch");
    const leaves = await db<{ n: number }[]>`
      select count(*)::int as n from grant_leaves where chain_id = ${CHAIN} and meme = ${MEME_D.toLowerCase()}
    `;
    expect(Number(leaves[0].n)).toBe(0);
  });

  test("test_grant_detail_dataset_none_without_root", async () => {
    await insertCampaign(MEME_N, null, null);
    const res = await get(`/v1/grants/${MEME_N}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as GrantDetail;
    expect(body.dataset.status).toBe("none");
    expect(body.dataset.root).toBeNull();
    expect(body.dataset.accounts).toBe(0);

    const proof = await get(`/v1/grants/${MEME_N}/proof/${ACC_A}`);
    expect(proof.status).toBe(409);
    const err = (await proof.json()) as ApiError;
    expect(err.error).toBe("dataset_unverified");
    expect(err.message).toBe("none");
  });

  test("test_proof_serves_reproposed_root", async () => {
    const first = buildDataset(CHAIN, MEME_R, [{ account: ACC_A, base: 111n, boost: 1n }]);
    const second = buildDataset(CHAIN, MEME_R, [
      { account: ACC_A, base: 222n, boost: 2n },
      { account: ACC_B, base: 333n, boost: 0n },
    ]);
    const uri1 = writeJson("dataset-root1.json", first.json);
    const uri2 = writeJson("dataset-root2.json", second.json);
    await insertCampaign(MEME_R, first.root, uri1);
    expect(await verifyAndStore(db, CHAIN, MEME_R, first.root, uri1, first.json)).toBe("verified");
    const p1 = (await (await get(`/v1/grants/${MEME_R}/proof/${ACC_A}`)).json()) as GrantAllocationProof;
    expect(p1.root).toBe(first.root);
    expect(p1.leaf.baseAllocation).toBe("111");

    await insertCampaign(MEME_R, second.root, uri2);
    expect(await verifyAndStore(db, CHAIN, MEME_R, second.root, uri2, second.json)).toBe("verified");
    const p2 = (await (await get(`/v1/grants/${MEME_R}/proof/${ACC_A}`)).json()) as GrantAllocationProof;
    expect(p2.root).toBe(second.root);
    expect(p2.leaf.baseAllocation).toBe("222");
    expect(
      StandardMerkleTree.verify(
        p2.root,
        LEAF_TYPES,
        [ACC_A, BigInt(p2.leaf.baseAllocation), BigInt(p2.leaf.inviteeBoost)],
        p2.proof,
      ),
    ).toBe(true);
  });
});

describe("runDatasetLoader", () => {
  test("test_loader_unreachable_is_retried", async () => {
    const uri = "file:///no/such/perk-grant-dataset-xyz.json";
    const root = `0x${"22".repeat(32)}`;
    await insertCampaign(MEME_U, root, uri);
    let t = 1_700_000_000;
    const deps = { db, chainId: CHAIN, now: () => t };
    await loadPendingDatasets(deps);
    const first = await db<{ status: string; error: string | null; checked_at: string | number | bigint }[]>`
      select status, error, checked_at from grant_datasets
      where chain_id = ${CHAIN} and meme = ${MEME_U} and root = ${root}
    `;
    expect(first[0].status).toBe("unreachable");
    expect(first[0].error).toBeTruthy();
    expect(Number(first[0].checked_at)).toBe(1_700_000_000);

    t = 1_700_000_030;
    await loadPendingDatasets(deps);
    const second = await db<{ status: string; checked_at: string | number | bigint }[]>`
      select status, checked_at from grant_datasets
      where chain_id = ${CHAIN} and meme = ${MEME_U} and root = ${root}
    `;
    expect(second[0].status).toBe("unreachable");
    expect(Number(second[0].checked_at)).toBe(1_700_000_030);

    const res = await get(`/v1/grants/${MEME_U}/proof/${ACC_A}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as ApiError;
    expect(body.error).toBe("dataset_unverified");
    expect(body.message).toBe("unreachable");
  });
});
