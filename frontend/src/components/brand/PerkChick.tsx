"use client";

import { useEffect, useId, useRef, type CSSProperties } from "react";

/**
 * The Perk chick: the client's hatching-chick mark, redrawn on a 64-unit grid so each part can move on its own.
 * Composition and colours follow the original (yellow head, amber wings, orange beak, grey shell with a zigzag crack,
 * charcoal eyes); the redraw adds rounder geometry, a tuft, cheeks and a little shading on the shell.
 *
 * Modes (motion lives in globals.css, `.chick-*`, and switches off under prefers-reduced-motion):
 *   static       no motion (favicons, print, tiny sizes)
 *   idle         blinks now and then and breathes; hovering it makes it hop and flap
 *   follow       idle, and the eyes follow the pointer anywhere on the page
 *   loading      the hatching loop: the egg wobbles, the chick pops up and flaps
 */
export type ChickMode = "static" | "idle" | "follow" | "loading";

export const CHICK = {
  yellow: "#FCD53F",
  amber: "#F9C23C",
  orange: "#FF822D",
  shell: "#D3D3D3",
  shellShade: "#B9B9B4",
  charcoal: "#1C1C1C",
} as const;

// Crack along the top of the shell: three peaks, as in the original mark.
const SHELL =
  "M6.2 35.4 L13.4 28.3 L20.4 35.2 L32 23.6 L43.6 35.2 L50.6 28.3 L57.8 35.3 C57.8 49.6 46.2 61 32 61 C17.8 61 6.2 49.6 6.2 35.4 Z";

export function PerkChick({
  size = 40,
  mode = "idle",
  className,
  style,
  title,
}: {
  size?: number;
  mode?: ChickMode;
  className?: string;
  style?: CSSProperties;
  /** Accessible name; decorative (aria-hidden) when omitted. */
  title?: string;
}) {
  const uid = useId().replace(/:/g, "");
  const ref = useRef<SVGSVGElement>(null);

  // follow: point the pupils at the pointer, at most 1.6 units off centre
  useEffect(() => {
    if (mode !== "follow") return;
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.3);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 260);
        el.style.setProperty("--look-x", `${((dx / d) * 1.6 * k).toFixed(2)}px`);
        el.style.setProperty("--look-y", `${((dy / d) * 1.3 * k).toFixed(2)}px`);
      });
    };
    const reset = () => {
      el.style.setProperty("--look-x", "0px");
      el.style.setProperty("--look-y", "0px");
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", reset);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", reset);
    };
  }, [mode]);

  const clip = `chick-clip-${uid}`;
  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`chick ${className ?? ""}`}
      data-mode={mode}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        {/* the head is hidden where the shell covers it, so it can sink into the egg while hatching */}
        <clipPath id={clip}>
          <path d="M0 0 H64 V35.4 L57.8 35.3 L50.6 28.3 L43.6 35.2 L32 23.6 L20.4 35.2 L13.4 28.3 L6.2 35.4 L0 35.4 Z" />
        </clipPath>
      </defs>
      <g className="chick-egg">
        <g className="chick-bird">
          {/* wings sit behind the head and pivot at the shoulder */}
          <path
            className="chick-wing chick-wing-l"
            d="M20.6 22.4 L8.4 20.3 C5.6 19.8 3.9 23.1 5.9 25.1 L15.2 34.4 Z"
            fill={CHICK.amber}
          />
          <path
            className="chick-wing chick-wing-r"
            d="M43.4 22.4 L55.6 20.3 C58.4 19.8 60.1 23.1 58.1 25.1 L48.8 34.4 Z"
            fill={CHICK.amber}
          />
          <g clipPath={`url(#${clip})`}>
            <path d="M16 20.2 C16 11.3 23.2 4.2 32 4.2 C40.8 4.2 48 11.3 48 20.2 V40 H16 Z" fill={CHICK.yellow} />
            {/* soft light on the crown */}
            <ellipse cx="25" cy="10.6" rx="4.2" ry="2.3" fill="#fff" opacity="0.35" transform="rotate(-28 25 10.6)" />
            <g className="chick-cheeks" fill={CHICK.orange} opacity="0.32">
              <circle cx="20.3" cy="21.6" r="2.3" />
              <circle cx="43.7" cy="21.6" r="2.3" />
            </g>
          </g>
          <g className="chick-tuft" fill={CHICK.amber}>
            <path d="M31.6 4.9 C29.9 3.2 29.9 0.9 31.9 0.5 C33.6 1 33.6 3.1 31.6 4.9 Z" />
            <path d="M32.4 5.1 C33.6 3.4 35.8 2.9 36.7 4.1 C36 5.5 34 5.8 32.4 5.1 Z" />
          </g>
          <g className="chick-face">
            <g className="chick-eye">
              <circle cx="22.8" cy="15.4" r="2.05" fill={CHICK.charcoal} />
              <circle cx="23.5" cy="14.7" r="0.62" fill="#fff" />
            </g>
            <g className="chick-eye">
              <circle cx="41.2" cy="15.4" r="2.05" fill={CHICK.charcoal} />
              <circle cx="41.9" cy="14.7" r="0.62" fill="#fff" />
            </g>
            <path className="chick-beak" d="M36 18.4 H28 C28 16.2 29.8 14.4 32 14.4 C34.2 14.4 36 16.2 36 18.4 Z" fill={CHICK.orange} />
          </g>
        </g>
        <g className="chick-shell">
          <path d={SHELL} fill={CHICK.shell} />
          {/* shading on the lower right and a highlight on the left keep the shell round */}
          <path d="M57.8 35.3 C57.8 49.6 46.2 61 32 61 C40.6 57.5 46.6 49.6 47.4 38.8 L54 31.6 Z" fill={CHICK.shellShade} opacity="0.5" />
          <path d="M11.4 41.5 C12.6 47.5 16.2 52 20.6 54.4" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.8" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
