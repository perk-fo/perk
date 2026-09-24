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
 *              anything; the shell lies around it in pieces (the egg's own colours and pattern, a few showing the pale
 *              inside), outside the frame. The token page plays the hatch once.
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

/**
 * The pieces of a hatched egg. `cut` is a region with a jagged break line; intersected with the egg, each piece keeps
 * a stretch of the shell's curved edge and the egg's own pattern. `c` is the piece's middle (egg coordinates); `at`,
 * `rot` and `s` lay it on the ground below and beside the frame, partly tucked behind its rim so no piece ever covers
 * the artwork. `inside` pieces landed face down and show the pale inside of the shell. Small pictures keep the
 * pieces marked `keep`.
 */
const SHARDS: ReadonlyArray<{
  cut: string;
  c: readonly [number, number];
  at: readonly [number, number];
  rot: number;
  s: number;
  inside?: boolean;
  keep?: boolean;
}> = [
  // the upper left of the shell: curved top, broken along the right and underneath
  { cut: "M0 0 H63 L56 12 L64 22 L55 31 L61 40 L50 47 L42 38 L33 48 L24 39 L0 45 Z", c: [42, 30], at: [17, 101], rot: -24, s: 0.56, keep: true },
  // a slice of the right side, lying on its long edge
  { cut: "M120 40 H95 L88 51 L97 60 L86 69 L95 79 L85 89 L120 93 Z", c: [92, 66], at: [103, 106], rot: 76, s: 0.52, keep: true },
  // a slice of the left side, landed face down
  { cut: "M0 58 L29 55 L36 65 L27 74 L37 84 L29 95 L0 96 Z", c: [27, 76], at: [27, 114], rot: -78, s: 0.36, inside: true },
  // a piece of the base
  { cut: "M22 94 L34 90 L44 99 L56 91 L67 100 L79 91 L90 99 L104 94 V120 H22 Z", c: [62, 101], at: [88, 114], rot: 8, s: 0.34, keep: true },
  // chips
  { cut: "M48 58 L60 52 L68 61 L59 70 L50 67 Z", c: [58, 61], at: [44, 117], rot: 24, s: 0.42 },
  { cut: "M66 76 L76 73 L79 83 L69 86 Z", c: [72, 79], at: [114, 114], rot: -30, s: 0.5, inside: true },
  { cut: "M30 64 L38 60 L41 68 Z", c: [36, 64], at: [5, 110], rot: 40, s: 0.6 },
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
              <path d={sh.cut} />
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
          <ellipse cx="60" cy="114" rx="58" ry="5" fill="currentColor" opacity="0.08" />
          {!small && (
            <g stroke="#F9C23C" strokeWidth="3" strokeLinecap="round" className="la-sparks">
              <path d="M108 12v10M103 17h10" />
              <path d="M12 16v8M8 20h8" />
            </g>
          )}
          {SHARDS.filter((sh) => !small || sh.keep).map((sh) => {
            const i = SHARDS.indexOf(sh);
            // the piece itself: the egg's shell (or its pale inside) where the egg and the cut overlap
            const piece = (fill: ReactNode) => (
              <g clipPath={`url(#${id("egg")})`}>
                <g clipPath={`url(#${id(`shard-${i}`)})`}>{fill}</g>
              </g>
            );
            return (
              <g
                key={i}
                className="la-shard"
                style={{ "--from-x": `${(60 - sh.at[0]).toFixed(1)}px`, "--from-y": `${(60 - sh.at[1]).toFixed(1)}px` } as CSSProperties}
              >
                <g transform={`translate(${sh.at[0]} ${sh.at[1]}) rotate(${sh.rot}) scale(${sh.s}) translate(${-sh.c[0]} ${-sh.c[1]})`}>
                  {/* the shell's thickness, seen along the broken edge */}
                  <g transform="translate(1.2 2.6)">{piece(<rect width="120" height="120" fill="#000" opacity="0.28" />)}</g>
                  {piece(
                    sh.inside ? (
                      <>
                        <rect width="120" height="120" fill="#EFE6D2" />
                        <path d={path} fill={`url(#${id("shade")})`} />
                      </>
                    ) : (
                      <>
                        <path d={path} fill={look.fill} />
                        {decoration(look.kind, look.b, look.ink, look.accent)}
                        <path d={path} fill={`url(#${id("shade")})`} />
                      </>
                    ),
                  )}
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
