/**
 * Each demo token gets a real image (a cute portrait of the animal it is named after) and metadata JSON, uploaded
 * through the API exactly as the launch form does.
 * That keeps the lists and token pages looking like the product instead of a wall of placeholders, and it exercises
 * the media path end to end.
 */
import { deflateSync } from "node:zlib";
import { drawAnimal } from "./animals";

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}


/** A 192×192 PNG portrait of the animal in the token's name (see animals.ts). */
export function tokenImage(name: string): Uint8Array {
  const size = 192;
  const raw = drawAnimal(name, size);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

export interface TokenMetadataInput {
  name: string;
  symbol: string;
  description: string;
  seed: number;
}

/**
 * Uploads the image then the metadata JSON and returns the URI to put on-chain. Returns null when the API is not
 * reachable — a demo token without an image is far better than a driver that stalls.
 */
export async function uploadTokenMetadata(apiUrl: string, input: TokenMetadataInput): Promise<string | null> {
  try {
    const form = new FormData();
    const png = tokenImage(input.name);
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), `${input.symbol}.png`);
    const imgRes = await fetch(`${apiUrl}/v1/media/image`, { method: "POST", body: form });
    if (!imgRes.ok) return null;
    const img = (await imgRes.json()) as { uri: string };

    const metaRes = await fetch(`${apiUrl}/v1/media/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        symbol: input.symbol,
        description: input.description,
        image: img.uri,
        links: { website: "https://perk.example" },
      }),
    });
    if (!metaRes.ok) return null;
    return ((await metaRes.json()) as { uri: string }).uri;
  } catch {
    return null;
  }
}
