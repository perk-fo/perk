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
    <div className="flex gap-0.5 rounded-full bg-raised p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={`rounded-full px-3 py-1 text-[13px] transition-colors duration-fast ${
            value === o ? "bg-knob font-medium text-bone shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-bone"
          }`}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}
