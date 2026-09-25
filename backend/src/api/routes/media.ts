import { Hono, type Context } from "hono";
import { detectImageExt, looksLikeSvg } from "../../media/imageType";
import { isImageCid } from "../../media/ipfsImages";
import type { ApiError, MediaUpload } from "../types";
import { HttpError, type AppEnv } from "../server";
import { MEDIA_FILE_RE, localMediaFilename } from "../../media/store";
import { parseTokenMetadata } from "../../media/metadata";
import { logError } from "../../log";
import { clientKey } from "../clientIp";

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_BODY_MAX = IMAGE_MAX_BYTES + 256 * 1024;
const METADATA_MAX_BYTES = 16 * 1024;

function checkContentLength(c: Context<AppEnv>, max: number): void {
  const raw = c.req.header("content-length");
  if (raw === undefined || raw === "") return;
  const n = Number(raw);
  if (Number.isFinite(n) && n > max) throw new HttpError(413, "too_large", "body too large");
}

/**
 * Per client (clientIp.ts: behind the configured proxies, IPv6 by /64). Forwarded headers are only believed from
 * trusted proxy hops, so a client cannot hand itself fresh buckets by rotating them.
 */
function rateLimitOrThrow(c: Context<AppEnv>): void {
  const { limiter } = c.get("deps");
  if (!limiter.take(clientKey(c))) {
    throw new HttpError(429, "rate_limited", "rate limited");
  }
}

/**
 * All clients together: stored bytes per day. Uploads nothing refers to yet are only deleted after a week, so without
 * this many addresses could fill the disk (or the Pinata account) faster than garbage collection empties it.
 */
function uploadBudgetOrThrow(c: Context<AppEnv>, bytes: number): void {
  const { uploadBudget } = c.get("deps");
  if (!uploadBudget.take("all", Date.now(), bytes)) {
    throw new HttpError(429, "upload_capacity", "uploads are paused for now; try again later");
  }
}

/** Store, or fail with a generic message: the storage error (a Pinata response, a file path) is logged, not returned. */
async function store(c: Context<AppEnv>, bytes: Uint8Array, ext: string): Promise<MediaUpload> {
  const { media } = c.get("deps");
  try {
    return await media.put(bytes, ext);
  } catch (err) {
    logError("media upload failed", err, { ext, bytes: bytes.byteLength });
    throw new HttpError(503, "storage_unavailable", "the file could not be stored right now; try again later");
  }
}

/**
 * POST /v1/media/image (multipart field `file`) and POST /v1/media/metadata (JSON).
 * GET /v1/media/:file serves content-addressed local files (local driver only).
 */
export function mediaRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/image", async (c) => {
    checkContentLength(c, IMAGE_BODY_MAX);
    rateLimitOrThrow(c);
    let file: File | undefined;
    try {
      const body = await c.req.parseBody();
      const f = body.file;
      if (f instanceof File) file = f;
    } catch {
      throw new HttpError(400, "bad_image", "expected multipart field file");
    }
    if (!file) throw new HttpError(400, "bad_image", "expected multipart field file");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > IMAGE_MAX_BYTES) throw new HttpError(400, "too_large", "image exceeds 2 MiB");
    if (looksLikeSvg(bytes)) throw new HttpError(400, "bad_image", "svg is not allowed");
    const ext = detectImageExt(bytes);
    if (!ext) throw new HttpError(400, "bad_image", "unrecognized image type");
    uploadBudgetOrThrow(c, bytes.byteLength);
    return c.json<MediaUpload>(await store(c, bytes, ext));
  });

  r.post("/metadata", async (c) => {
    checkContentLength(c, METADATA_MAX_BYTES);
    rateLimitOrThrow(c);
    const { media, config } = c.get("deps");
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (buf.byteLength > METADATA_MAX_BYTES) throw new HttpError(413, "too_large", "body too large");
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(buf)) as unknown;
    } catch {
      throw new HttpError(400, "bad_metadata", "invalid json");
    }
    const parsed = parseTokenMetadata(json, {
      imageRule: "issued",
      publicApiUrl: config.publicApiUrl,
      ipfsGateway: config.ipfsGateway,
    });
    if (!parsed) throw new HttpError(400, "bad_metadata", "invalid metadata");
    const localFile = localMediaFilename(String(parsed.canonical.image ?? ""), config.publicApiUrl);
    if (localFile && !media.get(localFile)) throw new HttpError(400, "bad_metadata", "image is not stored on this api");
    const encoded = new TextEncoder().encode(parsed.canonicalJson);
    uploadBudgetOrThrow(c, encoded.byteLength);
    return c.json<MediaUpload>(await store(c, encoded, "json"));
  });

  // GET /v1/media/ipfs/:cid: a token image pinned on IPFS, served from this API (media/ipfsImages). Only CIDs that an
  // indexed launch's metadata or a listed quote asset's icon points at are served, so this is not an open proxy.
  r.get("/ipfs/:cid", async (c) => {
    const cid = c.req.param("cid");
    if (!isImageCid(cid)) return c.json<ApiError>({ error: "not_found", message: "not found" }, 404);
    const { db, config, ipfsImages } = c.get("deps");
    const suffix = `%/ipfs/${cid}`;
    const known = await db`
      select 1 from launches
        where chain_id = ${config.chainId} and metadata_status = 'ok' and metadata->>'image' like ${suffix}
      union all
      select 1 from quote_asset_display
        where chain_id = ${config.chainId} and (icon_url like ${suffix} or icon_url = ${`ipfs://${cid}`})
      limit 1
    `;
    if (known.length === 0) return c.json<ApiError>({ error: "not_found", message: "not found" }, 404);
    const image = await ipfsImages.get(cid);
    if (!image) {
      c.header("Cache-Control", "public, max-age=30");
      return c.json<ApiError>({ error: "unavailable", message: "image unavailable" }, 502);
    }
    c.header("Content-Type", image.contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'");
    const copy = new Uint8Array(image.bytes.byteLength);
    copy.set(image.bytes);
    return c.body(copy.buffer);
  });

  r.get("/:file", (c) => {
    const file = c.req.param("file");
    if (!MEDIA_FILE_RE.test(file)) {
      return c.json<ApiError>({ error: "not_found", message: "not found" }, 404);
    }
    const { media } = c.get("deps");
    const hit = media.get(file);
    if (!hit) return c.json<ApiError>({ error: "not_found", message: "not found" }, 404);
    c.header("Content-Type", hit.contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'");
    const copy = new Uint8Array(hit.bytes.byteLength);
    copy.set(hit.bytes);
    return c.body(copy);
  });

  return r;
}
