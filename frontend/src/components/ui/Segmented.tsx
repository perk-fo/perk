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
    <div className="flex gap-0.5 rounded-xl bg-raised p-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-semibold transition-colors duration-fast ${
            value === o ? "bg-knob text-bone shadow-[0_1px_3px_rgb(0_0_0/0.12)]" : "text-muted hover:text-bone"
          }`}
        >
          {label(o)}
        </button>
      ))}
    </div>
  );
}
