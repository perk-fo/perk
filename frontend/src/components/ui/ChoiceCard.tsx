"use client";

import type { KeyboardEvent, ReactNode } from "react";

/**
 * A selectable card in a single-choice group (quote asset, template). The whole card is the hit area; the selected
 * one gets a lime border, a faint lime wash and a check badge (styles: .choice in globals.css — a plain Tailwind
 * border class loses to .panel's own border, which is why selection used to look like nothing happened).
 * Inner interactive bits (copy buttons, links) should stopPropagation.
 */
export function ChoiceCard({
  selected,
  disabled = false,
  onSelect,
  children,
  className,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
  className?: string;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      data-selected={selected}
      onClick={() => !disabled && onSelect()}
      onKeyDown={onKey}
      className={`choice panel p-4 ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"} ${className ?? ""}`}
    >
      {selected && (
        <span className="choice-check" aria-hidden>
          ✓
        </span>
      )}
      {children}
    </div>
  );
}
