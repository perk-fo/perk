"use client";

import type { ReactNode } from "react";
import { PerkChick } from "@/components/brand/PerkChick";

/** Nothing here yet: the chick, one line of explanation and an optional way forward, on a dashed well. */
export function EmptyState({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={`well chick-host flex flex-col items-center gap-4 px-6 py-12 text-center ${className ?? ""}`}>
      <PerkChick size={64} mode="idle" />
      <div className="max-w-md text-sm leading-relaxed text-muted">{children}</div>
      {action}
    </div>
  );
}
