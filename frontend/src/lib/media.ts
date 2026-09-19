/**
 * Token media: image + metadata JSON, uploaded through the Perk API (never straight from the browser to a pinning
 * service — the storage credentials stay on the server). The returned `uri` is what goes on-chain as tokenURI.
 */
import { API_URL, ApiRequestError } from "./api";
import type { MediaUpload } from "./api-types";

export type { MediaUpload };

export interface TokenLinks {
  x?: string;
  telegram?: string;
  website?: string;
}

/** Common token-metadata shape (image + description + links), readable by explorers and aggregators. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  /** flat copies of the links as most meme aggregators read them */
  twitter?: string;
  telegram?: string;
  website?: string;
  links: TokenLinks;
  createdOn: string;
}

const X_RE = /^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/;
const TG_RE = /^https:\/\/t\.me\/[A-Za-z0-9_+]{3,64}\/?$/;
const WEB_RE = /^https:\/\/[^\s/$.?#].[^\s]*$/;

/** Accepts "@handle", "handle" or a full URL; returns a canonical https URL or null when invalid. */
export function normalizeLink(kind: keyof TokenLinks, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (kind === "x") {
    const h = v.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//, "").replace(/\/$/, "");
    const url = `https://x.com/${h}`;
    return X_RE.test(url) ? url : null;
  }
  if (kind === "telegram") {
    const h = v.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?t\.me\//, "").replace(/\/$/, "");
    const url = `https://t.me/${h}`;
    return TG_RE.test(url) ? url : null;
  }
  // A bare host is upgraded to https, but anything that already carries a scheme must be http(s) — otherwise
  // "javascript:alert(1)" would be rewritten into a "https://javascript:alert(1)" that only looks like a URL.
  const scheme = /^[a-z][a-z0-9+.-]*:/i.test(v);
  if (scheme && !/^https?:\/\//i.test(v)) return null;
  const url = /^https?:\/\//i.test(v) ? v.replace(/^http:\/\//i, "https://") : `https://${v}`;
  if (!WEB_RE.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname.includes(".")) return null;
  } catch {
    return null;
  }
  return url;
}

export const DESCRIPTION_MAX = 280;

export function buildMetadata(input: {
  name: string;
  symbol: string;
  description: string;
  image: string;
  links: TokenLinks;
  now?: Date;
}): TokenMetadata {
  const links: TokenLinks = {};
  for (const k of ["x", "telegram", "website"] as const) {
    const v = input.links[k] ? normalizeLink(k, input.links[k]!) : null;
    if (v) links[k] = v;
  }
  return {
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    description: input.description.trim().slice(0, DESCRIPTION_MAX),
    image: input.image,
    ...(links.x ? { twitter: links.x } : {}),
    ...(links.telegram ? { telegram: links.telegram } : {}),
    ...(links.website ? { website: links.website } : {}),
    links,
    createdOn: "Perk",
  };
}

async function post<T>(path: string, body: BodyInit, json: boolean): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method: "POST",
      body,
      headers: json ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
    });
  } catch (err) {
    throw new ApiRequestError(0, "unreachable", err instanceof Error ? err.message : "network error");
  }
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const b = (await res.json()) as { error?: string; message?: string };
      if (b.error) code = b.error;
      if (b.message) message = b.message;
    } catch {
      /* non-JSON */
    }
    throw new ApiRequestError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function uploadImage(file: File): Promise<MediaUpload> {
  const fd = new FormData();
  fd.append("file", file);
  return post<MediaUpload>("/v1/media/image", fd, false);
}

export function uploadMetadata(meta: TokenMetadata): Promise<MediaUpload> {
  return post<MediaUpload>("/v1/media/metadata", JSON.stringify(meta), true);
}
