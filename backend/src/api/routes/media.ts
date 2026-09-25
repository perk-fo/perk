import { Hono, type Context } from "hono";
import type { ApiError, MediaUpload } from "../types";
import { HttpError, type AppEnv } from "../server";
import { MEDIA_FILE_RE, localMediaFilename } from "../../media/store";
import { parseTokenMetadata } from "../../media/metadata";
import { logError } from "../../log";
import { clientKey } from "../clientIp";

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_BODY_MAX = IMAGE_MAX_BYTES + 256 * 1024;
const METADATA_MAX_BYTES = 16 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.byteLength < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.includes("<svg");
}

function detectImageExt(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
  if (startsWith(bytes, PNG)) return "png";
  if (startsWith(bytes, JPEG)) return "jpg";
  if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return "gif";
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  return null;
}

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
