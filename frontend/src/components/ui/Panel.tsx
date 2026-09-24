import type { ReactNode } from "react";

/** Card per DESIGN.md: 1px line border, 20px radius, 24px padding, a bold title with an optional right slot. */
export function Panel({
  title,
  right,
  children,
  className,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel p-6 ${className ?? ""}`}>
      {title !== undefined && (
        <header className="mb-5 flex items-center justify-between gap-3">
          <h2 className="font-display text-[17px] leading-tight">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}
