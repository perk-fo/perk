/**
 * HashEgg — the default picture of a launch: an Easter egg generated from its configHash. The hash picks the shell
 * colour, the decoration (speckles, zigzag band, stripes, polka dots, waves, blossoms, a dipped two-tone base or a
 * hatching crack), the decoration's colours, the egg's width and a slight tilt. Nothing is random: the same hash
 * always gives the same egg, so the preview on /launch and the on-chain record look identical. The launch's module
 * bits sit as five small dots in the nest under the egg (from 44px up). Without a hash it draws the dashed outline
 * used as a loading placeholder.
 */
import type { CSSProperties, ReactNode } from "react";

const MODULE_BITS = 5;

/** Shell colours, each with the inks that read on it. `name` keys the trait label (egg.shell.*). */
export const SHELLS: ReadonlyArray<{ name: string; fill: string; inks: readonly string[] }> = [
  { name: "yolk", fill: "#FCD53F", inks: ["#1C1C1C", "#FF822D", "#FFFFFF"] },
  { name: "tangerine", fill: "#FF9A4D", inks: ["#1C1C1C", "#FFF1C9", "#FCD53F"] },
  { name: "mint", fill: "#8FE0B8", inks: ["#1C1C1C", "#FFFFFF", "#FF822D"] },
  { name: "sky", fill: "#8EC5FF", inks: ["#1C1C1C", "#FFFFFF", "#FCD53F"] },
  { name: "lilac", fill: "#C3B1FF", inks: ["#1C1C1C", "#FFFFFF", "#FCD53F"] },
  { name: "pink", fill: "#FFB0C8", inks: ["#1C1C1C", "#FFFFFF", "#FF822D"] },
  { name: "cream", fill: "#FFF1C9", inks: ["#FF822D", "#1C1C1C", "#8FE0B8"] },
  { name: "charcoal", fill: "#34342F", inks: ["#FCD53F", "#FFB0C8", "#8FE0B8"] },
  { name: "white", fill: "#EDECE4", inks: ["#FF822D", "#1C1C1C", "#8EC5FF"] },
  { name: "honey", fill: "#F9C23C", inks: ["#1C1C1C", "#FFFFFF", "#FF822D"] },
];

/** The decorations, in the order `decoration()` draws them; keys the trait label (egg.pattern.*). */
export const PATTERNS = ["speckles", "zigzag", "stripes", "polka", "waves", "blossoms", "dipped", "crack"] as const;

export function bytesOf(hash: string): number[] {
  const h = hash.replace(/^0x/, "").padEnd(64, "0").slice(0, 64);
  const out: number[] = [];
  for (let i = 0; i < 32; i++) out.push(parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return out;
}

/** An egg standing in a 120-unit box: pointed top at y=12, widest at y=74, base at y=108. */
export function eggPath(hw: number): string {
  const cx = 60;
  const top = 12;
  const bot = 108;
  const cy = 74;
  return [
    `M${cx} ${top}`,
    `C${cx + hw * 0.62} ${top} ${cx + hw} ${cy - 32} ${cx + hw} ${cy}`,
    `C${cx + hw} ${cy + 22} ${cx + hw * 0.58} ${bot} ${cx} ${bot}`,
    `C${cx - hw * 0.58} ${bot} ${cx - hw} ${cy + 22} ${cx - hw} ${cy}`,
    `C${cx - hw} ${cy - 32} ${cx - hw * 0.62} ${top} ${cx} ${top} Z`,
  ].join(" ");
}

function zigzag(y: number, amp: number, step: number): string {
  const pts: string[] = [];
  for (let x = 10, i = 0; x <= 110; x += step, i++) pts.push(`${x} ${i % 2 === 0 ? y - amp : y + amp}`);
  return `M${pts.join(" L")}`;
}

function wave(y: number, amp: number): string {
  let d = `M10 ${y}`;
  for (let x = 10; x < 110; x += 20) d += ` Q${x + 5} ${y - amp} ${x + 10} ${y} T${x + 20} ${y}`;
  return d;
}

function blossom(x: number, y: number, r: number, colour: string, heart: string, key: string | number): ReactNode {
  return (
    <g key={key}>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        return <circle key={i} cx={x + r * 0.62 * Math.cos(a)} cy={y + r * 0.62 * Math.sin(a)} r={r * 0.5} fill={colour} />;
      })}
      <circle cx={x} cy={y} r={r * 0.36} fill={heart} />
    </g>
  );
}

/** The decoration for pattern `kind`, in the egg's coordinates (clipped to the shell by the caller). */
export function decoration(kind: number, b: number[], ink: string, accent: string): ReactNode {
  switch (kind) {
    case 0: // speckles, like a quail egg
      return Array.from({ length: 16 }, (_, i) => {
        const x = 26 + (b[(i * 2) % 32]! % 68);
        const y = 20 + (b[(i * 2 + 1) % 32]! % 84);
        const r = 1.8 + (b[(i + 5) % 32]! % 4) * 0.9;
        return <circle key={i} cx={x} cy={y} r={r} fill={i % 4 === 0 ? accent : ink} opacity={0.85} />;
      });
    case 1: // a zigzag band with thin rules
      return (
        <g fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path d={zigzag(66, 6, 10)} stroke={ink} strokeWidth={7} />
          <path d="M10 52H110M10 80H110" stroke={accent} strokeWidth={3} />
          {[34, 94].map((y) => (
            <path key={y} d={zigzag(y, 3, 7)} stroke={accent} strokeWidth={2.4} />
          ))}
        </g>
      );
    case 2: // stripes
      return (
        <g>
          <rect x="0" y="38" width="120" height="9" fill={ink} />
          <rect x="0" y="60" width="120" height="14" fill={accent} />
          <rect x="0" y="87" width="120" height="9" fill={ink} />
        </g>
      );
    case 3: // polka dots
      return Array.from({ length: 30 }, (_, i) => {
        const row = Math.floor(i / 5);
        const x = 26 + (i % 5) * 17 + (row % 2) * 8.5;
        const y = 22 + row * 16;
        return <circle key={i} cx={x} cy={y} r={4.6} fill={row % 2 ? accent : ink} />;
      });
    case 4: // waves
      return (
        <g fill="none" strokeLinecap="round">
          <path d={wave(50, 8)} stroke={ink} strokeWidth={5} />
          <path d={wave(72, 8)} stroke={accent} strokeWidth={5} />
          <path d={wave(94, 8)} stroke={ink} strokeWidth={5} />
        </g>
      );
    case 5: // the brand's blossoms
      return Array.from({ length: 7 }, (_, i) => {
        const x = 30 + (b[(i * 3) % 32]! % 60);
        const y = 28 + (b[(i * 3 + 1) % 32]! % 72);
        const petals = i % 3 === 0 ? accent : ink;
        return blossom(x, y, 5 + (b[(i * 3 + 2) % 32]! % 3), petals, petals === ink ? accent : ink, i);
      });
    case 6: // dipped: a second colour on the lower half with a wavy edge, dots on the line
      return (
        <g>
          <path d={`${wave(70, 7)} L110 120 L10 120 Z`} fill={accent} />
          {[26, 44, 60, 76, 94].map((x) => (
            <circle key={x} cx={x} cy={56} r={3} fill={ink} />
          ))}
        </g>
      );
    default: // hatching: a crack across the shell
      return (
        <path
          d="M18 50 L30 42 L40 52 L52 40 L62 52 L74 41 L84 51 L96 43 L106 50"
          fill="none"
          stroke={ink}
          strokeWidth={3.4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      );
  }
}

/** The shell a hash gets: colour, ink, accent, decoration kind, width and tilt. */
export function eggLook(hash: string | undefined) {
  const b = bytesOf(hash && !/^0x0*$/.test(hash) ? hash : "0x00");
  const shell = SHELLS[b[0]! % SHELLS.length]!;
  const kind = b[2]! % 8;
  return {
    b,
    shell: shell.name,
    pattern: PATTERNS[kind]!,
    fill: shell.fill,
    ink: shell.inks[b[1]! % shell.inks.length]!,
    accent: shell.inks[(b[1]! + 1 + (b[4]! % 2)) % shell.inks.length]!,
    kind,
    hw: 35 + (b[3]! % 5),
    tilt: ((b[5]! % 5) - 2) * 4,
  };
}

export function HashEgg({
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
  /** lights every module dot (card hover state) */
  hover?: boolean;
}) {
  const empty = !hash || /^0x0*$/.test(hash);
  // hw 35..39: some eggs rounder, some slimmer; tilt -8..8 degrees
  const { b, fill, ink, accent, kind, hw, tilt } = eggLook(hash);
  const id = `egg-${(hash ?? "0").slice(2, 14)}-${size}`;
  const path = eggPath(hw);
  const bits = moduleBitmap === undefined ? undefined : BigInt(moduleBitmap);
  const showBits = !empty && bits !== undefined && size >= 44;

  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={className} style={style} role="img" aria-label={title ?? "launch egg"}>
      {title ? <title>{title}</title> : null}
      {/* the nest: a soft shadow, with the module bits as five dots */}
      <ellipse cx="60" cy="110" rx={hw * 0.9} ry="6" fill="currentColor" opacity={empty ? 0.06 : 0.1} />
      {showBits &&
        Array.from({ length: MODULE_BITS }, (_, i) => {
          const on = ((bits! >> BigInt(i)) & 1n) === 1n;
          return (
            <circle
              key={i}
              cx={44 + i * 8}
              cy={110}
              r={2.4}
              fill={on ? "#FF822D" : "none"}
              stroke={on ? "none" : "currentColor"}
              strokeOpacity={0.35}
              opacity={on || hover ? 1 : 0.5}
              style={{ transition: "opacity 160ms ease-out" }}
            />
          );
        })}
      {empty ? (
        <path d={path} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={2.4} strokeDasharray="6 5" />
      ) : (
        <g transform={`rotate(${tilt} 60 104)`}>
          <defs>
            <clipPath id={`${id}-clip`}>
              <path d={path} />
            </clipPath>
            <radialGradient id={`${id}-shade`} cx="38%" cy="32%" r="75%">
              <stop offset="55%" stopColor="#000" stopOpacity="0" />
              <stop offset="100%" stopColor="#000" stopOpacity="0.2" />
            </radialGradient>
          </defs>
          <path d={path} fill={fill} />
          <g clipPath={`url(#${id}-clip)`}>
            {decoration(kind, b, ink, accent)}
            <path d={path} fill={`url(#${id}-shade)`} />
          </g>
          {/* gloss */}
          <ellipse cx="44" cy="36" rx="7" ry="12" fill="#fff" opacity="0.42" transform="rotate(24 44 36)" />
          {/* the outline follows the text colour, so a charcoal egg still stands out on the dark theme */}
          <path d={path} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.8" />
        </g>
      )}
    </svg>
  );
}
