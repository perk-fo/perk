import type { ReactNode } from "react";

/** Risk / error callout: a tinted box with an amber or rose edge (DESIGN.md). */
export function Notice({
  tone = "amber",
  title,
  children,
  className,
}: {
  tone?: "amber" | "rose";
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const box = tone === "amber" ? "border-honey/60 bg-yolk/[0.12]" : "border-rose/30 bg-rose/[0.07]";
  return (
    <div className={`rounded-2xl border ${box} px-4 py-3 text-sm leading-relaxed text-bone ${className ?? ""}`}>
      {title !== undefined && (
        <p className={`mb-1 text-[13px] font-bold ${tone === "amber" ? "text-amber" : "text-rose"}`}>{title}</p>
      )}
      {children}
    </div>
  );
}
