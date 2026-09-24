import type { ReactNode } from "react";

/**
 * A section's heading in the editorial style: a small monospace eyebrow, a heavy title, and on the right either a
 * quiet aside or an action link.
 */
export function SectionHeading({
  eyebrow,
  title,
  aside,
  right,
  as: Tag = "h2",
}: {
  eyebrow?: string;
  title: ReactNode;
  aside?: string;
  right?: ReactNode;
  as?: "h1" | "h2";
}) {
  return (
    <div className="mb-7 flex items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-2.5 text-[10px] font-bold tracking-[0.2em]">{eyebrow}</p>}
        <Tag className={`font-display leading-tight ${Tag === "h1" ? "text-[34px] sm:text-[44px]" : "text-[26px] sm:text-[28px]"}`}>{title}</Tag>
      </div>
      {right ?? (aside ? <p className="mb-1 hidden text-[13px] text-subtle sm:block">{aside}</p> : null)}
    </div>
  );
}

/**
 * The top of a page: eyebrow, a large heavy title, an optional description and actions. Every page uses it so the
 * site reads as one publication.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  right,
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="fade-up mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-5 pt-6 sm:mb-10 sm:pt-10">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <p className="eyebrow mb-3 text-[10px] font-bold tracking-[0.2em]">{eyebrow}</p>}
        <h1 className="font-display text-[36px] leading-[1.08] sm:text-[48px]">{title}</h1>
        {description && <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">{description}</p>}
        {children}
      </div>
      {right}
    </header>
  );
}
