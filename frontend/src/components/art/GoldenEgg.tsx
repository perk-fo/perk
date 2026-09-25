"use client";

import { useId } from "react";

/**
 * The LP Grant pass's emblem: a golden Easter egg with a cream zigzag band, tangerine dots and the brand blossom.
 * `lit` (the pass is issued) adds a light sweep and twinkling sparkles; unlit it is a pale, undecorated-looking
 * promise of one. `wobble` rocks it gently (loading, hover).
 */
export function GoldenEgg({ size = 96, lit = true, wobble = false }: { size?: number; lit?: boolean; wobble?: boolean }) {
  const uid = `${useId().replace(/:/g, "")}${lit ? "l" : "u"}`;
  const egg =
    "M60 10 C84 10 98 44 98 72 C98 94 81 108 60 108 C39 108 22 94 22 72 C22 44 36 10 60 10 Z";
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={`golden-egg ${wobble ? "golden-egg-wobble" : ""}`}
      data-lit={lit}
      aria-hidden
    >
      <defs>
        <linearGradient id={`${uid}-gold`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={lit ? "#FFF3B0" : "#F4F1E4"} />
          <stop offset="40%" stopColor={lit ? "#FFD84D" : "#E6E2D2"} />
          <stop offset="75%" stopColor={lit ? "#F2B227" : "#D3CFBE"} />
          <stop offset="100%" stopColor={lit ? "#C98A12" : "#B9B5A5"} />
        </linearGradient>
        <clipPath id={`${uid}-clip`}>
          <path d={egg} />
        </clipPath>
        <linearGradient id={`${uid}-sweep`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff" stopOpacity="0" />
          <stop offset="50%" stopColor="#fff" stopOpacity="0.65" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="111" rx="32" ry="5.5" fill="currentColor" opacity="0.12" />
      <g className="golden-egg-body">
        <path d={egg} fill={`url(#${uid}-gold)`} />
        <g clipPath={`url(#${uid}-clip)`}>
          {/* the Easter band: two rules, a zigzag and dots */}
          <path d="M10 58H110M10 84H110" stroke={lit ? "#FFF8DD" : "#FAF8F0"} strokeWidth="3.2" />
          <path
            d="M10 71 L18 64 L26 78 L34 64 L42 78 L50 64 L58 78 L66 64 L74 78 L82 64 L90 78 L98 64 L106 78 L114 71"
            fill="none"
            stroke={lit ? "#FFF8DD" : "#FAF8F0"}
            strokeWidth="4.4"
            strokeLinejoin="round"
          />
          {[30, 46, 62, 78, 94].map((x, i) => (
            <circle key={x} cx={x} cy={i % 2 ? 95 : 45} r="3.4" fill={lit ? "#FF822D" : "#CFCBBA"} />
          ))}
          {/* the brand blossom: five petals and a tangerine heart */}
          <g fill={lit ? "#FFF8DD" : "#FAF8F0"}>
            {[0, 1, 2, 3, 4].map((i) => {
              const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
              return <circle key={i} cx={60 + 4.4 * Math.cos(a)} cy={29 + 4.4 * Math.sin(a)} r="3.3" />;
            })}
          </g>
          <circle cx="60" cy="29" r="2.3" fill={lit ? "#FF822D" : "#CFCBBA"} />
          {lit && <rect className="golden-egg-sweep" x="-60" y="0" width="50" height="120" fill={`url(#${uid}-sweep)`} />}
        </g>
        <ellipse cx="44" cy="34" rx="7" ry="13" fill="#fff" opacity={lit ? 0.55 : 0.4} transform="rotate(24 44 34)" />
        <path d={egg} fill="none" stroke={lit ? "#B77A0C" : "#A9A594"} strokeOpacity="0.45" strokeWidth="1.6" />
      </g>
      {lit && (
        <g className="golden-egg-sparks" stroke="#F9C23C" strokeWidth="2.4" strokeLinecap="round">
          <path d="M104 22v10M99 27h10" />
          <path d="M14 40v8M10 44h8" />
          <path d="M100 88v7M96.5 91.5h7" />
        </g>
      )}
    </svg>
  );
}
