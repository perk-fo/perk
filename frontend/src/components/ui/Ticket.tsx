import type { ReactNode } from "react";

/** Grant position card: content on the left, a perforated stub on the right (.ticket in globals.css). */
export function Ticket({
  children,
  stub,
  className,
}: {
  children: ReactNode;
  /** Right-hand stub content (position id, status, countdown). */
  stub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ticket grid grid-cols-[minmax(0,1fr)_25%] ${className ?? ""}`}>
      <div className="min-w-0 p-5">{children}</div>
      <div className="flex min-w-0 flex-col items-center justify-center gap-1.5 p-3 text-center">{stub}</div>
    </div>
  );
}
