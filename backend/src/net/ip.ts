/**
 * IP address parsing and classification, shared by the outbound fetch guard (only public addresses may be fetched)
 * and the rate limiter (clients are keyed by address, IPv6 by /64).
 */

/** Four octets, or null when `s` is not a dotted-decimal IPv4 address. */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, or null when `s` is not an IPv6 address. Accepts `::` and a trailing dotted IPv4 part. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = `${s.slice(0, lastColon + 1)}${tail.length ? "0:0" : ""}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Canonical text for an address: IPv4 dotted decimal (an IPv4-mapped IPv6 address becomes its IPv4 address), IPv6 as
 * eight lowercase groups without zero compression. Brackets and a port are dropped. null when it is not an address.
 */
export function normaliseIp(raw: string): string | null {
  let s = raw.trim();
  if (s === "") return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(":"));
  const v4 = parseIPv4(s);
  if (v4) return v4.join(".");
  const v6 = parseIPv6(s);
  if (!v6) return null;
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) return v4FromGroups(v6[6]!, v6[7]!);
  return v6.map((g) => g.toString(16)).join(":");
}

type Cidr4 = [number, number, number, number, number];

/** Special-purpose IPv4 ranges: nothing reachable from here should be fetched on a stranger's behalf. */
const BLOCKED_V4: Cidr4[] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // carrier-grade NAT (cloud metadata services live here too)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, including 169.254.169.254 instance metadata
  [172, 16, 0, 0, 12], // private
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, broadcast
];

function v4ToInt(o: number[]): number {
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

function inCidr4(ip: number, [a, b, c, d, bits]: Cidr4): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (v4ToInt([a, b, c, d]) & mask) >>> 0;
}

function isPublicV4(o: number[]): boolean {
  const ip = v4ToInt(o);
  return !BLOCKED_V4.some((cidr) => inCidr4(ip, cidr));
}

/** Whether the first `bits` bits of `g` equal those of `prefix` (both eight 16-bit groups). */
function inPrefix6(g: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((g[i]! & mask) !== (prefix[i]! & mask)) return false;
  }
  return true;
}

function isPublicV6(g: number[]): boolean {
  // IPv4 inside IPv6: mapped (::ffff:0:0/96) and the NAT64 well-known prefix (64:ff9b::/96) reach an IPv4 address
  if (inPrefix6(g, [0, 0, 0, 0, 0, 0xffff, 0, 0], 96) || inPrefix6(g, [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) {
    return isPublicV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
  }
  // 6to4 (2002::/16) carries an IPv4 address in bits 16-47
  if (g[0] === 0x2002) return isPublicV4([g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff]);
  // otherwise only global unicast (2000::/3) is public, minus its special-purpose blocks
  if (!inPrefix6(g, [0x2000, 0, 0, 0, 0, 0, 0, 0], 3)) return false; // ::, ::1, fc00::/7, fe80::/10, ff00::/8, ...
  if (inPrefix6(g, [0x2001, 0, 0, 0, 0, 0, 0, 0], 23)) return false; // IETF protocol assignments, Teredo
  if (inPrefix6(g, [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0], 32)) return false; // documentation
  if (inPrefix6(g, [0x3fff, 0, 0, 0, 0, 0, 0, 0], 20)) return false; // documentation
  return true;
}

/**
 * Whether `ip` is an ordinary public unicast address. Private, loopback, link-local, carrier-grade NAT, metadata,
 * documentation, multicast and reserved ranges are not, in IPv4 and IPv6 (including IPv4 carried inside IPv6).
 * Anything that does not parse as an address is not public either.
 */
export function isPublicAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIPv4(s);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(s);
  if (v6) return isPublicV6(v6);
  return false;
}

/**
 * The key a client is rate-limited under: its IPv4 address, or the /64 of its IPv6 address (one subscriber usually
 * gets a whole /64, so keying by full address would hand them 2^64 buckets).
 */
export function rateLimitKey(ip: string): string {
  const n = normaliseIp(ip);
  if (!n) return ip;
  if (!n.includes(":")) return n;
  const g = parseIPv6(n)!;
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`;
}
