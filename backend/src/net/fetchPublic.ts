import { lookup as dnsLookup } from "node:dns/promises";
import { isPublicAddress, normaliseIp, parseIPv4 } from "./ip";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Every address `hostname` resolves to. */
export type LookupFn = (hostname: string) => Promise<string[]>;

export const systemLookup: LookupFn = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** The URL, or a redirect it led to, points somewhere this server does not fetch. Asking again will not help. */
export class UrlRefusedError extends Error {
  override name = "UrlRefusedError";
}

/** The fetch did not produce a usable answer this time (status, size, time, DNS). The message is safe to show. */
export class FetchFailedError extends Error {
  override name = "FetchFailedError";
}

export interface FetchPublicOptions {
  fetch?: FetchLike;
  lookup?: LookupFn;
  /** One deadline for every hop and the body. */
  timeoutMs: number;
  maxBytes: number;
  /** Default 3. */
  maxRedirects?: number;
}

/**
 * GET a URL someone else chose (a token's metadata, a grant dataset) without letting them point this server at itself
 * or at its private network:
 *   - https only, at every hop, so a redirect cannot downgrade to http;
 *   - the host must resolve to public addresses only (IPv4 and IPv6, checked after DNS; see ip.ts);
 *   - redirects are followed by hand, at most `maxRedirects`, and each hop is checked the same way;
 *   - one deadline covers every hop and the body, which is capped at `maxBytes`.
 * Returns the body of a 2xx answer. Throws UrlRefusedError, FetchFailedError or the runtime's own fetch error.
 *
 * Not covered: fetch() resolves the host again when it connects, so a host that changes its DNS answer between the
 * check and the connection (DNS rebinding) can still reach a private address. An egress firewall closes that gap.
 */
export async function fetchPublic(rawUrl: string, opts: FetchPublicOptions): Promise<Uint8Array> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const lookup = opts.lookup ?? systemLookup;
  const maxRedirects = opts.maxRedirects ?? 3;
  const deadline = Date.now() + opts.timeoutMs;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = await checkUrl(rawUrl, lookup);
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(url.href, { redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await discard(res);
      if (hop >= maxRedirects) throw new UrlRefusedError("too many redirects");
      url = await checkUrl(new URL(location, url).href, lookup);
      continue;
    }
    if (!res.ok) {
      await discard(res);
      throw new FetchFailedError(`HTTP ${res.status}`);
    }
    return readBody(res, opts.maxBytes, deadline);
  }
}

/** IPv4 ranges accepted besides public addresses (config.fetchAllowRanges; local development only). */
let allowedRanges: Array<{ base: number; mask: number }> = [];

/** Accept these IPv4 CIDR ranges as fetch targets too. Throws on a malformed range. */
export function allowAddressRanges(cidrs: string[]): void {
  allowedRanges = cidrs.map((cidr) => {
    const [addr, bits] = cidr.trim().split("/");
    const octets = parseIPv4(addr ?? "");
    const prefix = Number(bits);
    if (!octets || !Number.isInteger(prefix) || prefix < 8 || prefix > 32) throw new Error(`bad range: ${cidr}`);
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
    return { base: (toUint32(octets) & mask) >>> 0, mask };
  });
}

function toUint32(o: number[]): number {
  return (((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!) >>> 0;
}

function acceptable(ip: string): boolean {
  if (isPublicAddress(ip)) return true;
  const v4 = parseIPv4(ip.trim());
  if (!v4) return false;
  const n = toUint32(v4);
  return allowedRanges.some((r) => ((n & r.mask) >>> 0) === r.base);
}

async function checkUrl(raw: string, lookup: LookupFn): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRefusedError("not a URL");
  }
  if (url.protocol !== "https:") throw new UrlRefusedError(`only https URLs are fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new UrlRefusedError("URLs with credentials are not fetched");
  // the URL parser has already turned numeric hosts (0x7f.1, 2130706433) into dotted decimal
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = normaliseIp(host);
  let addresses: string[];
  if (literal) {
    addresses = [host];
  } else {
    try {
      addresses = await lookup(host);
    } catch {
      throw new FetchFailedError("the host does not resolve");
    }
  }
  if (addresses.length === 0) throw new FetchFailedError("the host does not resolve");
  if (!addresses.every(acceptable)) throw new UrlRefusedError("the host is not a public address");
  return url;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

/** Read a response body, refusing more than `maxBytes` or any byte after `deadline` (ms since epoch). */
export async function readBody(res: Response, maxBytes: number, deadline: number): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared !== null && declared !== "") {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      await discard(res);
      throw new FetchFailedError(`the body exceeds ${maxBytes} bytes`);
    }
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new FetchFailedError(`the body exceeds ${maxBytes} bytes`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new FetchFailedError("timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FetchFailedError("timed out")), left);
      });
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await Promise.race([reader.read(), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      if (!step.value) continue;
      total += step.value.byteLength;
      if (total > maxBytes) throw new FetchFailedError(`the body exceeds ${maxBytes} bytes`);
      chunks.push(step.value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    throw err;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return buf;
}
