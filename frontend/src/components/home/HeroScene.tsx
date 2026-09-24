"use client";

import Link from "next/link";
import { useRef, type PointerEvent } from "react";
import { PerkChick } from "@/components/brand/PerkChick";
import { Sparkle } from "@/components/art/Sparkle";
import { useT } from "@/i18n/provider";

/**
 * The hero's "market credential": a concept card (marked as a sample, it shows no launch's real data) on two tilted
 * backing cards over a graph-paper grid. It leans toward the pointer, the backing cards fan out while hovered, and the
 * chick's eyes follow the pointer. All of it stands still under prefers-reduced-motion.
 */
export function HeroScene() {
  const { t } = useT();
  const scene = useRef<HTMLDivElement>(null);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = scene.current;
    if (!el || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty("--ry", `${(x * 12).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${(-y * 10).toFixed(2)}deg`);
  };
  const onLeave = () => {
    scene.current?.style.setProperty("--ry", "0deg");
    scene.current?.style.setProperty("--rx", "0deg");
  };

  const rows = [
    [t("home.credential.row1.k"), t("home.credential.row1.v")],
    [t("home.credential.row2.k"), t("home.credential.row2.v")],
    [t("home.credential.row3.k"), t("home.credential.row3.v")],
  ];

  return (
    <div
      ref={scene}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      aria-label={t("home.credential.aria")}
      role="img"
      className="group relative isolate flex min-h-[440px] min-w-0 items-center justify-center overflow-clip px-0 pb-10 pt-6 [perspective:1100px] sm:min-h-[470px] sm:px-5"
    >
      <div className="grid-paper absolute inset-0 -z-30" aria-hidden />
      <span className="eyebrow absolute left-4 top-0 text-[9px] tracking-[0.2em]" aria-hidden>
        {t("home.credential.coordinate")}
      </span>

      {/* backing cards: they fan out while the scene is hovered */}
      <div
        aria-hidden
        className="absolute -z-20 h-[386px] w-[300px] rounded-[20px] border border-charcoal/10 bg-yolk transition-transform duration-500 ease-spring [transform:translate(29px,-6px)_rotate(11deg)] group-hover:[transform:translate(52px,-14px)_rotate(16deg)] motion-reduce:transition-none"
      />
      <div
        aria-hidden
        className="absolute -z-10 h-[386px] w-[300px] rounded-[20px] border border-charcoal/10 bg-tangerine transition-transform duration-500 ease-spring [transform:translate(-18px,8px)_rotate(-9deg)] group-hover:[transform:translate(-40px,14px)_rotate(-14deg)] motion-reduce:transition-none"
      />

      <Link
        href="/launch"
        tabIndex={-1}
        aria-hidden
        className="relative block w-[300px] max-w-[88vw] rounded-[20px] sm:w-[318px] border border-line bg-surface px-6 pt-5 shadow-lift transition-transform duration-300 ease-out [transform:rotate(-3deg)_rotateX(var(--rx,0deg))_rotateY(var(--ry,0deg))] [transform-style:preserve-3d] motion-reduce:transition-none"
      >
        <div className="flex items-center justify-between">
          <span className="wordmark text-[21px]">
            Perk<span className="text-tangerine">.</span>
          </span>
          <span className="rounded-full border border-line px-2.5 py-1 text-[10px] font-semibold tracking-wide text-subtle">
            {t("home.credential.sample")}
          </span>
        </div>
        <div className="relative grid h-[170px] place-items-center">
          <span className="orbit absolute h-[104px] w-[200px] rounded-[50%] border border-line [transform:rotate(-32deg)]" />
          <span className="orbit-rev absolute h-[104px] w-[180px] rounded-[50%] border border-line [transform:rotate(32deg)]" />
          <PerkChick size={128} mode="follow" className="relative z-10 drop-shadow-[0_14px_14px_rgb(208_144_21/0.25)]" />
          <span className="float absolute left-3 top-8 font-mono text-xl text-subtle">+</span>
          <span className="float-slow absolute bottom-5 right-4 font-mono text-xl text-subtle">+</span>
        </div>
        <div>
          <p className="font-display text-[18px] leading-snug tracking-normal">{t("home.credential.title")}</p>
          <p className="eyebrow mt-1.5 text-[8px] tracking-[0.3em]">{t("home.credential.kicker")}</p>
        </div>
        <div className="mt-5 border-t border-line pt-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between py-2 text-[11px]">
              <span className="text-subtle">{k}</span>
              <strong className="font-semibold">{v}</strong>
            </div>
          ))}
        </div>
        <div className="-mx-6 mt-3 flex items-center justify-between border-t border-dashed border-line px-6 py-4 text-[10px] font-semibold tracking-wide">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-tangerine" />
            {t("home.credential.footer")}
          </span>
          <span className="nudge text-base">↗</span>
        </div>
      </Link>

      <span className="eyebrow absolute bottom-1 left-6 text-[10px] normal-case tracking-[0.18em]" aria-hidden>
        {t("home.credential.caption")}
      </span>
      <Sparkle size={58} tone="honey" spin className="absolute bottom-5 right-3" />
    </div>
  );
}
