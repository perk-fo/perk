/**
 * Hatchlings: the creature a launch hatches into when its creator uploaded no artwork. Eight egg-laying species,
 * each with colour variants, two expressions and an accessory (a crown is rare), picked from the launch's configHash
 * like the traits of a generative collection. Deterministic: the same launch always hatches the same hatchling.
 *
 * Drawn on the chick's 64-unit grid, head and body as one rounded figure with a belly, so it can rise out of an egg.
 */
import type { ReactNode } from "react";
import { bytesOf } from "./HashEgg";

export const SPECIES = ["chick", "duckling", "penguin", "owlet", "dino", "croc", "turtle", "dragon"] as const;
export type Species = (typeof SPECIES)[number];
export const ACCESSORIES = ["none", "hat", "shades", "bow", "crown"] as const;
export type Accessory = (typeof ACCESSORIES)[number];

interface Palette {
  main: string;
  belly: string;
  accent: string;
  feature: string;
}

const INK = "#1C1C1C";

const PALETTES: Record<Species, readonly Palette[]> = {
  chick: [
    { main: "#FCD53F", belly: "#FFE58A", accent: "#F9C23C", feature: "#FF822D" },
    { main: "#FFF4D6", belly: "#FFFFFF", accent: "#F3DFA8", feature: "#FF9A3D" },
    { main: "#FFC2D4", belly: "#FFE1EA", accent: "#FF9EBB", feature: "#FF822D" },
    { main: "#A9D4FF", belly: "#D8ECFF", accent: "#7FB7F2", feature: "#FF9A3D" },
  ],
  duckling: [
    { main: "#FFE270", belly: "#FFF1B0", accent: "#F4C542", feature: "#FF9A3D" },
    { main: "#F7F5EE", belly: "#FFFFFF", accent: "#E4E0D2", feature: "#FFB347" },
    { main: "#C9A27C", belly: "#E8D2B8", accent: "#A67F5A", feature: "#F2A93B" },
  ],
  penguin: [
    { main: "#2E3140", belly: "#FFFFFF", accent: "#1F2230", feature: "#FF9A3D" },
    { main: "#3E5C8A", belly: "#FFFFFF", accent: "#2C4468", feature: "#FCD53F" },
    { main: "#5B5F70", belly: "#FFF8EC", accent: "#44485A", feature: "#FF822D" },
  ],
  owlet: [
    { main: "#B98B5E", belly: "#EBD6BC", accent: "#8E6641", feature: "#F2A93B" },
    { main: "#EDEBE4", belly: "#FFFFFF", accent: "#C9C5B8", feature: "#F2A93B" },
    { main: "#B79CDB", belly: "#E6DAF7", accent: "#8E71BF", feature: "#FCD53F" },
  ],
  dino: [
    { main: "#7CCB6B", belly: "#CFEFA5", accent: "#FF9A62", feature: "#5FA852" },
    { main: "#7FB8F0", belly: "#CFE6FF", accent: "#FCD53F", feature: "#5E97CF" },
    { main: "#FFA9C4", belly: "#FFE0EA", accent: "#9B7BE0", feature: "#F081A5" },
    { main: "#A58BE8", belly: "#E3D9FF", accent: "#8FE0B8", feature: "#8468CF" },
  ],
  croc: [
    { main: "#6FAF5A", belly: "#D8EBB4", accent: "#92C97C", feature: "#FFFFFF" },
    { main: "#4FB3A0", belly: "#CDEFE7", accent: "#74C9B8", feature: "#FFFFFF" },
    { main: "#F2EEE4", belly: "#FFFFFF", accent: "#E4DCCB", feature: "#FFFFFF" },
  ],
  turtle: [
    { main: "#9ED36A", belly: "#D6A66B", accent: "#B07A45", feature: "#F0CF93" },
    { main: "#6FC7B4", belly: "#5FA7C9", accent: "#2F7F9C", feature: "#A7DDEB" },
    { main: "#E8C95A", belly: "#9DAF52", accent: "#7A8B3D", feature: "#C9D98A" },
  ],
  dragon: [
    { main: "#A58BE8", belly: "#FFD6A5", accent: "#7C63C9", feature: "#FCD53F" },
    { main: "#FF7B6B", belly: "#FFE0B5", accent: "#D9534F", feature: "#FCD53F" },
    { main: "#5FC9B5", belly: "#E6FFF7", accent: "#3E9C8C", feature: "#FFF1C9" },
  ],
};

export interface HatchlingTraits {
  species: Species;
  variant: number;
  palette: Palette;
  accessory: Accessory;
  happy: boolean;
}

/** The hatchling a hash gets. Uses bytes the egg does not, so egg and hatchling vary independently. */
export function hatchlingTraits(hash: string | undefined): HatchlingTraits {
  const b = bytesOf(hash && !/^0x0*$/.test(hash) ? hash : "0x00");
  const species = SPECIES[b[10]! % SPECIES.length]!;
  const variant = b[11]! % PALETTES[species].length;
  // one in sixteen wears a crown; the rest share the other accessories, with no accessory the commonest
  const roll = b[12]!;
  const accessory: Accessory =
    roll % 16 === 0 ? "crown" : (["none", "none", "hat", "shades", "bow"] as const)[roll % 5]!;
  return { species, variant, palette: PALETTES[species][variant]!, accessory, happy: b[13]! % 3 === 0 };
}

const BODY = "M16 20.2 C16 11.3 23.2 4.2 32 4.2 C40.8 4.2 48 11.3 48 20.2 V36 C48 43.4 41 48 32 48 C23 48 16 43.4 16 36 Z";
const WING_L = "M20.6 22.4 L8.4 20.3 C5.6 19.8 3.9 23.1 5.9 25.1 L15.2 34.4 Z";
const WING_R = "M43.4 22.4 L55.6 20.3 C58.4 19.8 60.1 23.1 58.1 25.1 L48.8 34.4 Z";

function Eyes({ happy, y = 15.4, dx = 9.2, r = 2.05 }: { happy: boolean; y?: number; dx?: number; r?: number }) {
  return (
    <g className="chick-face">
      {[32 - dx, 32 + dx].map((x) =>
        happy ? (
          <path key={x} d={`M${x - 2.4} ${y + 0.8} Q${x} ${y - 2.2} ${x + 2.4} ${y + 0.8}`} fill="none" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
        ) : (
          <g key={x} className="chick-eye">
            <circle cx={x} cy={y} r={r} fill={INK} />
            <circle cx={x + r * 0.34} cy={y - r * 0.34} r={r * 0.3} fill="#fff" />
          </g>
        ),
      )}
    </g>
  );
}

function Cheeks({ y = 21.6, dx = 11.7, colour = "#FF822D" }: { y?: number; dx?: number; colour?: string }) {
  return (
    <g fill={colour} opacity="0.3">
      <circle cx={32 - dx} cy={y} r="2.3" />
      <circle cx={32 + dx} cy={y} r="2.3" />
    </g>
  );
}

function Smile({ y = 22 }: { y?: number }) {
  return <path d={`M29.6 ${y} Q32 ${y + 2.2} 34.4 ${y}`} fill="none" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />;
}

function speciesArt(t: HatchlingTraits): ReactNode {
  const p = t.palette;
  switch (t.species) {
    case "chick":
      return (
        <>
          <path className="chick-wing chick-wing-l" d={WING_L} fill={p.accent} />
          <path className="chick-wing chick-wing-r" d={WING_R} fill={p.accent} />
          <path d={BODY} fill={p.main} />
          <ellipse cx="32" cy="37" rx="10.5" ry="8.6" fill={p.belly} />
          <g className="chick-tuft" fill={p.accent}>
            <path d="M31.6 4.9 C29.9 3.2 29.9 0.9 31.9 0.5 C33.6 1 33.6 3.1 31.6 4.9 Z" />
            <path d="M32.4 5.1 C33.6 3.4 35.8 2.9 36.7 4.1 C36 5.5 34 5.8 32.4 5.1 Z" />
          </g>
          <Cheeks />
          <Eyes happy={t.happy} />
          <path d="M36 18.4 H28 C28 16.2 29.8 14.4 32 14.4 C34.2 14.4 36 16.2 36 18.4 Z" fill={p.feature} />
        </>
      );
    case "duckling":
      return (
        <>
          <path className="chick-wing chick-wing-l" d={WING_L} fill={p.accent} />
          <path className="chick-wing chick-wing-r" d={WING_R} fill={p.accent} />
          <path d={BODY} fill={p.main} />
          <ellipse cx="32" cy="37" rx="10.5" ry="8.6" fill={p.belly} />
          <path className="chick-tuft" d="M32 4.6 C30.4 2.4 31.4 0.4 33.4 1 C32.4 2 32.6 3.2 34 4 Z" fill={p.accent} />
          <Cheeks y={22.4} />
          <Eyes happy={t.happy} y={14.2} />
          <path d="M25.4 18.2 H38.6 C41.2 18.2 41.2 23.4 38.6 23.4 H25.4 C22.8 23.4 22.8 18.2 25.4 18.2 Z" fill={p.feature} />
          <circle cx="29.4" cy="19.8" r="0.7" fill={INK} opacity="0.45" />
          <circle cx="34.6" cy="19.8" r="0.7" fill={INK} opacity="0.45" />
        </>
      );
    case "penguin":
      return (
        <>
          <path className="chick-wing chick-wing-l" d="M17.4 23 C11.6 25.6 8.4 32.4 9.4 36.4 C12.6 35.6 16 32.2 17.6 28.6 Z" fill={p.accent} />
          <path className="chick-wing chick-wing-r" d="M46.6 23 C52.4 25.6 55.6 32.4 54.6 36.4 C51.4 35.6 48 32.2 46.4 28.6 Z" fill={p.accent} />
          <path d={BODY} fill={p.main} />
          <path d="M32 10.4 C26.6 6.6 17.8 9.2 18.6 17.8 C19.4 25.4 25.2 29.4 32 29.4 C38.8 29.4 44.6 25.4 45.4 17.8 C46.2 9.2 37.4 6.6 32 10.4 Z" fill={p.belly} />
          <ellipse cx="32" cy="38" rx="11" ry="8.6" fill={p.belly} />
          <Cheeks y={22} dx={9.6} colour="#FF8A9A" />
          <Eyes happy={t.happy} y={16.4} dx={6.8} />
          <path d="M29.4 20 H34.6 L32 23.6 Z" fill={p.feature} />
        </>
      );
    case "owlet":
      return (
        <>
          <path className="chick-wing chick-wing-l" d="M17 21 C12.4 25 12 33 14.6 37.4 C16.6 34.6 17.8 29 18 24 Z" fill={p.accent} />
          <path className="chick-wing chick-wing-r" d="M47 21 C51.6 25 52 33 49.4 37.4 C47.4 34.6 46.2 29 46 24 Z" fill={p.accent} />
          <path d="M18.2 12.4 L14.6 1.6 L25.4 7.6 Z" fill={p.main} />
          <path d="M45.8 12.4 L49.4 1.6 L38.6 7.6 Z" fill={p.main} />
          <path d={BODY} fill={p.main} />
          <ellipse cx="32" cy="37.4" rx="10.6" ry="8.8" fill={p.belly} />
          <g fill="none" stroke={p.accent} strokeWidth="1.2" strokeLinecap="round">
            <path d="M27.4 34.4 L28.8 36 L30.2 34.4" />
            <path d="M33.8 34.4 L35.2 36 L36.6 34.4" />
            <path d="M30.6 38.6 L32 40.2 L33.4 38.6" />
          </g>
          <circle cx="23.8" cy="16.4" r="6.2" fill={p.belly} />
          <circle cx="40.2" cy="16.4" r="6.2" fill={p.belly} />
          <Eyes happy={t.happy} y={16.4} dx={8.2} r={2.7} />
          <path d="M30 20.4 H34 L32 24.2 Z" fill={p.feature} />
        </>
      );
    case "dino":
      return (
        <>
          <g fill={p.accent}>
            <path d="M22.6 8.6 L23.4 1.8 L28.8 5.6 Z" />
            <path d="M29 5 L32 -0.8 L35 5 Z" />
            <path d="M41.4 8.6 L40.6 1.8 L35.2 5.6 Z" />
          </g>
          <path className="chick-wing chick-wing-l" d="M16.6 30 C13.2 30.4 12 33.6 13.4 35 C15 35.4 16.6 34 17 32.6 Z" fill={p.main} />
          <path className="chick-wing chick-wing-r" d="M47.4 30 C50.8 30.4 52 33.6 50.6 35 C49 35.4 47.4 34 47 32.6 Z" fill={p.main} />
          <path d={BODY} fill={p.main} />
          <ellipse cx="32" cy="37.6" rx="10.8" ry="8.6" fill={p.belly} />
          <g fill={p.feature} opacity="0.8">
            <circle cx="20.4" cy="11.6" r="1.5" />
            <circle cx="44.4" cy="10.8" r="1.2" />
            <circle cx="46" cy="26" r="1.4" />
          </g>
          <Cheeks y={22} colour="#FF8A9A" />
          <Eyes happy={t.happy} />
          <circle cx="29.8" cy="20" r="0.7" fill={INK} opacity="0.5" />
          <circle cx="34.2" cy="20" r="0.7" fill={INK} opacity="0.5" />
          <Smile y={22.6} />
        </>
      );
    case "croc":
      return (
        <>
          <path className="chick-wing chick-wing-l" d="M16.6 31 C13 31 11.6 34.4 13.2 35.8 C15 36 16.6 34.6 17 33.2 Z" fill={p.main} />
          <path className="chick-wing chick-wing-r" d="M47.4 31 C51 31 52.4 34.4 50.8 35.8 C49 36 47.4 34.6 47 33.2 Z" fill={p.main} />
          <path d={BODY} fill={p.main} />
          {/* eyes on bumps on top of the head */}
          <circle cx="23" cy="8.6" r="6" fill={p.main} />
          <circle cx="41" cy="8.6" r="6" fill={p.main} />
          <ellipse cx="32" cy="38.2" rx="10.8" ry="8" fill={p.belly} />
          <g fill={INK} opacity="0.12">
            <circle cx="24" cy="30" r="1.2" />
            <circle cx="40" cy="30" r="1.2" />
          </g>
          <circle cx="23" cy="9" r="3.4" fill="#fff" />
          <circle cx="41" cy="9" r="3.4" fill="#fff" />
          <Eyes happy={t.happy} y={9.4} dx={9} r={1.9} />
          {/* the snout, with nostrils and a row of little teeth */}
          <path d="M20.6 17.6 H43.4 C47.4 17.6 47.4 26.6 43.4 26.6 H20.6 C16.6 26.6 16.6 17.6 20.6 17.6 Z" fill={p.accent} />
          <circle cx="29.4" cy="19.8" r="0.9" fill={INK} opacity="0.5" />
          <circle cx="34.6" cy="19.8" r="0.9" fill={INK} opacity="0.5" />
          <g fill={p.feature}>
            {[23, 27.2, 31.4, 35.6, 39.8].map((x) => (
              <path key={x} d={`M${x} 26.2 L${x + 1.4} 28.6 L${x + 2.8} 26.2 Z`} />
            ))}
          </g>
        </>
      );
    case "turtle":
      return (
        <>
          {/* the shell is the body; the head peeks out of its front */}
          <path className="chick-wing chick-wing-l" d="M12.8 33 C8.6 32.6 7 36.4 9 38.4 C11.4 38.8 13.4 37 14 35.4 Z" fill={p.main} />
          <path className="chick-wing chick-wing-r" d="M51.2 33 C55.4 32.6 57 36.4 55 38.4 C52.6 38.8 50.6 37 50 35.4 Z" fill={p.main} />
          <ellipse cx="32" cy="34" rx="21" ry="15" fill={p.accent} />
          <ellipse cx="32" cy="33" rx="17.4" ry="11.8" fill={p.belly} />
          <g fill="none" stroke={p.accent} strokeWidth="1.3" strokeLinejoin="round">
            <path d="M28 27 H36 L39.4 32.6 L36 38.2 H28 L24.6 32.6 Z" />
            <path d="M24.6 32.6 H16.4 M39.4 32.6 H47.6 M28 27 L25 22.4 M36 27 L39 22.4 M28 38.2 L25.4 43.6 M36 38.2 L38.6 43.6" />
          </g>
          <path d="M32 3.2 C39.2 3.2 43.4 8.6 43.4 14.6 C43.4 20.8 38.4 24.4 32 24.4 C25.6 24.4 20.6 20.8 20.6 14.6 C20.6 8.6 24.8 3.2 32 3.2 Z" fill={p.main} />
          <Cheeks y={17.8} dx={7.6} colour="#FF8A9A" />
          <Eyes happy={t.happy} y={12.6} dx={5.6} r={1.8} />
          <Smile y={17.6} />
        </>
      );
    case "dragon":
      return (
        <>
          {/* little bat wings behind the body */}
          <path
            className="chick-wing chick-wing-l"
            d="M18 20 C11 14 4.4 15.6 2.4 18.4 C5 18.8 6 21 5.4 23 C8.2 22 10 23.6 10.2 26 C12.8 24.6 15.4 25.8 16.6 28.2 Z"
            fill={p.accent}
          />
          <path
            className="chick-wing chick-wing-r"
            d="M46 20 C53 14 59.6 15.6 61.6 18.4 C59 18.8 58 21 58.6 23 C55.8 22 54 23.6 53.8 26 C51.2 24.6 48.6 25.8 47.4 28.2 Z"
            fill={p.accent}
          />
          <path d="M22 9.4 C20.6 5 21.6 1.8 23.6 1.2 C24 4 25.2 6.4 26.8 7.8 Z" fill={p.feature} />
          <path d="M42 9.4 C43.4 5 42.4 1.8 40.4 1.2 C40 4 38.8 6.4 37.2 7.8 Z" fill={p.feature} />
          <path d={BODY} fill={p.main} />
          <ellipse cx="32" cy="37.4" rx="10.4" ry="9" fill={p.belly} />
          <g fill="none" stroke={p.accent} strokeWidth="1" opacity="0.5">
            <path d="M23.6 34 H40.4 M22.8 38 H41.2 M24.4 42 H39.6" />
          </g>
          <Cheeks y={21.8} colour="#FF8A9A" />
          <Eyes happy={t.happy} />
          <circle cx="29.8" cy="19.6" r="0.7" fill={INK} opacity="0.5" />
          <circle cx="34.2" cy="19.6" r="0.7" fill={INK} opacity="0.5" />
          <path d="M29.4 22 Q32 24.4 34.6 22" fill="none" stroke={INK} strokeWidth="1.3" strokeLinecap="round" />
          <path d="M33.2 22.9 L33.8 24.4 L34.4 22.6 Z" fill="#fff" />
        </>
      );
  }
}

/** Where each species' eyes sit, so glasses line up. */
const EYE_LINE: Record<Species, { y: number; dx: number }> = {
  chick: { y: 15.4, dx: 9.2 },
  duckling: { y: 14.2, dx: 9.2 },
  penguin: { y: 16.4, dx: 6.8 },
  owlet: { y: 16.4, dx: 8.2 },
  dino: { y: 15.4, dx: 9.2 },
  croc: { y: 9.4, dx: 9 },
  turtle: { y: 12.6, dx: 5.6 },
  dragon: { y: 15.4, dx: 9.2 },
};
/** The top of each species' head, where hats and crowns sit. */
const CROWN_Y: Record<Species, number> = {
  chick: 4.4, duckling: 4.4, penguin: 4.4, owlet: 5.6, dino: 3.4, croc: 2.8, turtle: 3.4, dragon: 4.4,
};

function accessoryArt(t: HatchlingTraits): ReactNode {
  const top = CROWN_Y[t.species];
  switch (t.accessory) {
    case "hat":
      return (
        <g transform={`rotate(-12 32 ${top})`}>
          <path d={`M32 ${top - 11} L26 ${top + 1} H38 Z`} fill="#8EC5FF" />
          <path d={`M29.9 ${top - 6.8} L34.1 ${top - 6.8} M28.2 ${top - 3} L35.8 ${top - 3}`} stroke="#FFFFFF" strokeWidth="1.4" />
          <circle cx="32" cy={top - 11} r="2" fill="#FF822D" />
        </g>
      );
    case "shades": {
      const e = EYE_LINE[t.species];
      return (
        <g>
          <rect x={32 - e.dx - 4.2} y={e.y - 2.6} width="8.4" height="5.2" rx="2.2" fill={INK} />
          <rect x={32 + e.dx - 4.2} y={e.y - 2.6} width="8.4" height="5.2" rx="2.2" fill={INK} />
          <path d={`M${32 - e.dx + 4.2} ${e.y - 1.2} H${32 + e.dx - 4.2}`} stroke={INK} strokeWidth="1.2" />
          <path d={`M${32 - e.dx - 2.6} ${e.y - 1.2} L${32 - e.dx - 0.6} ${e.y - 1.2}`} stroke="#fff" strokeWidth="0.9" strokeLinecap="round" opacity="0.8" />
          <path d={`M${32 + e.dx - 2.6} ${e.y - 1.2} L${32 + e.dx - 0.6} ${e.y - 1.2}`} stroke="#fff" strokeWidth="0.9" strokeLinecap="round" opacity="0.8" />
        </g>
      );
    }
    case "bow":
      return (
        <g transform={`translate(40 ${top + 2.4}) rotate(18)`}>
          <path d="M0 0 L-5.4 -3.4 L-5.4 3.4 Z" fill="#FF6F91" />
          <path d="M0 0 L5.4 -3.4 L5.4 3.4 Z" fill="#FF6F91" />
          <circle r="1.7" fill="#E0507A" />
        </g>
      );
    case "crown":
      return (
        <g>
          <path d={`M25 ${top + 1.6} L25 ${top - 5} L28.6 ${top - 1.6} L32 ${top - 6.4} L35.4 ${top - 1.6} L39 ${top - 5} L39 ${top + 1.6} Z`} fill="#F9C23C" stroke="#C98A12" strokeWidth="0.8" strokeLinejoin="round" />
          <circle cx="32" cy={top - 1} r="1.2" fill="#FF6F91" />
          <circle cx="27.4" cy={top - 0.2} r="0.8" fill="#8EC5FF" />
          <circle cx="36.6" cy={top - 0.2} r="0.8" fill="#8FE0B8" />
        </g>
      );
    default:
      return null;
  }
}

/** The hatchling for `hash`, as SVG content on the 64-unit grid (no <svg> wrapper). */
export function HatchlingArt({ hash }: { hash?: string }) {
  const t = hatchlingTraits(hash);
  return (
    <g className="chick-bird">
      {speciesArt(t)}
      {accessoryArt(t)}
    </g>
  );
}

/** A hatchling on its own, for previews. */
export function Hatchling({ hash, size = 64 }: { hash?: string; size?: number }) {
  return (
    <svg viewBox="0 -4 64 64" width={size} height={size} aria-hidden>
      <HatchlingArt hash={hash} />
    </svg>
  );
}
