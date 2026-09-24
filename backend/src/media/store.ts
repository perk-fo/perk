import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import type { MediaUpload } from "../api/types";

/**
 * Pinata's upload endpoint (Files API v3). Authorization: Bearer <PINATA_JWT>. Keys created today are scoped to this
 * API; the older pinning endpoint (api.pinata.cloud/pinning/pinFileToIPFS) refuses them with NO_SCOPES_FOUND.
 */
export const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";

export const MEDIA_FILE_RE = /^[0-9a-f]{64}\.(png|jpg|webp|gif|json)$/;

export const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  json: "application/json",
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function localMediaFilename(uri: string, publicApiUrl: string): string | null {
  const base = `${stripSlash(publicApiUrl)}/v1/media/`;
  if (!uri.startsWith(base)) return null;
  const file = uri.slice(base.length);
  return MEDIA_FILE_RE.test(file) ? file : null;
}

export function ipfsCid(uri: string): string | null {
  if (!uri.startsWith("ipfs://")) return null;
  let rest = uri.slice("ipfs://".length);
  if (rest.startsWith("ipfs/")) rest = rest.slice(5);
  rest = rest.replace(/^\/+/, "");
  if (!rest || /\s/.test(rest) || rest.includes("..") || rest.includes("\\")) return null;
  return rest.split("/")[0] ?? null;
}

export function ipfsToHttps(uri: string, gateway: string): string {
  const cid = ipfsCid(uri);
  if (!cid) return uri;
  const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "").replace(/^\/+/, "");
  return `${withTrailingSlash(gateway)}${path}`;
}

export interface MediaStore {
  put(bytes: Uint8Array, ext: string): Promise<MediaUpload>;
  get(filename: string): { bytes: Uint8Array; contentType: string } | null;
  gc(referenced: Set<string>, maxAgeMs: number, nowMs?: number): number;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createMediaStore(config: AppConfig, fetchImpl: FetchLike = globalThis.fetch): MediaStore {
  if (config.mediaDriver === "pinata") {
    return new PinataStore(config, fetchImpl);
  }
  return new LocalStore(config);
}

class LocalStore implements MediaStore {
  constructor(private readonly config: AppConfig) {}

  private dir(): string {
    return this.config.mediaDir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir(), { recursive: true });
  }

  private publicUrl(filename: string): string {
    return `${stripSlash(this.config.publicApiUrl)}/v1/media/${filename}`;
  }

  async put(bytes: Uint8Array, ext: string): Promise<MediaUpload> {
    this.ensureDir();
    const sha = sha256Hex(bytes);
    const filename = `${sha}.${ext}`;
    const path = join(this.dir(), filename);
    if (!existsSync(path)) writeFileSync(path, bytes);
    const url = this.publicUrl(filename);
    return { uri: url, url, sha256: sha, bytes: bytes.byteLength };
  }

  get(filename: string): { bytes: Uint8Array; contentType: string } | null {
    if (!MEDIA_FILE_RE.test(filename)) return null;
    const ext = filename.slice(filename.lastIndexOf(".") + 1);
    const path = join(this.dir(), filename);
    if (!existsSync(path)) return null;
    return { bytes: new Uint8Array(readFileSync(path)), contentType: CONTENT_TYPES[ext] ?? "application/octet-stream" };
  }

  gc(referenced: Set<string>, maxAgeMs: number, nowMs = Date.now()): number {
    if (!existsSync(this.dir())) return 0;
    let n = 0;
    for (const name of readdirSync(this.dir())) {
      if (!MEDIA_FILE_RE.test(name)) continue;
      if (referenced.has(name)) continue;
      const path = join(this.dir(), name);
      let age: number;
      try {
        age = nowMs - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age < maxAgeMs) continue;
      try {
        unlinkSync(path);
        n++;
      } catch {
        /* ignore */
      }
    }
    return n;
  }
}

class PinataStore implements MediaStore {
  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: FetchLike,
  ) {}

  async put(bytes: Uint8Array, ext: string): Promise<MediaUpload> {
    const jwt = this.config.pinataJwt;
    if (!jwt) throw new Error("PINATA_JWT is required when MEDIA_DRIVER=pinata");
    const sha = sha256Hex(bytes);
    const filename = `${sha}.${ext}`;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: CONTENT_TYPES[ext] ?? "application/octet-stream" }), filename);
    // public: the file is served by every IPFS gateway, which is what an on-chain ipfs:// link needs
    form.append("network", "public");
    form.append("name", filename);
    const res = await this.fetchImpl(PINATA_UPLOAD_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`pinata pin failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { IpfsHash?: string; cid?: string; data?: { cid?: string } };
    const cid = body.IpfsHash ?? body.cid ?? body.data?.cid;
    if (!cid) throw new Error("pinata pin failed: missing cid");
    const uri = `ipfs://${cid}`;
    const url = `${withTrailingSlash(this.config.ipfsGateway)}${cid}`;
    return { uri, url, sha256: sha, bytes: bytes.byteLength };
  }

  get(_filename: string): { bytes: Uint8Array; contentType: string } | null {
    return null;
  }

  gc(): number {
    return 0;
  }
}
