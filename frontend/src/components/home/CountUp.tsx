"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber } from "@/lib/format";

/**
 * A whole number that counts up from zero the first time it scrolls into view (or when it first arrives), then simply
 * shows later values. "—" while there is no value; never a made-up 0. Immediate under prefers-reduced-motion.
 */
export function CountUp({ value, locale, duration = 900 }: { value: number | undefined; locale: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<number | undefined>(undefined);
  const animated = useRef(false);

  useEffect(() => {
    if (value === undefined) return;
    if (animated.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const el = ref.current;
    let frame = 0;
    const run = () => {
      animated.current = true;
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        setShown(Math.round(value * eased));
        if (p < 1) frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    if (!el || typeof IntersectionObserver === "undefined") {
      run();
      return () => cancelAnimationFrame(frame);
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        run();
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [value, duration]);

  return (
    <span ref={ref} className="num">
      {shown === undefined ? "—" : formatNumber(shown, locale)}
    </span>
  );
}
