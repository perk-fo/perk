/**
 * Cute animal portraits for demo tokens, drawn without dependencies: a few anti-aliased shapes (circles, ellipses,
 * triangles) rasterised into an RGB buffer, 3×3 supersampled. Each demo token is named after an animal ("Ledger
 * Frog", "Rollup Raccoon"), and the last word of the name picks its face; anything unknown gets a chick.
 */

type RGB = readonly [number, number, number];
type Inside = (x: number, y: number) => boolean;

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const circle = (cx: number, cy: number, r: number): Inside => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ellipse =
  (cx: number, cy: number, rx: number, ry: number, rot = 0): Inside =>
  (x, y) => {
    const c = Math.cos(-rot);
    const s = Math.sin(-rot);
    const dx = (x - cx) * c - (y - cy) * s;
    const dy = (x - cx) * s + (y - cy) * c;
    return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
  };
const triangle =
  (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): Inside =>
  (x, y) => {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

class Canvas {
  readonly px: Float64Array;
  constructor(readonly size: number, bg: RGB) {
    this.px = new Float64Array(size * size * 3);
    for (let i = 0; i < size * size; i++) this.px.set(bg, i * 3);
  }
  /** Paint `shape` in `colour` at `alpha`, with coverage from 3×3 samples per pixel. */
  fill(shape: Inside, colour: RGB, alpha = 1): void {
    const n = this.size;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let hits = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (shape(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits++;
        if (hits === 0) continue;
        const a = (hits / 9) * alpha;
        const i = (y * n + x) * 3;
        for (let k = 0; k < 3; k++) this.px[i + k] = this.px[i + k]! * (1 - a) + colour[k]! * a;
      }
    }
  }
  rows(): Uint8Array {
    const n = this.size;
    const out = new Uint8Array(n * (n * 3 + 1));
    for (let y = 0; y < n; y++) {
      out[y * (n * 3 + 1)] = 0; // PNG filter byte: none
      for (let x = 0; x < n * 3; x++) out[y * (n * 3 + 1) + 1 + x] = Math.round(this.px[y * n * 3 + x]!);
    }
    return out;
  }
}

type Ears = "round" | "pointy" | "long" | "none" | "antennae" | "tuft" | "horns" | "bunny" | "floppy";
interface Face {
  bg: string;
  head: string;
  ears: Ears;
  inner?: string;
  muzzle?: string;
  nose?: string;
  beak?: string;
  /** raccoon mask / badger stripe / puffin face patch */
  mask?: string;
  stripe?: string;
  face?: string;
  /** frog-style eyes on top of the head */
  bulgeEyes?: boolean;
  /** ears in their own colour (panda, puppy) */
  earColor?: string;
  /** dark patches around the eyes (panda) */
  patches?: string;
  /** a mane behind the head (lion) */
  mane?: string;
}

const INK = "#1C1C1C";
const FACES: Record<string, Face> = {
  frog: { bg: "#FFF1C9", head: "#7FD17A", ears: "none", bulgeEyes: true, muzzle: "#A9E3A0" },
  goblin: { bg: "#E6F7D9", head: "#8CC56B", ears: "long", inner: "#B7DE98", nose: "#5E9A45" },
  moth: { bg: "#EFE8FF", head: "#C8B9A6", ears: "antennae", muzzle: "#E6DCCF", nose: "#8C7A66" },
  raccoon: { bg: "#E8F1FF", head: "#A7A9B4", ears: "round", inner: "#E1E2E8", mask: "#3D3F4A", muzzle: "#F2F2F5", nose: INK },
  sloth: { bg: "#FFF1C9", head: "#B89A78", ears: "none", mask: "#6E5236", muzzle: "#E8D6BE", nose: "#4A3624" },
  newt: { bg: "#FFE3D6", head: "#FF9A62", ears: "none", bulgeEyes: true, muzzle: "#FFBE95" },
  otter: { bg: "#E0F2FF", head: "#9C7352", ears: "round", inner: "#C7A383", muzzle: "#E8D2BC", nose: "#3B2A1C" },
  badger: { bg: "#F0EFE8", head: "#6B6C73", ears: "round", inner: "#A4A5AC", stripe: "#F5F5F2", muzzle: "#F5F5F2", nose: INK },
  ferret: { bg: "#FFF5E6", head: "#E9D5B9", ears: "round", inner: "#F6C9C9", mask: "#8A6A4E", muzzle: "#FFF7EC", nose: "#C97A7A" },
  crow: { bg: "#E8F1FF", head: "#3A3D4A", ears: "tuft", beak: "#FCD53F" },
  lynx: { bg: "#FFF1C9", head: "#E0B27A", ears: "pointy", inner: "#F6D9B4", muzzle: "#FBEBD5", nose: "#C9786E" },
  tapir: { bg: "#EFE8FF", head: "#5B5F70", ears: "round", inner: "#8B8FA0", muzzle: "#C7CAD6", nose: "#3A3D4A" },
  gecko: { bg: "#E6F7D9", head: "#9ED36A", ears: "none", bulgeEyes: true, muzzle: "#C3E89C" },
  mole: { bg: "#FFE9EF", head: "#5A4A42", ears: "none", muzzle: "#F2A7B8", nose: "#E0708C" },
  heron: { bg: "#E0F2FF", head: "#B7C3D3", ears: "tuft", beak: "#FF9A3D" },
  egret: { bg: "#E8F7F0", head: "#FAFAF6", ears: "tuft", beak: "#FCD53F" },
  vole: { bg: "#FFF5E6", head: "#A88464", ears: "round", inner: "#E7B7A8", muzzle: "#D9BFA4", nose: "#5A3E2A" },
  coyote: { bg: "#FFF1C9", head: "#C99A63", ears: "pointy", inner: "#EACBA2", muzzle: "#F4E1C6", nose: INK },
  shrew: { bg: "#FFE9EF", head: "#8E7A6E", ears: "round", inner: "#E7B7A8", muzzle: "#C9B5A8", nose: "#E0708C" },
  quail: { bg: "#FFF1C9", head: "#B98B5E", ears: "tuft", beak: "#3A2A1C" },
  bison: { bg: "#FFE3D6", head: "#6E4B32", ears: "horns", inner: "#EDE3D0", muzzle: "#9C7358", nose: "#2A1C12" },
  puffin: { bg: "#E0F2FF", head: "#2E3140", ears: "none", face: "#F7F6F2", beak: "#FF822D" },
  panda: { bg: "#E6F7D9", head: "#FAFAF6", ears: "round", earColor: "#2E2E2E", patches: "#2E2E2E", muzzle: "#FFFFFF", nose: INK },
  fox: { bg: "#FFF1C9", head: "#FF8A3D", ears: "pointy", inner: "#FFF1E6", muzzle: "#FFF7EC", nose: INK },
  bunny: { bg: "#FFE9EF", head: "#F2EDE8", ears: "bunny", inner: "#F6C9C9", muzzle: "#FFFFFF", nose: "#E0708C" },
  bear: { bg: "#FFF5E6", head: "#9C6B45", ears: "round", inner: "#C99A73", muzzle: "#E8D2BC", nose: "#3B2A1C" },
  duck: { bg: "#E0F2FF", head: "#FCD53F", ears: "tuft", beak: "#FF822D" },
  seal: { bg: "#E0F2FF", head: "#9FA8B5", ears: "none", muzzle: "#D5DAE2", nose: INK },
  koala: { bg: "#E8F1FF", head: "#A7A9B4", ears: "round", inner: "#F2F2F5", muzzle: "#C7C9D1", nose: "#3A3D4A" },
  hamster: { bg: "#FFF1C9", head: "#E8B27A", ears: "round", inner: "#F6C9C9", muzzle: "#FFF7EC", nose: "#E0708C" },
  kitten: { bg: "#EFE8FF", head: "#B7B7C2", ears: "pointy", inner: "#F6C9C9", muzzle: "#F2F2F5", nose: "#E0708C" },
  pig: { bg: "#FFE9EF", head: "#FFB0C8", ears: "pointy", inner: "#FF8FB0", muzzle: "#FF8FB0", nose: "#E0708C" },
  pup: { bg: "#FFF5E6", head: "#D9A066", ears: "floppy", earColor: "#8A5A34", muzzle: "#FFF1E0", nose: INK },
  owl: { bg: "#EFE8FF", head: "#9C7352", ears: "pointy", inner: "#C7A383", face: "#F2E3CF", beak: "#FCD53F" },
  penguin: { bg: "#E0F2FF", head: "#2E3140", ears: "none", face: "#F7F6F2", beak: "#FF9A3D" },
  hedgehog: { bg: "#FFF5E6", head: "#8E6E52", ears: "round", inner: "#E7C9A8", muzzle: "#F2DCC2", nose: INK },
  tiger: { bg: "#FFF1C9", head: "#FF9A3D", ears: "round", inner: "#FFF1E6", stripe: "#2E2E2E", muzzle: "#FFF7EC", nose: "#E0708C" },
  lion: { bg: "#FFF1C9", head: "#F2C27A", mane: "#C9782E", ears: "round", inner: "#FBEBD5", muzzle: "#FBEBD5", nose: "#6B3F1F" },
  monkey: { bg: "#E6F7D9", head: "#8C5E3C", ears: "round", inner: "#E8C9A0", face: "#E8C9A0", nose: "#5A3A24" },
  turtle: { bg: "#E6F7D9", head: "#8FD17A", ears: "none", muzzle: "#BDE8AE" },
  squirrel: { bg: "#FFF5E6", head: "#C9783A", ears: "pointy", inner: "#F6D9B4", muzzle: "#FBEBD5", nose: INK },
  deer: { bg: "#FFF1C9", head: "#C99A63", ears: "horns", inner: "#8A5A34", muzzle: "#F4E1C6", nose: INK },
  chick: { bg: "#FFF1C9", head: "#FCD53F", ears: "tuft", beak: "#FF822D" },
};

/** The face for a token name: its last word, lower-cased, or the chick. */
export function faceFor(name: string): Face {
  const key = name.trim().split(/\s+/).pop()!.toLowerCase();
  return FACES[key] ?? FACES.chick!;
}

/** Raw RGB rows (PNG filter bytes included) of a `size`×`size` portrait. */
export function drawAnimal(name: string, size = 192): Uint8Array {
  const f = faceFor(name);
  const k = size / 256; // shapes are laid out on a 256 grid
  const c = new Canvas(size, hex(f.bg));
  const S = (v: number) => v * k;
  const head = hex(f.head);

  c.fill(circle(S(128), S(128), S(112)), [255, 255, 255], 0.35);
  if (f.mane) c.fill(circle(S(128), S(136), S(116)), hex(f.mane));
  const ear = f.earColor ? hex(f.earColor) : head;
  // ears behind the head
  if (f.ears === "bunny") {
    c.fill(ellipse(S(96), S(52), S(19), S(54), -0.16), ear);
    c.fill(ellipse(S(160), S(52), S(19), S(54), 0.16), ear);
    if (f.inner) {
      c.fill(ellipse(S(96), S(56), S(9), S(40), -0.16), hex(f.inner));
      c.fill(ellipse(S(160), S(56), S(9), S(40), 0.16), hex(f.inner));
    }
  } else if (f.ears === "round") {
    for (const x of [68, 188]) {
      c.fill(circle(S(x), S(70), S(34)), ear);
      if (f.inner) c.fill(circle(S(x), S(72), S(19)), hex(f.inner));
    }
  } else if (f.ears === "pointy" || f.ears === "long") {
    const tall = f.ears === "long" ? 20 : 0;
    c.fill(triangle(S(50), S(118), S(62 - tall), S(22 - tall / 2), S(118), S(78)), head);
    c.fill(triangle(S(206), S(118), S(194 + tall), S(22 - tall / 2), S(138), S(78)), head);
    if (f.inner) {
      c.fill(triangle(S(66), S(104), S(72 - tall), S(46 - tall / 2), S(106), S(82)), hex(f.inner));
      c.fill(triangle(S(190), S(104), S(184 + tall), S(46 - tall / 2), S(150), S(82)), hex(f.inner));
    }
  } else if (f.ears === "horns") {
    c.fill(triangle(S(56), S(92), S(22), S(52), S(84), S(70)), hex(f.inner ?? "#EDE3D0"));
    c.fill(triangle(S(200), S(92), S(234), S(52), S(172), S(70)), hex(f.inner ?? "#EDE3D0"));
  } else if (f.ears === "antennae") {
    c.fill(ellipse(S(96), S(52), S(5), S(38), -0.45), hex(INK));
    c.fill(ellipse(S(160), S(52), S(5), S(38), 0.45), hex(INK));
    c.fill(ellipse(S(80), S(20), S(16), S(11), -0.4), head);
    c.fill(ellipse(S(176), S(20), S(16), S(11), 0.4), head);
  } else if (f.ears === "tuft") {
    c.fill(ellipse(S(122), S(40), S(10), S(26), -0.35), head);
    c.fill(ellipse(S(140), S(44), S(8), S(20), 0.45), head);
  }

  // head
  c.fill(ellipse(S(128), S(142), S(f.bulgeEyes ? 96 : 88), S(f.bulgeEyes ? 78 : 86)), head);
  if (f.face) c.fill(ellipse(S(128), S(150), S(66), S(58)), hex(f.face));
  if (f.stripe) c.fill(ellipse(S(128), S(98), S(15), S(60)), hex(f.stripe));
  if (f.mask) c.fill(ellipse(S(128), S(130), S(80), S(24)), hex(f.mask));
  if (f.patches) {
    c.fill(ellipse(S(90), S(130), S(24), S(30), 0.5), hex(f.patches));
    c.fill(ellipse(S(166), S(130), S(24), S(30), -0.5), hex(f.patches));
  }
  // floppy ears hang over the sides of the head
  if (f.ears === "floppy") {
    c.fill(ellipse(S(50), S(132), S(24), S(50), 0.3), ear);
    c.fill(ellipse(S(206), S(132), S(24), S(50), -0.3), ear);
  }

  // eyes
  const eyeY = f.bulgeEyes ? 78 : 128;
  for (const x of [92, 164]) {
    if (f.bulgeEyes) c.fill(circle(S(x), S(eyeY), S(30)), head);
    if (f.bulgeEyes) c.fill(circle(S(x), S(eyeY), S(20)), [255, 255, 255]);
    c.fill(circle(S(x), S(eyeY + (f.bulgeEyes ? 2 : 0)), S(f.bulgeEyes ? 12 : 11)), hex(INK));
    c.fill(circle(S(x + 4), S(eyeY - 4), S(4)), [255, 255, 255]);
  }
  // cheeks
  c.fill(ellipse(S(74), S(170), S(15), S(10)), hex("#FF8A9A"), 0.45);
  c.fill(ellipse(S(182), S(170), S(15), S(10)), hex("#FF8A9A"), 0.45);

  // muzzle, nose or beak
  if (f.beak) {
    c.fill(triangle(S(106), S(156), S(150), S(156), S(128), S(192)), hex(f.beak));
  } else {
    if (f.muzzle) c.fill(ellipse(S(128), S(176), S(38), S(26)), hex(f.muzzle));
    if (f.nose) c.fill(ellipse(S(128), S(162), S(12), S(8)), hex(f.nose));
    // a small smile: two dark dots stand in for the mouth corners
    c.fill(circle(S(118), S(184), S(3)), hex(INK), 0.8);
    c.fill(circle(S(138), S(184), S(3)), hex(INK), 0.8);
    c.fill(ellipse(S(128), S(188), S(9), S(4)), hex(INK), 0.8);
  }
  return c.rows();
}
