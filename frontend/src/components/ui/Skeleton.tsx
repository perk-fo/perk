import { HashSeal } from "@/components/art/HashSeal";

/**
 * Loading placeholder: the outline of a seal plus hairline bars — no grey shimmer (DESIGN.md).
 */
export function Skeleton({
  size = 56,
  lines = 2,
  className,
}: {
  size?: number;
  /** Hairline text bars next to the seal outline; 0 renders the seal alone. */
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-4 text-bone ${className ?? ""}`} aria-hidden>
      <HashSeal size={size} />
      {lines > 0 && (
        <div className="min-w-0 flex-1 space-y-2.5">
          {Array.from({ length: lines }, (_, i) => (
            <div
              key={i}
              className="h-2.5 rounded-full border border-bone/10"
              style={{ width: `${Math.max(30, 85 - i * 22)}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
