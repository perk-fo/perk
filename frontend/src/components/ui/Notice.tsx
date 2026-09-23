import type { ReactNode } from "react";

/** Risk / error callout with an amber or rose left rule (DESIGN.md). */
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
  const box = tone === "amber" ? "border-amber/25 bg-amber/[0.07]" : "border-rose/25 bg-rose/[0.07]";
  return (
    <div className={`rounded-xl border ${box} px-4 py-3 text-sm leading-relaxed text-bone ${className ?? ""}`}>
      {title !== undefined && (
        <p className={`mb-1 text-[13px] font-medium ${tone === "amber" ? "text-amber" : "text-rose"}`}>{title}</p>
      )}
      {children}
    </div>
  );
}
