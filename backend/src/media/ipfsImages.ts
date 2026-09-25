import { detectImageExt, IMAGE_CONTENT_TYPE, looksLikeSvg } from "./imageType";
import { withTrailingSlash } from "./store";

/**
 * Token images pinned on IPFS, served by this API: GET /v1/media/ipfs/:cid. Browsers get the image from us rather
 * than from a public IPFS gateway, which rate-limits a page that shows many tokens at once (and then shows none of
 * them). Each image is fetched once, from the configured gateway first and then from public fallbacks, checked to be
 * a real PNG, JPEG, WebP or GIF (never SVG), and kept in memory. IPFS content never changes, so it is served with an
 * immutable cache lifetime.
 */
export const IPFS_IMAGE_PATH = "/v1/media/ipfs/";

/** A bare CID: CIDv0 (Qm…, base58) or CIDv1 in base32 (b…). No paths, no other characters. */
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

export function isImageCid(s: string): boolean {
  return CID_RE.test(s);
}

let proxyBase: string | null = null;

/** Serve IPFS images through this API: set once at startup to config.publicApiUrl (null leaves URLs as stored). */
export function setImageProxyBase(publicApiUrl: string | null): void {
  proxyBase = publicApiUrl ? publicApiUrl.replace(/\/+$/, "") : null;
}

const GATEWAY_URL_RE = /^https:\/\/[^/?#]+\/ipfs\/([A-Za-z0-9]+)$/;

/**
 * A stored gateway URL for a bare CID (https://<gateway>/ipfs/<cid>), rewritten to this API's image route; anything
 * else, or everything while no proxy base is set, is returned unchanged. Applied when responses are built, so rows
 * stored before the route existed are served through it too.
 */
export function proxiedImageUrl(url: string): string {
  if (!proxyBase) return url;
  const m = GATEWAY_URL_RE.exec(url);
  if (!m || !isImageCid(m[1]!)) return url;
  return `${proxyBase}${IPFS_IMAGE_PATH}${m[1]}`;
}

/** Public gateways tried after the configured one. */
export const FALLBACK_GATEWAYS = ["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/"];

export interface IpfsImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface IpfsImageCacheOptions {
  /** In order of preference; duplicates are dropped. */
  gateways: string[];
  /** Fetches a URL's body, refusing anything over the cap (net/fetchPublic in production). */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Total bytes kept in memory (default 64 MiB); the least recently used images go first. */
  maxBytes?: number;
  /** How long a CID that no gateway served is not asked for again (default 60 s). */
  failureTtlMs?: number;
  now?: () => number;
}

export class IpfsImageCache {
  private readonly gateways: string[];
  private readonly maxBytes: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, IpfsImage>();
  private readonly inFlight = new Map<string, Promise<IpfsImage | null>>();
  private readonly failedAt = new Map<string, number>();
  private held = 0;

  constructor(private readonly opts: IpfsImageCacheOptions) {
    this.gateways = [...new Set(opts.gateways.map(withTrailingSlash))];
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.failureTtlMs = opts.failureTtlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  /** The image for `cid`, or null when it is not a CID, no gateway serves it, or it is not an accepted image. */
  async get(cid: string): Promise<IpfsImage | null> {
    if (!isImageCid(cid)) return null;
    const hit = this.entries.get(cid);
    if (hit) {
      // refresh its place in the least-recently-used order
      this.entries.delete(cid);
      this.entries.set(cid, hit);
      return hit;
    }
    const failed = this.failedAt.get(cid);
    if (failed !== undefined && this.now() - failed < this.failureTtlMs) return null;
    const pending = this.inFlight.get(cid);
    if (pending) return pending;
    const load = this.load(cid).finally(() => this.inFlight.delete(cid));
    this.inFlight.set(cid, load);
    return load;
  }

  private async load(cid: string): Promise<IpfsImage | null> {
    for (const gateway of this.gateways) {
      let bytes: Uint8Array;
      try {
        bytes = await this.opts.fetchBytes(`${gateway}${cid}`);
      } catch {
        continue; // unreachable, rate-limited or too large here: try the next gateway
      }
      const ext = looksLikeSvg(bytes) ? null : detectImageExt(bytes);
      if (!ext) break; // the content itself is not an accepted image; another gateway would serve the same bytes
      const image = { bytes, contentType: IMAGE_CONTENT_TYPE[ext] };
      this.keep(cid, image);
      this.failedAt.delete(cid);
      return image;
    }
    if (this.failedAt.size > 10_000) this.failedAt.clear();
    this.failedAt.set(cid, this.now());
    return null;
  }

  private keep(cid: string, image: IpfsImage): void {
    if (image.bytes.byteLength > this.maxBytes) return;
    this.entries.set(cid, image);
    this.held += image.bytes.byteLength;
    for (const [key, old] of this.entries) {
      if (this.held <= this.maxBytes) break;
      this.entries.delete(key);
      this.held -= old.bytes.byteLength;
    }
  }
}
