import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../src/db/client";
import { createApp } from "../src/api/server";
import type { ApiError, LaunchDetail, MediaUpload } from "../src/api/types";
import { loadConfig } from "../src/config";
import { createMediaStore, PINATA_PIN_FILE_URL, type FetchLike } from "../src/media/store";
import { resolvePendingMetadata } from "../src/media/resolver";
import { CHAIN, resetDb, testConfig, TEST_DEPLOYMENT, ZERO } from "./api-helpers";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49,
  0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0x0f, 0x00, 0x00, 0x01, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
const WEBP = (() => {
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x08, 0x00, 0x00, 0x00], 4);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  return b;
})();
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const TEXT_GIF = new TextEncoder().encode("PNG renamed .gif-with-text");

let db: Db;
let mediaDir: string;
let app: ReturnType<typeof createApp>;
let publicApiUrl: string;
let config: ReturnType<typeof testConfig>;
let media: ReturnType<typeof createMediaStore>;

beforeAll(async () => {
  db = await resetDb();
  mkdirSync(join(import.meta.dir, "../data"), { recursive: true });
  mediaDir = mkdtempSync(join(import.meta.dir, "../data/media-"));
  config = testConfig({ mediaDir, publicApiUrl: "http://localhost:8787" });
  media = createMediaStore(config);
  app = createApp({ db, config, media });
  publicApiUrl = config.publicApiUrl;
});

afterAll(async () => {
  try {
    rmSync(mediaDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await db.end({ timeout: 5 });
});

async function postFile(
  bytes: Uint8Array,
  filename: string,
  type = "application/octet-stream",
  target: ReturnType<typeof createApp> = app,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  return target.request("/v1/media/image", { method: "POST", body: form });
}

/** Upload with a client-supplied forwarded-for, as a spoofing client would send. */
async function postFileAs(
  xff: string,
  target: ReturnType<typeof createApp>,
  bytes: Uint8Array = PNG,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/png" }), "x.png");
  return target.request("/v1/media/image", { method: "POST", body: form, headers: { "x-forwarded-for": xff } });
}

async function postMeta(body: unknown, target: ReturnType<typeof createApp> = app): Promise<Response> {
  return target.request("/v1/media/metadata", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function h32(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

async function insertLaunch(meme: string, tokenUri: string | null, salt = 1): Promise<void> {
  await db`
    insert into launches (
      chain_id, meme, launch_id, creator, quote, quote_decimals, template_id, config_hash,
      status, created_block, created_log_index, created_tx, created_at,
      token_uri, metadata_status
    ) values (
      ${CHAIN}, ${meme}, ${h32(0x1000 + salt)}, ${ZERO}, ${ZERO}, 18, ${h32(11)}, ${h32(21)},
      1, ${4000 + salt}, 1, ${h32(0x2000 + salt)}, ${Math.floor(Date.now() / 1000)},
      ${tokenUri}, ${"pending"}
    )
  `;
}

describe("media image", () => {
  test("test_image_accepts_png_jpeg_webp_gif_by_magic_bytes", async () => {
    const cases: Array<{ bytes: Uint8Array; ext: string }> = [
      { bytes: PNG, ext: "png" },
      { bytes: JPEG, ext: "jpg" },
      { bytes: WEBP, ext: "webp" },
      { bytes: GIF, ext: "gif" },
    ];
    for (const c of cases) {
      const res = await postFile(c.bytes, "x.bin");
      expect(res.status).toBe(200);
      const body = (await res.json()) as MediaUpload;
      expect(body.uri).toBe(`${publicApiUrl}/v1/media/${body.sha256}.${c.ext}`);
      expect(body.url).toBe(body.uri);
      expect(body.bytes).toBe(c.bytes.byteLength);
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("test_image_reverts_svg_and_text_named_gif", async () => {
    const svg = await postFile(SVG, "icon.png", "image/png");
    expect(svg.status).toBe(400);
    expect(((await svg.json()) as ApiError).error).toBe("bad_image");

    const text = await postFile(TEXT_GIF, "photo.png.gif", "image/gif");
    expect(text.status).toBe(400);
    expect(((await text.json()) as ApiError).error).toBe("bad_image");
  });

  test("test_image_reverts_over_2mib", async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    bytes.set(PNG.subarray(0, 8));
    const res = await postFile(bytes, "big.png");
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiError).error).toBe("too_large");
  });

  test("test_image_same_bytes_same_uri_and_served_immutable", async () => {
    const first = await postFile(PNG, "a.gif");
    const second = await postFile(PNG, "b.jpg");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as MediaUpload;
    const b = (await second.json()) as MediaUpload;
    expect(a.uri).toBe(b.uri);
    expect(a.uri.endsWith(".png")).toBe(true);

    const path = a.uri.slice(publicApiUrl.length);
    const got = await app.request(path);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(got.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(got.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
    const back = new Uint8Array(await got.arrayBuffer());
    expect(back).toEqual(PNG);
  });
});

describe("media metadata", () => {
  let imageUri: string;

  beforeAll(async () => {
    const res = await postFile(PNG, "logo.png");
    imageUri = ((await res.json()) as MediaUpload).uri;
  });

  test("test_metadata_valid_canonical_and_key_order_independent", async () => {
    const base = {
      name: "Perk",
      symbol: "PRK",
      description: "hello",
      image: imageUri,
      links: { x: "https://x.com/perk", telegram: "https://t.me/perk", website: "https://perk.example" },
    };
    const a = await postMeta(base);
    expect(a.status).toBe(200);
    const ua = (await a.json()) as MediaUpload;
    expect(ua.uri).toBe(`${publicApiUrl}/v1/media/${ua.sha256}.json`);

    const shuffled = {
      image: imageUri,
      links: { website: "https://perk.example", x: "https://x.com/perk", telegram: "https://t.me/perk" },
      symbol: "PRK",
      description: "hello",
      name: "Perk",
    };
    const b = await postMeta(shuffled);
    expect(b.status).toBe(200);
    const ub = (await b.json()) as MediaUpload;
    expect(ub.uri).toBe(ua.uri);

    const path = ua.uri.slice(publicApiUrl.length);
    const got = await app.request(path);
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/json");
    const stored = JSON.parse(await got.text()) as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([
      "description",
      "image",
      "links",
      "name",
      "symbol",
      "telegram",
      "twitter",
      "website",
    ]);
  });

  test("test_metadata_reverts_foreign_image_http_js_oversize_description", async () => {
    const foreign = await postMeta({ name: "Perk", symbol: "PRK", image: "https://evil.example/x.png" });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as ApiError).error).toBe("bad_metadata");

    const httpLink = await postMeta({
      name: "Perk",
      symbol: "PRK",
      image: imageUri,
      links: { website: "http://perk.example" },
    });
    expect(httpLink.status).toBe(400);
    expect(((await httpLink.json()) as ApiError).error).toBe("bad_metadata");

    const js = await postMeta({
      name: "Perk",
      symbol: "PRK",
      image: imageUri,
      links: { website: "javascript:alert(1)" },
    });
    expect(js.status).toBe(400);
    expect(((await js.json()) as ApiError).error).toBe("bad_metadata");

    const long = await postMeta({
      name: "Perk",
      symbol: "PRK",
      image: imageUri,
      description: "x".repeat(281),
    });
    expect(long.status).toBe(400);
    expect(((await long.json()) as ApiError).error).toBe("bad_metadata");
  });
});

describe("media rate limit", () => {
  test("test_media_rate_limit_returns_429", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "../data/media-"));
    const limited = createApp({
      db,
      config: testConfig({ mediaDir: dir, mediaRateLimit: 2, mediaRateWindowMs: 600_000 }),
    });
    expect((await postFile(PNG, "x.png", "image/png", limited)).status).toBe(200);
    expect((await postFile(PNG, "x.png", "image/png", limited)).status).toBe(200);
    const third = await postFile(PNG, "x.png", "image/png", limited);
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: string }).error).toBe("rate_limited");
    rmSync(dir, { recursive: true, force: true });
  });

  test("test_media_rate_limit_ignores_spoofed_forwarded_for", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "../data/media-"));
    const limited = createApp({
      db,
      config: testConfig({ mediaDir: dir, mediaRateLimit: 2, mediaRateWindowMs: 600_000 }),
    });
    // TRUST_PROXY is off by default, so rotating the header must not hand the caller a fresh bucket.
    expect((await postFileAs("10.0.0.1", limited)).status).toBe(200);
    expect((await postFileAs("10.0.0.2", limited)).status).toBe(200);
    expect((await postFileAs("10.0.0.3", limited)).status).toBe(429);
    rmSync(dir, { recursive: true, force: true });
  });

  test("test_media_rate_limit_honours_forwarded_for_when_trusted", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "../data/media-"));
    const limited = createApp({
      db,
      config: testConfig({ mediaDir: dir, mediaRateLimit: 1, mediaRateWindowMs: 600_000, trustProxy: true }),
    });
    // Behind a proxy that overwrites the header, each real client keeps its own bucket.
    expect((await postFileAs("10.0.0.1", limited)).status).toBe(200);
    expect((await postFileAs("10.0.0.1", limited)).status).toBe(429);
    expect((await postFileAs("10.0.0.2", limited)).status).toBe(200);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("pinata driver", () => {
  test("test_pinata_upload_sends_jwt_and_returns_ipfs_uri", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fetchMock: FetchLike = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization") });
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ IpfsHash: "bafyTestCid", PinSize: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const pinataApp = createApp({
      db,
      config: testConfig({
        mediaDriver: "pinata",
        pinataJwt: "test-jwt-token",
        ipfsGateway: "https://ipfs.io/ipfs/",
      }),
      fetch: fetchMock,
    });
    const res = await postFile(PNG, "x.png", "image/png", pinataApp);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MediaUpload;
    expect(body.uri).toBe("ipfs://bafyTestCid");
    expect(body.url).toBe("https://ipfs.io/ipfs/bafyTestCid");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(PINATA_PIN_FILE_URL);
    expect(calls[0].auth).toBe("Bearer test-jwt-token");

    const metaRes = await postMeta({ name: "Perk", symbol: "PRK", image: "ipfs://bafyTestCid" }, pinataApp);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as MediaUpload;
    expect(meta.uri.startsWith("ipfs://")).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].auth).toBe("Bearer test-jwt-token");
  });

  test("test_pinata_without_jwt_refuses_to_boot", () => {
    expect(() =>
      loadConfig({
        chainId: 1952,
        deployment: TEST_DEPLOYMENT,
        rpcUrl: "http://mock",
        databaseUrl: "postgres://localhost:5432/perk_test",
        mediaDriver: "pinata",
        pinataJwt: "",
      }),
    ).toThrow(/PINATA_JWT/);
  });
});

describe("metadata resolver", () => {
  test("test_resolver_own_metadata_ok_and_summary_carries_it", async () => {
    const img = (await (await postFile(JPEG, "j.jpg")).json()) as MediaUpload;
    const meta = (await (
      await postMeta({
        name: "Curve",
        symbol: "CRV",
        description: "from our store",
        image: img.uri,
        links: { x: "https://twitter.com/perk" },
      })
    ).json()) as MediaUpload;
    const meme = "0x0000000000000000000000000000000000000bb1";
    await insertLaunch(meme, meta.uri, 1);
    await resolvePendingMetadata({ db, config, media });
    const row = await db<{ metadata_status: string }[]>`
      select metadata_status from launches where chain_id = ${CHAIN} and meme = ${meme}`;
    expect(row[0]?.metadata_status).toBe("ok");
    const res = await app.request(`/v1/launches/${meme}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as LaunchDetail;
    expect(detail.metadata).not.toBeNull();
    expect(detail.metadata?.image).toBe(img.uri);
    expect(detail.metadata?.description).toBe("from our store");
    expect(detail.metadata?.links.x).toBe("https://twitter.com/perk");
  });

  test("test_resolver_garbage_json_invalid", async () => {
    const stored = await media.put(new TextEncoder().encode("{not json"), "json");
    const meme = "0x0000000000000000000000000000000000000bb2";
    await insertLaunch(meme, stored.uri, 2);
    await resolvePendingMetadata({ db, config, media });
    const row = await db<{ metadata_status: string }[]>`
      select metadata_status from launches where chain_id = ${CHAIN} and meme = ${meme}`;
    expect(row[0]?.metadata_status).toBe("invalid");
    const res = await app.request(`/v1/launches/${meme}`);
    const detail = (await res.json()) as LaunchDetail;
    expect(detail.metadata).toBeNull();
  });

  test("test_resolver_unreachable_is_retried", async () => {
    const meme = "0x0000000000000000000000000000000000000bb3";
    await insertLaunch(meme, "https://metadata.example/token.json", 3);
    let calls = 0;
    const fetchMock: FetchLike = async () => {
      calls++;
      throw new Error("network down");
    };
    let now = 1_700_000_000;
    await resolvePendingMetadata({ db, config, media, fetch: fetchMock, now: () => now });
    expect(calls).toBe(1);
    const first = await db<{ metadata_status: string; metadata_checked_at: bigint | number | string }[]>`
      select metadata_status, metadata_checked_at from launches where chain_id = ${CHAIN} and meme = ${meme}`;
    expect(first[0]?.metadata_status).toBe("unreachable");

    await resolvePendingMetadata({ db, config, media, fetch: fetchMock, now: () => now + 60 });
    expect(calls).toBe(1);

    await resolvePendingMetadata({ db, config, media, fetch: fetchMock, now: () => now + 10 * 60 });
    expect(calls).toBe(2);
  });
});
