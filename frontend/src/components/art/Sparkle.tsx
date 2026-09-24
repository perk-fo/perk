/**
 * Sparkle — the eight-spoke asterisk from the brand's decoration. Status glyph, success flourish, section marker.
 * `spin` turns it slowly (and quickly while its `.group` is hovered).
 */
export function Sparkle({
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
  const stroke =
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
      <g stroke={stroke} strokeWidth="2.6" strokeLinecap="round">
        <path d="M12 2.5V21.5" />
        <path d="M2.5 12H21.5" />
        <path d="M5.3 5.3L18.7 18.7" />
        <path d="M18.7 5.3L5.3 18.7" />
      </g>
    </svg>
  );
}
