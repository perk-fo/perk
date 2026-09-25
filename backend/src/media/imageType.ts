/** What an image file really is, from its first bytes (never from its name or a declared type). */

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.byteLength < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
  return true;
}

export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.includes("<svg");
}

export function detectImageExt(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" | null {
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

/** The Content-Type served for each accepted image kind. */
export const IMAGE_CONTENT_TYPE: Record<"png" | "jpg" | "webp" | "gif", string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
