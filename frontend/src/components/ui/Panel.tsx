import type { ReactNode } from "react";

/** Hairline card per DESIGN.md: 1px line border, no shadow, 14px radius, 24px padding. */
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
        <header className="mb-4 flex items-center justify-between gap-3">
          <h2 className="label">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}
