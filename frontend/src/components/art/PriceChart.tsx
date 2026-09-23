"use client";
/**
 * PriceChart — candles on a continuous time axis with a volume strip and time labels underneath.
 * Pure SVG. Input is a list of trades already normalised to quote-per-meme prices; bucketing lives in lib/candles.
 * Candles are right-aligned (latest at the right edge) in a fixed number of slots, so a young market shows a few
 * candles at their true width instead of stretching them across the chart.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { formatPrice } from "@/lib/format";
import { buildCandles, candleChange, pickBucket, type TradePoint } from "@/lib/candles";
import { Subscripted, SvgSubscripted } from "@/components/ui/Subscripted";

export type { TradePoint, Candle } from "@/lib/candles";

export const RANGES = [
  { key: "1h", seconds: 3600, bucket: 60 },
  { key: "24h", seconds: 86400, bucket: 900 },
  { key: "7d", seconds: 7 * 86400, bucket: 3600 * 4 },
  { key: "all", seconds: 0, bucket: 0 },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];

const MIN_SLOTS = 48;

function timeLabel(t: number, bucket: number, spanSeconds: number): string {
  const d = new Date(t * 1000);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (spanSeconds <= 86400 && bucket < 86400) return hm;
  const md = d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  return bucket >= 86400 ? md : `${md} ${hm}`;
}

export function PriceChart({
  trades,
  height = 300,
  quoteSymbol,
  labels,
  now = Math.floor(Date.now() / 1000),
}: {
  trades: TradePoint[];
  height?: number;
  quoteSymbol: string;
  labels: {
    empty: string;
    /** shown when the token has traded but not inside the selected range */
    emptyRange?: string;
    volume: string;
    ranges: Record<RangeKey, string>;
    myBuy?: string;
    mySell?: string;
  };
  now?: number;
}) {
  const [range, setRange] = useState<RangeKey>("all");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Draw at the container's real width. A fixed 720-wide viewBox scaled into a ~560px column shrank every axis
  // label to 7-9px; at 1:1 the labels are the size they say they are.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const def = RANGES.find((r) => r.key === range)!;

  const { candles, bucket, slots } = useMemo(() => {
    if (def.seconds === 0) {
      const firstTs = trades.reduce((m, t) => Math.min(m, t.ts), Infinity);
      const b = Number.isFinite(firstTs) ? pickBucket(now - firstTs) : 60;
      const cs = buildCandles(trades, b, now);
      return { candles: cs, bucket: b, slots: Math.max(cs.length, MIN_SLOTS) };
    }
    const cs = buildCandles(trades, def.bucket, now, now - def.seconds);
    return { candles: cs, bucket: def.bucket as number, slots: def.seconds / def.bucket + 1 };
  }, [trades, def, now]);

  const padL = 4,
    padR = 76,
    padT = 12,
    volH = 40,
    gap = 10,
    padB = 20;
  const priceH = height - padT - volH - gap - padB;
  const n = candles.length;
  const hi = Math.max(...candles.map((c) => c.h), 0);
  const lo = Math.min(...candles.map((c) => c.l), Infinity);
  const spanP = hi - lo || hi || 1;
  const yP = (p: number) => padT + priceH - ((p - lo) / spanP) * priceH * 0.9 - priceH * 0.05;
  const maxV = Math.max(...candles.map((c) => c.v), 0) || 1;
  const volTop = padT + priceH + gap;
  const yV = (v: number) => volTop + volH - (v / maxV) * volH;
  const slot = (W - padL - padR) / slots;
  const offset = slots - n; // right-align: latest candle sits in the last slot
  const bodyW = Math.max(1.5, Math.min(12, slot * 0.64));
  const x = (i: number) => padL + (offset + i) * slot + slot / 2;
  // market direction has its own colours; the brand lime means "act", not "went up"
  const up = "rgb(var(--c-verdigris))";
  const down = "rgb(var(--c-rose))";
  const axis = "rgb(var(--c-subtle))";
  const last = candles[n - 1];
  const change = candleChange(candles);
  const active = hoverIdx !== null ? candles[hoverIdx] : last;
  const hasTrades = candles.some((c) => c.n > 0);
  // "no trades yet" and "nothing in the last hour" are different things to tell someone, and saying the first
  // when a token has a full history reads as though the page is broken.
  const everTraded = trades.length > 0;

  // ~5 evenly spaced time labels over the drawn candles
  const ticks = useMemo(() => {
    if (n === 0) return [];
    const every = Math.max(1, Math.ceil(n / 5));
    const out: number[] = [];
    for (let i = n - 1; i >= 0; i -= every) out.unshift(i);
    return out;
  }, [n]);
  const span = n > 0 ? candles[n - 1].t - candles[0].t : 0;

  return (
    <div className="w-full" ref={wrapRef}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <span className="font-display num text-3xl leading-none">{active ? <Subscripted text={formatPrice(active.c)} /> : "—"}</span>
          <span className="label">{quoteSymbol}</span>
          {last && (
            <span className={`num text-sm font-medium ${change >= 0 ? "text-verdigris" : "text-rose"}`}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="flex gap-0.5 rounded-full bg-raised p-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => setRange(r.key)}
              className={`num rounded-full px-2.5 py-0.5 text-xs transition-colors duration-fast ${
                range === r.key ? "bg-knob font-medium text-bone shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-bone"
              }`}
            >
              {labels.ranges[r.key]}
            </button>
          ))}
        </div>
      </div>
      {!hasTrades ? (
        <div
          className="flex items-center justify-center rounded-xl border border-dashed border-line text-sm text-subtle"
          style={{ height }}
        >
          {everTraded ? (labels.emptyRange ?? labels.empty) : labels.empty}
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          height={height}
          role="img"
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const px = ((e.clientX - rect.left) / rect.width) * W;
            const i = Math.floor((px - padL) / slot) - offset;
            setHoverIdx(i < 0 ? null : Math.min(n - 1, i));
          }}
        >
          {/* horizontal guides + price axis */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const p = lo + spanP * f;
            const y = yP(p);
            return (
              <g key={f}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="rgb(var(--c-line))" />
                <text x={W - padR + 10} y={y + 4} fontSize="11.5" fill={axis} className="num">
                  <SvgSubscripted text={formatPrice(p)} />
                </text>
              </g>
            );
          })}
          {/* last price marker */}
          {last && (
            <line
              x1={padL}
              x2={W - padR}
              y1={yP(last.c)}
              y2={yP(last.c)}
              stroke={last.c >= last.o ? up : down}
              strokeOpacity="0.55"
              strokeDasharray="2 4"
            />
          )}
          {/* candles; quiet buckets are thin neutral ticks at the carried price */}
          {candles.map((c, i) => {
            const dim = hoverIdx === null || hoverIdx === i ? 1 : 0.55;
            if (c.n === 0) {
              return (
                <line
                  key={c.t}
                  x1={x(i) - bodyW / 2}
                  x2={x(i) + bodyW / 2}
                  y1={yP(c.c)}
                  y2={yP(c.c)}
                  stroke="rgb(var(--c-faint))"
                  strokeOpacity={0.7 * dim}
                  strokeWidth="1"
                />
              );
            }
            const col = c.c >= c.o ? up : down;
            const top = yP(Math.max(c.o, c.c));
            const bot = yP(Math.min(c.o, c.c));
            return (
              <g key={c.t} opacity={dim}>
                <line x1={x(i)} x2={x(i)} y1={yP(c.h)} y2={yP(c.l)} stroke={col} strokeWidth="1" />
                <rect x={x(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(1.5, bot - top)} rx="1" fill={col} />
              </g>
            );
          })}
          {/* the connected wallet's trades: ▲ under the candle for buys, ▼ over it for sells */}
          {candles.map((c, i) => (
            <g key={`m${c.t}`}>
              {c.myBuys > 0 && (
                <path
                  d={`M ${x(i)} ${yP(c.l) + 5} l 4.5 7 h -9 z`}
                  fill={up}
                  stroke="rgb(var(--c-surface))"
                  strokeWidth="1"
                />
              )}
              {c.mySells > 0 && (
                <path
                  d={`M ${x(i)} ${yP(c.h) - 5} l 4.5 -7 h -9 z`}
                  fill={down}
                  stroke="rgb(var(--c-surface))"
                  strokeWidth="1"
                />
              )}
            </g>
          ))}
          {/* volume strip: total muted, buy share in flare */}
          <text x={W - padR + 10} y={volTop + volH} fontSize="11" fill={axis} className="num">
            {labels.volume} {quoteSymbol}
          </text>
          {candles.map((c, i) =>
            c.v > 0 ? (
              <g key={`v${c.t}`}>
                <rect x={x(i) - bodyW / 2} y={yV(c.v)} width={bodyW} height={yV(0) - yV(c.v)} fill="rgb(var(--c-line-strong))" />
                <rect x={x(i) - bodyW / 2} y={yV(c.buys)} width={bodyW} height={yV(0) - yV(c.buys)} fill={up} fillOpacity="0.6" />
              </g>
            ) : null,
          )}
          {/* time axis */}
          {ticks.map((i) => (
            <text
              key={`t${i}`}
              x={x(i)}
              y={height - 4}
              fontSize="11.5"
              fill={axis}
              textAnchor={i === n - 1 ? "end" : "middle"}
              className="num"
            >
              {timeLabel(candles[i].t, bucket, span)}
            </text>
          ))}
          {/* crosshair */}
          {hoverIdx !== null && active && (
            <g>
              <line x1={x(hoverIdx)} x2={x(hoverIdx)} y1={padT} y2={volTop + volH} stroke="rgb(var(--c-line-strong))" strokeDasharray="2 3" />
              <rect x={Math.min(x(hoverIdx) + 8, W - padR - 206)} y={padT} width="198" height="64" rx="10" fill="rgb(var(--c-raised))" stroke="rgb(var(--c-line-strong))" />
              <text x={Math.min(x(hoverIdx) + 18, W - padR - 196)} y={padT + 18} fontSize="11.5" fill={axis} className="num">
                {new Date(active.t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                {active.n > 0 ? ` · ${active.n}` : ""}
                {active.myBuys > 0 && labels.myBuy ? ` · ${labels.myBuy}` : ""}
                {active.mySells > 0 && labels.mySell ? ` · ${labels.mySell}` : ""}
              </text>
              <text x={Math.min(x(hoverIdx) + 18, W - padR - 196)} y={padT + 36} fontSize="12" fill="currentColor" className="num">
                <SvgSubscripted text={`O ${formatPrice(active.o)}  C ${formatPrice(active.c)}`} />
              </text>
              <text x={Math.min(x(hoverIdx) + 18, W - padR - 196)} y={padT + 53} fontSize="12" fill="currentColor" className="num">
                <SvgSubscripted text={`H ${formatPrice(active.h)}  L ${formatPrice(active.l)}  V ${active.v.toFixed(4)}`} />
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
