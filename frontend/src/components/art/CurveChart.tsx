"use client";
/**
 * CurveChart — the bonding curve as a real price curve.
 * price(q) = (Q0 + q)^2 / (M0 * Q0) for a constant-product curve with virtual reserves; drawn from q = 0 to the
 * graduation threshold, normalised to the graduation price. The filled area is what has been bought so far.
 */
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n/provider";

export function CurveChart({
  virtualQuote0,
  virtualMeme0,
  threshold,
  realQuote,
  width = 640,
  height = 220,
  quoteSymbol = "OKB",
  formatQuote,
  minimal = false,
}: {
  virtualQuote0: bigint;
  virtualMeme0: bigint;
  threshold: bigint;
  realQuote: bigint;
  width?: number;
  height?: number;
  quoteSymbol?: string;
  formatQuote?: (v: bigint) => string;
  /** Hide the text labels (used by the tiny card charts on the home grid). */
  minimal?: boolean;
}) {
  const { t } = useT();
  // measure the container so the labels render at their real size instead of scaling with the column
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setMeasured(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (virtualQuote0 === 0n || virtualMeme0 === 0n || threshold === 0n) return null;
  if (measured !== null) width = measured;
  const T = Number(threshold);
  const Q0 = Number(virtualQuote0);
  const cur = Math.min(Number(realQuote), T);
  const price = (q: number) => ((Q0 + q) * (Q0 + q)) / Q0; // ∝ quote per meme, M0 cancels in the normalisation
  const pMax = price(T);
  const pMin = price(0);

  const padL = minimal ? 4 : 12,
    padR = minimal ? 4 : 12,
    padT = minimal ? 6 : 18,
    padB = minimal ? 6 : 26;
  const W = width - padL - padR;
  const H = height - padT - padB;
  const X = (q: number) => padL + (q / T) * W;
  const Y = (p: number) => padT + H - ((p - pMin) / (pMax - pMin)) * H * 0.92 - H * 0.04;

  const steps = 64;
  const pts: string[] = [];
  const filled: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const q = (T * i) / steps;
    const x = X(q).toFixed(2);
    const y = Y(price(q)).toFixed(2);
    pts.push(`${i === 0 ? "M" : "L"} ${x} ${y}`);
    if (q <= cur) filled.push(`${i === 0 ? "M" : "L"} ${x} ${y}`);
  }
  if (cur > 0) {
    filled.push(`L ${X(cur).toFixed(2)} ${Y(price(cur)).toFixed(2)}`);
    filled.push(`L ${X(cur).toFixed(2)} ${(padT + H).toFixed(2)} L ${padL} ${(padT + H).toFixed(2)} Z`);
  }
  const cx = X(cur);
  const cy = Y(price(cur));
  const pct = T === 0 ? 0 : (cur / T) * 100;

  return (
    <div ref={wrapRef} className="w-full">
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="bonding curve">
      {/* baseline + graduation marker */}
      <line x1={padL} x2={width - padR} y1={padT + H} y2={padT + H} stroke="rgb(var(--c-line-strong))" />
      <line
        x1={width - padR}
        x2={width - padR}
        y1={padT}
        y2={padT + H}
        stroke="rgb(var(--c-verdigris))"
        strokeOpacity="0.7"
        strokeDasharray="3 4"
      />
      {!minimal && (
      <text x={width - padR - 6} y={padT + 12} textAnchor="end" fontSize="12" fill="rgb(var(--c-verdigris))" className="num">
        {t("chart.graduation", { amount: formatQuote ? formatQuote(threshold) : "", symbol: quoteSymbol })}
      </text>
      )}
      {/* bought area */}
      {cur > 0 && <path d={filled.join(" ")} fill="rgb(var(--c-flare))" fillOpacity="0.14" />}
      {/* curve */}
      <path d={pts.join(" ")} fill="none" stroke="rgb(var(--c-muted))" strokeWidth="1.5" className="draw" />
      {/* current point */}
      <circle cx={cx} cy={cy} r="5" fill="rgb(var(--c-flare))" />
      <circle cx={cx} cy={cy} r="10" fill="none" stroke="rgb(var(--c-flare))" strokeOpacity="0.4" />
      {!minimal && (
      <text
        x={Math.min(Math.max(cx, padL + 40), width - padR - 60)}
        y={cy - 16}
        textAnchor="middle"
        fontSize="13"
        fontWeight="500"
        fill="rgb(var(--c-flare))"
        className="num"
      >
        {pct.toFixed(1)}%
      </text>
      )}
      {!minimal && (
      <text x={padL} y={height - 6} fontSize="12" fill="rgb(var(--c-subtle))" className="num">
        {t("chart.raised", { amount: formatQuote ? formatQuote(realQuote) : "", symbol: quoteSymbol })}
      </text>
      )}
    </svg>
    </div>
  );
}
