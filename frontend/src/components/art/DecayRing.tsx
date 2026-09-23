"use client";
import type { ReactNode } from "react";

/**
 * DecayRing — remaining share of a linearly decaying grant window as an arc.
 * `remaining` in [0, 1]. Children render in the centre (the big number and its label).
 */
export function DecayRing({
  remaining,
  size = 220,
  stroke = 6,
  tone = "amber",
  children,
}: {
  remaining: number;
  size?: number;
  stroke?: number;
  tone?: "amber" | "verdigris" | "rose" | "flare";
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining));
  return (
    <div className="relative inline-block" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="decay">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--c-raised))" strokeWidth={stroke} />
        {/* nothing left draws nothing: a round cap on a zero-length arc used to leave a coloured dot at 12 o'clock */}
        {frac > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`rgb(var(--c-${tone}))`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray 600ms ease-out" }}
        />
        )}
        {/* 14 day ticks */}
        {Array.from({ length: 14 }, (_, i) => (
          <line
            key={i}
            x1={size / 2}
            y1={stroke + 4}
            x2={size / 2}
            y2={stroke + 10}
            stroke="rgb(var(--c-line-strong))"
            transform={`rotate(${(i * 360) / 14} ${size / 2} ${size / 2})`}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}
