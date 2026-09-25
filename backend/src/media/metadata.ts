import type { TokenMetadataView } from "../api/types";
import { hasControlChars } from "../db/text";
import { ipfsToHttps, localMediaFilename } from "./store";

const NAME_MAX = 64;
const SYMBOL_MAX = 16;
const DESCRIPTION_MAX = 280;

export type ImageRule = "issued" | "resolved";

export interface ParsedMetadata {
  canonical: Record<string, unknown>;
  canonicalJson: string;
  view: TokenMetadataView;
}

/**
 * A string that may be stored and shown: no control characters (line breaks allowed in free text only) and no
 * unpaired surrogates. Postgres rejects U+0000 in text and jsonb, and nothing else in that range belongs in a name,
 * a symbol or an address.
 */
function isCleanString(v: unknown, freeText = false): v is string {
  return typeof v === "string" && v.isWellFormed() && !hasControlChars(v, freeText);
}

function isNonEmptyString(v: unknown): v is string {
  return isCleanString(v);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u;
  } catch {
    return null;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase();
}

function validX(u: URL): boolean {
  const h = hostOf(u);
  return h === "x.com" || h === "www.x.com" || h === "twitter.com" || h === "www.twitter.com";
}

function validTelegram(u: URL): boolean {
  const h = hostOf(u);
  return h === "t.me" || h === "www.t.me";
}

function validWebsite(u: URL): boolean {
  return u.protocol === "https:";
}

function parseOptionalHttps(
  value: unknown,
  check: (u: URL) => boolean,
): { ok: true; url?: string } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (!isNonEmptyString(value)) return { ok: false };
  const u = httpsUrl(value);
  if (!u || !check(u)) return { ok: false };
  return { ok: true, url: value };
}

export function isIpfsUri(uri: string): boolean {
  if (!uri.startsWith("ipfs://")) return false;
  const rest = uri.slice("ipfs://".length);
  return rest.length > 0 && !/\s/.test(rest) && !rest.includes("..") && !rest.includes("\\");
}

export function isIssuedImageUri(uri: string, publicApiUrl: string): boolean {
  const file = localMediaFilename(uri, publicApiUrl);
  if (file) return /\.(png|jpg|webp|gif)$/.test(file);
  return isIpfsUri(uri);
}

export function isResolvedImageUri(uri: string, publicApiUrl: string): boolean {
  if (isIssuedImageUri(uri, publicApiUrl)) return true;
  if (!uri.startsWith("https://")) return false;
  return httpsUrl(uri) !== null;
}

export function browserImageUrl(image: string, _publicApiUrl: string, ipfsGateway: string): string | null {
  if (isIpfsUri(image)) return ipfsToHttps(image, ipfsGateway);
  if (image.startsWith("https://") || image.startsWith("http://")) return image;
  return null;
}

function sameOrMissing(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  return a === b;
}

/**
 * Validate a token metadata JSON object. `issued` requires the image URI to be one this API returns
 * (local /v1/media/... or ipfs://). `resolved` also accepts any https:// image.
 */
export function parseTokenMetadata(
  input: unknown,
  opts: { imageRule: ImageRule; publicApiUrl: string; ipfsGateway: string },
): ParsedMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;

  if (!isNonEmptyString(o.name) || o.name.length < 1 || o.name.length > NAME_MAX) return null;
  if (!isNonEmptyString(o.symbol) || o.symbol.length < 1 || o.symbol.length > SYMBOL_MAX) return null;

  let description = "";
  if (o.description !== undefined && o.description !== null) {
    if (!isCleanString(o.description, true) || o.description.length > DESCRIPTION_MAX) return null;
    description = o.description;
  }

  if (!isNonEmptyString(o.image)) return null;
  const imageOk = opts.imageRule === "issued" ? isIssuedImageUri(o.image, opts.publicApiUrl) : isResolvedImageUri(o.image, opts.publicApiUrl);
  if (!imageOk) return null;

  const linksIn = o.links;
  if (linksIn !== undefined && linksIn !== null && (typeof linksIn !== "object" || Array.isArray(linksIn))) return null;
  const linksObj = (linksIn ?? {}) as Record<string, unknown>;

  const x = parseOptionalHttps(linksObj.x, validX);
  const tg = parseOptionalHttps(linksObj.telegram, validTelegram);
  const web = parseOptionalHttps(linksObj.website, validWebsite);
  if (!x.ok || !tg.ok || !web.ok) return null;

  const twitter = parseOptionalHttps(o.twitter, validX);
  const flatTg = parseOptionalHttps(o.telegram, validTelegram);
  const flatWeb = parseOptionalHttps(o.website, validWebsite);
  if (!twitter.ok || !flatTg.ok || !flatWeb.ok) return null;

  if (!sameOrMissing(x.url, twitter.url)) return null;
  if (!sameOrMissing(tg.url, flatTg.url)) return null;
  if (!sameOrMissing(web.url, flatWeb.url)) return null;

  const xUrl = x.url ?? twitter.url;
  const tgUrl = tg.url ?? flatTg.url;
  const webUrl = web.url ?? flatWeb.url;

  const links: TokenMetadataView["links"] = {};
  if (xUrl) links.x = xUrl;
  if (tgUrl) links.telegram = tgUrl;
  if (webUrl) links.website = webUrl;

  const canonical: Record<string, unknown> = {
    description,
    image: o.image,
    name: o.name,
    symbol: o.symbol,
  };
  if (Object.keys(links).length > 0) {
    const sortedLinks: Record<string, string> = {};
    if (links.telegram) sortedLinks.telegram = links.telegram;
    if (links.website) sortedLinks.website = links.website;
    if (links.x) sortedLinks.x = links.x;
    canonical.links = sortedLinks;
  }
  if (tgUrl) canonical.telegram = tgUrl;
  if (xUrl) canonical.twitter = xUrl;
  if (webUrl) canonical.website = webUrl;

  const canonicalJson = JSON.stringify(sortKeys(canonical));
  const image = browserImageUrl(o.image, opts.publicApiUrl, opts.ipfsGateway);
  return {
    canonical,
    canonicalJson,
    view: {
      image,
      description: description.length > 0 ? description : null,
      links,
    },
  };
}
