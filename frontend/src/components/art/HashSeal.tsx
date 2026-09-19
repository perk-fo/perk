/**
 * HashSeal — a deterministic seal generated from a launch's configHash, shaped like the Perk mark:
 * a round plate with a "P" notch cut out, a four-point sparkle at the heart, and module ticks on the rim.
 * Same hash → same seal, so the preview in /create and the on-chain record must render identically.
 */
import type { CSSProperties } from "react";

const LIME = "#D6FD3E";
const INK = "#0F1D1D";
const MIST = "#E9F2EA";
const TINTS = ["#D6FD3E", "#A7E34A", "#7BE3B5", "#E9F2EA", "#F2C14E", "#B4F06B"];
const MODULE_BITS = 5;

function bytesOf(hash: string): number[] {
  const h = hash.replace(/^0x/, "").padEnd(64, "0").slice(0, 64);
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return out;
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
  // plate: lime or ink, decided by the first byte; the figure colour is the opposite
  const limePlate = (b[0] & 1) === 1;
  const plate = limePlate ? LIME : INK;
  const figure = limePlate ? INK : TINTS[b[1] % 3]; // on ink plates only the bright tints
  const accent = limePlate ? INK : LIME;
  // notch angle (the "P" cut) and rotation of the inner figure
  const notchAngle = (b[2] % 8) * 45; // 0..315
  const rot = (b[3] % 12) * 30;
  // inner figure: 6 rounded bars/dots around the sparkle, lengths from bytes, 3-fold symmetry
  const bars = Array.from({ length: 6 }, (_, i) => {
    const byte = b[4 + (i % 3)];
    return { angle: i * 60 + rot, len: 10 + (byte % 14), width: 4 + ((byte >> 4) % 4), dot: (byte & 8) === 8 };
  });
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
      <defs>
        <mask id={`notch-${(hash ?? "0").slice(2, 10)}`}>
          <rect width="120" height="120" fill="white" />
          {/* the P cut: a wedge from the centre out through the rim, softened by a round end */}
          <g transform={`rotate(${notchAngle} 60 60)`}>
            <rect x="56" y="60" width="8" height="70" fill="black" />
            <circle cx="60" cy="60" r="7" fill="black" />
          </g>
        </mask>
      </defs>
      {/* rim ticks (module bits) */}
      {ticks.map((t, i) => (
        <line
          key={i}
          x1="60"
          y1="3"
          x2="60"
          y2={t.on ? "11" : "7"}
          transform={`rotate(${t.angle} 60 60)`}
          stroke={empty ? "currentColor" : t.on ? LIME : MIST}
          strokeOpacity={empty ? 0.25 : t.on || hover ? 1 : 0.35}
          strokeWidth={t.on ? 3 : 1.5}
          strokeLinecap="round"
          style={{ transition: "stroke-opacity 160ms ease-out" }}
        />
      ))}
      {/* plate with the notch */}
      <g mask={empty ? undefined : `url(#notch-${(hash ?? "0").slice(2, 10)})`}>
        <circle
          cx="60"
          cy="60"
          r="46"
          fill={empty ? "transparent" : plate}
          stroke={empty ? "currentColor" : LIME}
          strokeOpacity={empty ? 0.25 : limePlate ? 0 : 0.9}
          strokeWidth={2}
        />
        {!empty &&
          bars.map((bar, i) => (
            <g key={i} transform={`rotate(${bar.angle} 60 60)`}>
              {bar.dot ? (
                <circle cx="60" cy={60 - 22 - bar.len / 2} r={bar.width} fill={figure} />
              ) : (
                <rect x={60 - bar.width / 2} y={60 - 22 - bar.len} width={bar.width} height={bar.len} rx={bar.width / 2} fill={figure} />
              )}
            </g>
          ))}
      </g>
      {/* sparkle at the heart, always drawn (also for the empty outline seal) */}
      <path
        d="M60 44 C61.5 53 63 54.5 72 56 C63 57.5 61.5 59 60 68 C58.5 59 57 57.5 48 56 C57 54.5 58.5 53 60 44 Z"
        fill={empty ? "currentColor" : accent}
        fillOpacity={empty ? 0.35 : 1}
      />
    </svg>
  );
}
