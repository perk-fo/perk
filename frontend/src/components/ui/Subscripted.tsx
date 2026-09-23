import type { ReactNode } from "react";

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

type Run = { sub: boolean; text: string };

/** Split "0.0₁₀4297" into plain and subscript runs, with the subscript digits turned back into 0-9. */
function runs(text: string): Run[] {
  const out: Run[] = [];
  for (const ch of text) {
    const i = SUBSCRIPT.indexOf(ch);
    const sub = i >= 0;
    const c = sub ? String(i) : ch;
    const last = out[out.length - 1];
    if (last && last.sub === sub) last.text += c;
    else out.push({ sub, text: c });
  }
  return out;
}

/**
 * A formatted price with its zero count as a real subscript. formatPrice writes the count with Unicode subscript
 * digits, which none of the site's faces contain, so browsers borrowed them from a fallback font: mismatched
 * glyphs with gaps around them, worst at headline size. Here they stay in the surrounding face.
 */
export function Subscripted({ text }: { text: string }): ReactNode {
  return runs(text).map((r, i) =>
    r.sub ? (
      <sub key={i} className="price-sub">
        {r.text}
      </sub>
    ) : (
      r.text
    ),
  );
}

/** The same inside SVG <text>: shift the zero count down and back up with tspans. */
export function SvgSubscripted({ text }: { text: string }): ReactNode {
  return runs(text).map((r, i) =>
    r.sub ? (
      <tspan key={i} fontSize="72%" dy="0.28em">
        {r.text}
      </tspan>
    ) : (
      <tspan key={i} dy={i > 0 ? "-0.28em" : undefined}>
        {r.text}
      </tspan>
    ),
  );
}
