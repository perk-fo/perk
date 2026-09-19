"use client";

/** Pill-shaped segmented control (filters, sorts, ranges). */
export function Segmented<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  value: T;
  options: readonly T[];
  label: (v: T) => string;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-full border border-bone/10 p-0.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className={`rounded-full px-3 py-1 text-[12px] transition-colors duration-fast ${
            value === o ? "bg-bone/10 text-bone" : "text-bone/50 hover:text-bone"
          }`}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}
