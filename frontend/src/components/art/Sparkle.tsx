/** Sparkle — the four-point star from the Perk mark. Status glyph, success flourish, loading blink. */
export function Sparkle({
  size = 14,
  tone = "flare",
  twinkle = false,
  className,
}: {
  size?: number;
  tone?: "flare" | "bone" | "verdigris" | "amber" | "rose" | "muted";
  twinkle?: boolean;
  className?: string;
}) {
  const fill = tone === "muted" ? "rgb(var(--c-faint))" : `rgb(var(--c-${tone}))`;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`${twinkle ? "twinkle" : ""} ${className ?? ""}`}
      aria-hidden="true"
    >
      <path d="M12 1 C13.2 8.5 15.5 10.8 23 12 C15.5 13.2 13.2 15.5 12 23 C10.8 15.5 8.5 13.2 1 12 C8.5 10.8 10.8 8.5 12 1 Z" fill={fill} />
    </svg>
  );
}
