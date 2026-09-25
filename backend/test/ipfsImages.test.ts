import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/api/server";
import type { Db } from "../src/db/client";
import { IpfsImageCache, isImageCid, proxiedImageUrl, setImageProxyBase } from "../src/media/ipfsImages";
import { resetDb, testConfig } from "./helpers";

const CID = "bafkreieik2h6kgy7u6mheof6fjaltk5o2ds73g3xx4n2yli3vm5dbf6yha";
const OTHER = "bafkreib7wjxbxoqru3wxoyoawv5wgi2a2nveopdtiqhcl7nk5n4axk6xuu";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe("IpfsImageCache", () => {
  test("test_get_fallsBackToTheNextGatewayAndCaches", async () => {
    const asked: string[] = [];
    const cache = new IpfsImageCache({
      gateways: ["https://a.example/ipfs", "https://b.example/ipfs/"],
      fetchBytes: async (url) => {
        asked.push(url);
        if (url.startsWith("https://a.example")) throw new Error("HTTP 429");
        return PNG;
      },
    });
    const first = await cache.get(CID);
    expect(first?.contentType).toBe("image/png");
    expect(asked).toEqual([`https://a.example/ipfs/${CID}`, `https://b.example/ipfs/${CID}`]);
    await cache.get(CID);
    expect(asked.length).toBe(2); // served from memory the second time
  });

  test("test_get_sharesOneFetchBetweenConcurrentRequests", async () => {
    let calls = 0;
    const cache = new IpfsImageCache({
      gateways: ["https://a.example/ipfs/"],
      fetchBytes: async () => {
        calls++;
        await Bun.sleep(5);
        return PNG;
      },
    });
    await Promise.all([cache.get(CID), cache.get(CID), cache.get(CID)]);
    expect(calls).toBe(1);
  });

  test("test_get_refusesNonImagesAndBadCids", async () => {
    const cache = new IpfsImageCache({ gateways: ["https://a.example/ipfs/"], fetchBytes: async () => SVG });
    expect(await cache.get(CID)).toBeNull();
    expect(await cache.get("not-a-cid")).toBeNull();
    expect(await cache.get(`${CID}/../../etc`)).toBeNull();
    expect(isImageCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(true);
  });

  test("test_get_remembersFailuresBriefly", async () => {
    let calls = 0;
    let now = 1_000;
    const cache = new IpfsImageCache({
      gateways: ["https://a.example/ipfs/"],
      fetchBytes: async () => {
        calls++;
        throw new Error("HTTP 429");
      },
      failureTtlMs: 60_000,
      now: () => now,
    });
    await cache.get(CID);
    await cache.get(CID);
    expect(calls).toBe(1);
    now += 61_000;
    await cache.get(CID);
    expect(calls).toBe(2);
  });

  test("test_get_evictsTheLeastRecentlyUsed", async () => {
    const fetched: string[] = [];
    const cache = new IpfsImageCache({
      gateways: ["https://a.example/ipfs/"],
      fetchBytes: async (url) => {
        fetched.push(url.slice(-8));
        return PNG;
      },
      maxBytes: PNG.byteLength, // room for exactly one image
    });
    await cache.get(CID);
    await cache.get(OTHER); // evicts CID
    await cache.get(OTHER); // still held
    await cache.get(CID); // fetched again
    expect(fetched).toEqual([CID.slice(-8), OTHER.slice(-8), CID.slice(-8)]);
  });
});

describe("proxiedImageUrl", () => {
  test("test_proxiedImageUrl_rewritesBareGatewayCidsOnly", () => {
    setImageProxyBase("https://api.example/");
    try {
      expect(proxiedImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}`)).toBe(`https://api.example/v1/media/ipfs/${CID}`);
      expect(proxiedImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}/logo.png`)).toBe(`https://gateway.pinata.cloud/ipfs/${CID}/logo.png`);
      expect(proxiedImageUrl("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    } finally {
      setImageProxyBase(null);
    }
    expect(proxiedImageUrl(`https://gateway.pinata.cloud/ipfs/${CID}`)).toBe(`https://gateway.pinata.cloud/ipfs/${CID}`);
  });
});

describe("GET /v1/media/ipfs/:cid", () => {
  let db: Db;
  let app: ReturnType<typeof createApp>;
  const config = testConfig();

  beforeAll(async () => {
    db = await resetDb();
    await db`
      insert into launches (
        chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
        status, created_block, created_log_index, created_tx, created_at, token_uri, metadata_status, metadata
      ) values (
        ${config.chainId}, ${"0x00000000000000000000000000000000000000aa"}, ${`0x${"1".padStart(64, "0")}`},
        ${"0x0000000000000000000000000000000000000000"}, ${"0x0000000000000000000000000000000000000000"}, 18,
        ${`0x${"2".padStart(64, "0")}`}, ${`0x${"3".padStart(64, "0")}`}, 1, 1, 1, ${`0x${"4".padStart(64, "0")}`},
        ${Math.floor(Date.now() / 1000)}, ${"ipfs://meta"}, ${"ok"},
        ${db.json({ image: `https://gateway.pinata.cloud/ipfs/${CID}`, description: "", links: {} })}
      )
    `;
    const ipfsImages = new IpfsImageCache({ gateways: ["https://a.example/ipfs/"], fetchBytes: async () => PNG });
    app = createApp({ db, config, ipfsImages });
  });

  afterAll(async () => {
    await db.end();
  });

  test("test_ipfsImage_servesAKnownLaunchImage", async () => {
    const res = await app.request(`/v1/media/ipfs/${CID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  test("test_ipfsImage_reverts_unknownCidIsNotProxied", async () => {
    expect((await app.request(`/v1/media/ipfs/${OTHER}`)).status).toBe(404);
    expect((await app.request("/v1/media/ipfs/not-a-cid")).status).toBe(404);
  });
});
