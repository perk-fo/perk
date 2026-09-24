/**
 * HashSeal — a deterministic stamp generated from a launch's configHash, in the Perk chick's colours: a round plate
 * with a zigzag rim (the egg's crack), a pattern of rounded bars and dots in three-fold symmetry, the brand
 * asterisk at the heart, and module ticks outside the rim. Same hash → same seal, so the preview on /launch and the
 * on-chain record render identically. Without a hash it draws the empty outline used as a loading placeholder.
 */
import type { CSSProperties } from "react";

// The mark's colours, the same in both themes (globals.css --brand-*).
const YOLK = "rgb(var(--brand-yellow))";
const HONEY = "rgb(var(--brand-amber))";
const TANGERINE = "rgb(var(--brand-orange))";
const CHARCOAL = "rgb(var(--brand-charcoal))";
const CREAM = "rgb(255 247 214)";
const MIST = "rgb(var(--c-faint))";
const MODULE_BITS = 5;
const TEETH = 18;

/** Plates and the colours drawn on them: [plate, figure, heart]. Chosen by the first byte of the hash. */
const SCHEMES: ReadonlyArray<readonly [string, string, string]> = [
  [YOLK, CHARCOAL, TANGERINE],
  [CHARCOAL, YOLK, TANGERINE],
  [TANGERINE, CHARCOAL, CREAM],
  [CHARCOAL, TANGERINE, YOLK],
  [HONEY, CHARCOAL, CREAM],
  [CREAM, TANGERINE, CHARCOAL],
];

function bytesOf(hash: string): number[] {
  const h = hash.replace(/^0x/, "").padEnd(64, "0").slice(0, 64);
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return out;
}

/** The zigzag plate outline: TEETH points on an outer radius, TEETH notches on an inner one. */
function rimPath(outer: number, inner: number, turn: number): string {
  const pts: string[] = [];
  for (let i = 0; i < TEETH * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((i * 180) / TEETH + turn - 90) * (Math.PI / 180);
    pts.push(`${(60 + r * Math.cos(a)).toFixed(2)} ${(60 + r * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join(" L")} Z`;
}

export function HashSeal({
  hash,
  size = 64,
  moduleBitmap,
  className,
  style,
  title,
  hover = false,
}: {
  hash?: string;
  size?: number;
  moduleBitmap?: bigint | number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  /** lights every rim tick (card hover state) */
  hover?: boolean;
}) {
  const empty = !hash || /^0x0*$/.test(hash);
  const b = bytesOf(empty ? "0x00" : hash!);
  const [plate, figure, heart] = SCHEMES[b[0] % SCHEMES.length]!;
  const turn = (b[2] % TEETH) * (180 / TEETH) * 0.5;
  const rot = (b[3] % 12) * 30;
  // inner figure: 6 rounded bars/dots around the heart, lengths from bytes, 3-fold symmetry
  const bars = Array.from({ length: 6 }, (_, i) => {
    const byte = b[4 + (i % 3)]!;
    return { angle: i * 60 + rot, len: 8 + (byte % 12), width: 4 + ((byte >> 4) % 4), dot: (byte & 8) === 8 };
  });
  // a second ring of small dots on alternate bytes gives most hashes a distinct outer pattern
  const ring = Array.from({ length: 6 }, (_, i) => ({ angle: i * 60 + rot + 30, on: ((b[8]! >> i) & 1) === 1 }));
  const bits = moduleBitmap === undefined ? undefined : BigInt(moduleBitmap);
  const ticks = Array.from({ length: MODULE_BITS }, (_, i) => ({
    on: bits === undefined ? true : ((bits >> BigInt(i)) & 1n) === 1n,
    angle: i * (360 / MODULE_BITS),
  }));

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      style={style}
      role="img"
      aria-label={title ?? "config seal"}
    >
      {title ? <title>{title}</title> : null}
      {/* module ticks outside the rim */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1="60"
          y1="2.5"
          x2="60"
          y2={t.on ? "9.5" : "6.5"}
          transform={`rotate(${t.angle} 60 60)`}
          stroke={empty ? "currentColor" : t.on ? TANGERINE : MIST}
          strokeOpacity={empty ? 0.25 : t.on || hover ? 1 : 0.4}
          strokeWidth={t.on ? 3.2 : 1.6}
          strokeLinecap="round"
          style={{ transition: "stroke-opacity 160ms ease-out" }}
        />
      ))}
      {empty ? (
        <path
          d={rimPath(48, 43, 0)}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.28}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      ) : (
        <>
          <path d={rimPath(48, 43, turn)} fill={plate} stroke={CHARCOAL} strokeOpacity={0.12} strokeWidth={1.5} strokeLinejoin="round" />
          {/* an inner ring line, like the edge of a stamp */}
          <circle cx="60" cy="60" r="36" fill="none" stroke={figure} strokeOpacity={0.22} strokeWidth={1.4} strokeDasharray="2 4" />
          {bars.map((bar, i) => (
            <g key={i} transform={`rotate(${bar.angle} 60 60)`}>
              {bar.dot ? (
                <circle cx="60" cy={60 - 16 - bar.len / 2} r={bar.width} fill={figure} />
              ) : (
                <rect x={60 - bar.width / 2} y={60 - 16 - bar.len} width={bar.width} height={bar.len} rx={bar.width / 2} fill={figure} />
              )}
            </g>
          ))}
          {ring.map((d, i) =>
            d.on ? (
              <circle key={i} cx="60" cy="27" r="2.4" transform={`rotate(${d.angle} 60 60)`} fill={heart} />
            ) : null,
          )}
        </>
      )}
      {/* the brand asterisk at the heart, always drawn (also on the empty outline) */}
      <g
        stroke={empty ? "currentColor" : heart}
        strokeOpacity={empty ? 0.35 : 1}
        strokeWidth={4.2}
        strokeLinecap="round"
        transform={`rotate(${empty ? 0 : rot / 2} 60 60)`}
      >
        <path d="M60 50.5V69.5" />
        <path d="M50.5 60H69.5" />
        <path d="M53.3 53.3L66.7 66.7" />
        <path d="M66.7 53.3L53.3 66.7" />
      </g>
    </svg>
  );
}
