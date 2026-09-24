"use client";

import { useId, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { decoration, eggLook, eggPath } from "./HashEgg";
import { HatchlingArt } from "./Hatchling";

/**
 * Every launch is an egg until it graduates. The shell is the launch's own Easter egg (generated from its configHash);
 * inside is the creature: the artwork its creator uploaded, or a hatchling generated from the same hash.
 *
 *   sealed     on the curve: the egg. In lists, hovering it (or the card or row around it) lifts the top of the
 *              shell and the creature peeks out; moving away closes it again.
 *   cracking   threshold reached, graduation pending: the shell is ajar and trembles.
 *   hatched    graduated: the creature itself, centred in a round frame and never moved or resized to make room for
 *              anything; a few flat pieces of shell (the egg's own colours and pattern) lie on the ground to either
 *              side of its base. The token page plays the hatch once.
 *   refunding  the egg stays sealed and goes grey.
 *
 * `mode="detail"` (the token page) swaps the hover peek for an X-ray lens that follows the pointer (a tap toggles it
 * on touch screens). The reveal is play, not secrecy: the artwork is public in the token's metadata anyway.
 */
export type AvatarState = "sealed" | "cracking" | "hatched" | "refunding";

export function avatarState(status: number | undefined): AvatarState {
  if (status === 3) return "hatched";
  if (status === 2) return "cracking";
  if (status === 4) return "refunding";
  return "sealed";
}

// The crack between the top of the shell and the bottom: a zigzag across the egg.
const ZIGZAG: ReadonlyArray<readonly [number, number]> = [
  [4, 58], [14, 58], [23, 52], [32, 63], [41, 52], [50, 63], [60, 52], [70, 63], [79, 52], [88, 63], [97, 52], [106, 58], [116, 58],
];
const ZZ = ZIGZAG.map(([x, y]) => `${x} ${y}`).join(" L");
const CAP_CLIP = `M0 0 H120 V58 L${[...ZIGZAG].reverse().map(([x, y]) => `${x} ${y}`).join(" L")} L0 58 Z`;
const BOTTOM_CLIP = `M0 120 V58 L${ZZ} L120 58 V120 Z`;

/** The round frame a hatched creature sits in: centred in the picture, so the artwork is never displaced. */
const FRAME_R = 45;

/** Where the pieces of a hatched egg lie: one ground line for all of them, just under the frame. */
const GROUND = 112;

/**
 * The pieces of a hatched egg, seen from the side as they lie on the ground: each has a flat bottom on GROUND and a
 * low, jagged top, like a flake of shell fallen flat. `shape` is the outline with its base at y = 0; `x` is where its
 * left end lies. Neighbouring pieces overlap as fallen pieces do. `src` picks which part of the egg's pattern the
 * piece carries; `inside` pieces landed face up and show the pale inside of the shell. Small pictures keep the
 * pieces marked `keep`. Later pieces lie on top of earlier ones.
 */
const SHARDS: ReadonlyArray<{
  shape: string;
  x: number;
  src: readonly [number, number];
  inside?: boolean;
  keep?: boolean;
}> = [
  // left of the frame
  { shape: "M0 0 L2.8 -3.6 L5.6 -3.7 L8.3 -6.0 L11.1 -5.1 L13.9 -6.5 L16.7 -4.6 L19.4 -5.1 L22.2 -2.2 L25.0 0 Z", x: 8, src: [34, 40], keep: true },
  { shape: "M0 0 L2.5 -2.2 L5.0 -4.6 L7.5 -3.8 L10.0 -4.6 L12.5 -2.2 L15.0 0 Z", x: 28, src: [60, 80], inside: true },
  { shape: "M0 0 L2.0 -2.4 L4.0 -1.6 L6.0 0 Z", x: 3, src: [70, 60] },
  // right of the frame
  { shape: "M0 0 L2.8 -2.3 L5.5 -5.2 L8.2 -4.7 L11.0 -6.4 L13.8 -4.7 L16.5 -5.2 L19.2 -2.3 L22.0 0 Z", x: 86, src: [80, 50], keep: true },
  { shape: "M0 0 L2.4 -3.3 L4.8 -3.3 L7.2 -4.4 L9.6 -2.2 L12.0 0 Z", x: 77, src: [44, 90] },
  { shape: "M0 0 L2.0 -1.7 L4.0 -2.5 L6.0 0 Z", x: 107, src: [50, 30], inside: true },
];

export function LaunchAvatar({
  hash,
  image,
  status,
  size = 56,
  mode = "list",
  title,
  className,
}: {
  hash?: string;
  /** http(s) URL of the creator's artwork; the hatchling stands in without one (or if it fails to load) */
  image?: string | null;
  status?: number;
  size?: number;
  mode?: "list" | "detail";
  title?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const [failed, setFailed] = useState<string | null>(null);
  const [lens, setLens] = useState<{ x: number; y: number } | null>(null);
  const state = avatarState(status);
  const look = eggLook(hash);
  const path = eggPath(look.hw);
  const art = image && failed !== image ? image : null;
  const small = size < 44;
  const id = (s: string) => `${uid}-${s}`;

  const shellPiece = (clip: string, extra?: ReactNode) => (
    <g clipPath={`url(#${id("egg")})`}>
      <g clipPath={`url(#${id(clip)})`}>
        <path d={path} fill={look.fill} />
        {decoration(look.kind, look.b, look.ink, look.accent)}
        <path d={path} fill={`url(#${id("shade")})`} />
        {extra}
      </g>
    </g>
  );

  /** The creature inside the sealed egg: the artwork in a small round window, or the hatchling. */
  const creature = (): ReactNode =>
    art ? (
      <g>
        <circle cx="60" cy="70" r="29" fill="#FFFEFA" />
        <image
          href={art}
          x={33}
          y={43}
          width={54}
          height={54}
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${id("art")})`}
          onError={() => setFailed(art)}
        />
      </g>
    ) : (
      <g transform="translate(28 38)">
        <HatchlingArt hash={hash} />
      </g>
    );

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (mode !== "detail" || state === "hatched" || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    setLens({ x: ((e.clientX - r.left) / r.width) * 120, y: ((e.clientY - r.top) / r.height) * 120 });
  };

  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`launch-avatar shrink-0 ${className ?? ""}`}
      data-state={state}
      data-mode={mode}
      role="img"
      aria-label={title ?? "token"}
      onPointerMove={onMove}
      // a finger "leaves" right after every tap, which would undo the tap's toggle: only a mouse leaving closes the lens
      onPointerLeave={(e) => e.pointerType === "mouse" && setLens(null)}
      onClick={(e) => {
        if (mode !== "detail" || state === "hatched") return;
        e.preventDefault();
        setLens((l) => (l ? null : { x: 60, y: 60 }));
      }}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={id("egg")}>
          <path d={path} />
        </clipPath>
        <clipPath id={id("cap")}>
          <path d={CAP_CLIP} />
        </clipPath>
        <clipPath id={id("bottom")}>
          <path d={BOTTOM_CLIP} />
        </clipPath>
        <clipPath id={id("art")}>
          <circle cx="60" cy="70" r="27" />
        </clipPath>
        <clipPath id={id("frame")}>
          <circle cx="60" cy="60" r={FRAME_R} />
        </clipPath>
        {state === "hatched" &&
          SHARDS.map((sh, i) => (
            <clipPath key={i} id={id(`shard-${i}`)}>
              <path d={sh.shape} />
            </clipPath>
          ))}
        <radialGradient id={id("shade")} cx="38%" cy="32%" r="75%">
          <stop offset="55%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.2" />
        </radialGradient>
        {lens && (
          <>
            <clipPath id={id("lens")}>
              <circle cx={lens.x} cy={lens.y} r="25" />
            </clipPath>
            {/* the X-ray look: everything turns to shades of pale cyan */}
            <filter id={id("xray")} colorInterpolationFilters="sRGB">
              <feColorMatrix type="matrix" values="0.2 0.4 0.1 0 0.35  0.3 0.55 0.15 0 0.55  0.3 0.55 0.15 0 0.6  0 0 0 1 0" />
            </filter>
            <pattern id={id("scan")} width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="4" height="1.2" fill="#9FF3FF" opacity="0.18" />
            </pattern>
          </>
        )}
      </defs>

      {state === "hatched" ? (
        <>
          {/* the ground the pieces lie on */}
          <ellipse cx="60" cy={GROUND + 1} rx="56" ry="3" fill="currentColor" opacity="0.07" />
          {!small && (
            <g stroke="#F9C23C" strokeWidth="3" strokeLinecap="round" className="la-sparks">
              <path d="M108 12v10M103 17h10" />
              <path d="M12 16v8M8 20h8" />
            </g>
          )}
          {SHARDS.filter((sh) => !small || sh.keep).map((sh) => {
            const i = SHARDS.indexOf(sh);
            return (
              <g
                key={i}
                className="la-shard"
                style={{ "--from-x": `${(60 - sh.x - 8).toFixed(1)}px`, "--from-y": `${(60 - GROUND).toFixed(1)}px` } as CSSProperties}
              >
                <g transform={`translate(${sh.x} ${GROUND})`}>
                  <g clipPath={`url(#${id(`shard-${i}`)})`}>
                    {sh.inside ? (
                      <rect x="-2" y="-10" width="32" height="12" fill="#EFE6D2" />
                    ) : (
                      // the egg's own shell at half size, so the pattern reads at the piece's scale
                      <g transform={`scale(0.5) translate(${-sh.src[0]} ${-sh.src[1]})`}>
                        <rect width="240" height="240" fill={look.fill} />
                        {decoration(look.kind, look.b, look.ink, look.accent)}
                      </g>
                    )}
                  </g>
                  <path d={sh.shape} fill="none" stroke="#1C1C1C" strokeOpacity="0.2" strokeWidth="0.8" strokeLinejoin="round" />
                </g>
              </g>
            );
          })}
          {/* the creature, centred: the uploaded artwork as it is, cropped only by the circle, or the hatchling */}
          <g className="la-creature">
            <g clipPath={`url(#${id("frame")})`}>
              {art ? (
                <image
                  href={art}
                  x={60 - FRAME_R}
                  y={60 - FRAME_R}
                  width={FRAME_R * 2}
                  height={FRAME_R * 2}
                  preserveAspectRatio="xMidYMid slice"
                  onError={() => setFailed(art)}
                />
              ) : (
                <>
                  <circle cx="60" cy="60" r={FRAME_R} fill="#FFFEFA" />
                  <circle cx="60" cy="60" r={FRAME_R} fill={look.fill === "#34342F" ? look.accent : look.fill} opacity="0.35" />
                  {/* eyes on the centre, the body running out of the bottom of the frame like a portrait */}
                  <g transform="translate(12 38) scale(1.5)">
                    <HatchlingArt hash={hash} />
                  </g>
                </>
              )}
            </g>
            {/* the frame: a ring in the shell's colour around the artwork; nothing is painted behind the artwork, so a
                transparent logo shows exactly as uploaded */}
            <circle cx="60" cy="60" r={FRAME_R + 1.5} fill="none" stroke={look.fill === "#34342F" ? look.accent : look.fill} strokeWidth="3" />
          </g>
        </>
      ) : (
        <>
          <ellipse cx="60" cy="110" rx={look.hw * 0.9} ry="5.5" fill="currentColor" opacity="0.1" />
          <g transform={`rotate(${look.tilt} 60 104)`}>
            <g className="la-egg">
              {/* the inside of the shell, seen when the top lifts */}
              <path d={path} fill="#2B2620" />
              <g className="la-creature">{creature()}</g>
              <g className="la-bottom">
                {shellPiece("bottom")}
                <path d={`M${ZZ}`} fill="none" stroke="#1C1C1C" strokeOpacity="0.18" strokeWidth="1.4" strokeLinejoin="round" clipPath={`url(#${id("egg")})`} />
              </g>
              <g className="la-cap">
                {shellPiece("cap", <ellipse cx="44" cy="36" rx="7" ry="12" fill="#fff" opacity="0.42" transform="rotate(24 44 36)" />)}
              </g>
              <path d={path} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.8" />
              {lens && (
                <g clipPath={`url(#${id("egg")})`}>
                  <g clipPath={`url(#${id("lens")})`}>
                    <rect width="120" height="120" fill="#0F2533" />
                    <g filter={`url(#${id("xray")})`} opacity="0.95">
                      {creature()}
                    </g>
                    <rect width="120" height="120" fill={`url(#${id("scan")})`} />
                  </g>
                </g>
              )}
            </g>
          </g>
          {lens && <circle cx={lens.x} cy={lens.y} r="25" fill="none" stroke="#9FF3FF" strokeWidth="2" opacity="0.9" />}
        </>
      )}
    </svg>
  );
}
