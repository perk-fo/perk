"use client";

import { eggLook } from "@/components/art/HashEgg";
import { hatchlingTraits } from "@/components/art/Hatchling";
import { useT } from "@/i18n/provider";

/**
 * A launch's traits, the way an NFT lists them: its egg's shell and pattern and, when the creator uploaded no artwork,
 * the hatchling inside (species, and what it wears; one in sixteen wears a crown). All of it follows from the
 * configHash, so the same launch shows the same traits everywhere.
 */
export function LaunchTraits({ hash, hasArt, className }: { hash: string; hasArt: boolean; className?: string }) {
  const { t } = useT();
  const egg = eggLook(hash);
  const hatchling = hatchlingTraits(hash);
  const traits: Array<{ label: string; rare?: boolean }> = [
    { label: t(`egg.shell.${egg.shell}`) },
    { label: t(`egg.pattern.${egg.pattern}`) },
  ];
  if (!hasArt) {
    traits.push({ label: t(`egg.species.${hatchling.species}`) });
    if (hatchling.accessory !== "none") {
      traits.push({ label: t(`egg.accessory.${hatchling.accessory}`), rare: hatchling.accessory === "crown" });
    }
  }
  return (
    <ul aria-label={t("meme.traits.title")} className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      {traits.map(({ label, rare }) => (
        <li
          key={label}
          className={`rounded-md border px-2 py-0.5 text-[11px] font-bold leading-5 ${
            rare ? "border-honey/60 bg-honey/15 text-flare" : "border-line bg-raised text-muted"
          }`}
        >
          {label}
          {rare && <span className="ml-1 font-mono text-[10px] uppercase tracking-wider">· {t("meme.traits.rare")}</span>}
        </li>
      ))}
    </ul>
  );
}
