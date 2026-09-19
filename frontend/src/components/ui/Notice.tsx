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
  const border = tone === "amber" ? "border-amber" : "border-rose";
  const bg = tone === "amber" ? "bg-amber/10" : "bg-rose/10";
  return (
    <div className={`rounded-r-[10px] border-l-2 ${border} ${bg} px-3.5 py-2.5 text-sm leading-relaxed text-bone/85 ${className ?? ""}`}>
      {title !== undefined && (
        <p className={`label-en mb-1 ${tone === "amber" ? "text-amber" : "text-rose"}`}>{title}</p>
      )}
      {children}
    </div>
  );
}
