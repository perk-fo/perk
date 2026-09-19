import type { ReactNode } from "react";

export type StatTone = "bone" | "flare" | "verdigris" | "amber" | "rose";

const TONE_CLASS: Record<StatTone, string> = {
  bone: "text-bone",
  flare: "text-flare",
  verdigris: "text-verdigris",
  amber: "text-amber",
  rose: "text-rose",
};

/** The "main number" block: a big Fraunces figure with a small label and an optional muted unit. */
export function Stat({
  label,
  value,
  unit,
  tone = "bone",
  size = "md",
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: StatTone;
  size?: "md" | "lg";
}) {
  // Long figures step down instead of being cut off: a truncated number is worse than a smaller one.
  const len = typeof value === "string" || typeof value === "number" ? String(value).length : 0;
  const sizeClass =
    len > 11
      ? "text-2xl sm:text-3xl"
      : len > 7
        ? "text-3xl sm:text-4xl"
        : size === "lg"
          ? "text-5xl sm:text-6xl"
          : "text-4xl sm:text-5xl";
  return (
    <div className="min-w-0">
      <div
        className={`inline-flex max-w-full flex-wrap items-baseline gap-1.5 font-display font-semibold leading-none ${TONE_CLASS[tone]} ${sizeClass}`}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{value}</span>
        {unit !== undefined && <span className="label shrink-0">{unit}</span>}
      </div>
      <div className="label mt-2">{label}</div>
    </div>
  );
}
