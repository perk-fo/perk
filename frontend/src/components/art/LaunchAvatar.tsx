"use client";

import { useId, useState, type PointerEvent, type ReactNode } from "react";
import { decoration, eggLook, eggPath } from "./HashEgg";
import { HatchlingArt } from "./Hatchling";

/**
 * Every launch is an egg until it graduates. The shell is the launch's own Easter egg (generated from its configHash);
 * inside is the creature: the artwork its creator uploaded, or a hatchling generated from the same hash.
 *
 *   sealed     on the curve: the egg. In lists, hovering it (or the card or row around it) lifts the top of the
 *              shell and the creature peeks out; moving away closes it again.
 *   cracking   threshold reached, graduation pending: the shell is ajar and trembles.
 *   hatched    graduated: the creature itself, standing in the broken shell. The token page plays the hatch once.
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

  /** The creature placed inside the egg (sealed) or free and larger (hatched). */
  const creature = (hatched: boolean): ReactNode => {
    if (art) {
      const r = hatched ? 40 : 27;
      const cy = hatched ? 48 : 70;
      return (
        <g>
          <circle cx="60" cy={cy} r={r + 2} fill="#FFFEFA" />
          <image
            href={art}
            x={60 - r}
            y={cy - r}
            width={r * 2}
            height={r * 2}
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#${id(hatched ? "art-big" : "art")})`}
            onError={() => setFailed(art)}
          />
        </g>
      );
    }
    return hatched ? (
      <g transform="translate(16.8 14) scale(1.35)">
        <HatchlingArt hash={hash} />
      </g>
    ) : (
      <g transform="translate(28 38)">
        <HatchlingArt hash={hash} />
      </g>
    );
  };

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
        <clipPath id={id("art-big")}>
          <circle cx="60" cy="48" r="40" />
        </clipPath>
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
          {/* a soft halo in the shell's colour; the charcoal shell lends its accent instead, grey would look muddy */}
          <circle cx="60" cy="58" r="52" fill={look.fill === "#34342F" ? look.accent : look.fill} opacity="0.28" />
          {!small && (
            <g stroke="#F9C23C" strokeWidth="3" strokeLinecap="round" className="la-sparks">
              <path d="M104 18v10M99 23h10" />
              <path d="M16 30v8M12 34h8" />
            </g>
          )}
          <g className="la-creature">{creature(true)}</g>
          {/* it stands in the bottom half of its shell; the top lies beside it */}
          {!small && (
            <g transform="translate(78 70) rotate(28) scale(0.42)">
              <g className="la-frag la-frag-cap">{shellPiece("cap")}</g>
            </g>
          )}
          <g transform="translate(22.8 49) scale(0.62)">
            <g className="la-frag la-frag-cup">
              {shellPiece("bottom")}
              <path d={`M${ZZ}`} fill="none" stroke="#1C1C1C" strokeOpacity="0.18" strokeWidth="1.6" strokeLinejoin="round" clipPath={`url(#${id("egg")})`} />
            </g>
          </g>
        </>
      ) : (
        <>
          <ellipse cx="60" cy="110" rx={look.hw * 0.9} ry="5.5" fill="currentColor" opacity="0.1" />
          <g transform={`rotate(${look.tilt} 60 104)`}>
            <g className="la-egg">
              {/* the inside of the shell, seen when the top lifts */}
              <path d={path} fill="#2B2620" />
              <g className="la-creature">{creature(false)}</g>
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
                      {creature(false)}
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
