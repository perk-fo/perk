/**
 * Blossom — the brand's small flower: five round petals around a centre. Section marker, success flourish and the
 * slowly turning ornament of the hero scene; round enough to look right while it spins. `spin` turns it slowly (and
 * quickly while its `.group` is hovered).
 */
export function Blossom({
  size = 14,
  tone = "honey",
  twinkle = false,
  spin = false,
  className,
}: {
  size?: number;
  tone?: "honey" | "tangerine" | "yolk" | "flare" | "bone" | "verdigris" | "amber" | "rose" | "muted";
  twinkle?: boolean;
  spin?: boolean;
  className?: string;
}) {
  const fill =
    tone === "muted"
      ? "rgb(var(--c-faint))"
      : tone === "honey"
        ? "rgb(var(--brand-amber))"
        : tone === "tangerine"
          ? "rgb(var(--brand-orange))"
          : tone === "yolk"
            ? "rgb(var(--brand-yellow))"
            : `rgb(var(--c-${tone}))`;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`${twinkle ? "twinkle" : ""} ${spin ? "spark" : ""} ${className ?? ""}`}
      aria-hidden="true"
    >
      <g fill={fill}>
        {PETALS.map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="4.6" />
        ))}
      </g>
      <circle cx="12" cy="12" r="3.3" fill="rgb(var(--c-surface))" />
      <circle cx="12" cy="12" r="1.6" fill={fill} opacity="0.55" />
    </svg>
  );
}

/** Five petal centres around (12, 12), the first pointing straight up. */
const PETALS: ReadonlyArray<readonly [number, number]> = Array.from({ length: 5 }, (_, i) => {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  return [Number((12 + 6.2 * Math.cos(a)).toFixed(2)), Number((12 + 6.2 * Math.sin(a)).toFixed(2))] as const;
});
