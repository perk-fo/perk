# Perk visual system

In one line: **a verifiable credential**, wearing Perk's skin. The brand mark (`public/brand/perk-logo.jpeg`) is a
fluorescent lemon-green fox silhouette on deep ink green, with a four-pointed star, inside a circle cut open by a
"P". The interface grows out of it: bold rounded geometric silhouettes, calm graphite surfaces, the lime kept for
the one thing to do on each screen, and the star as the finishing touch. It is meant to be read for hours: nothing is
harsher than it needs to be, and nothing anyone has to read is faint.

## Concepts

- Silhouette meets instrument panel. Headings use a geometric sans with character (Bricolage Grotesque, wide,
  optical sizing), body text and figures use Instrument Sans (tabular figures for numbers), identifiers use
  JetBrains Mono.
- Each launch's `HashSeal` is a **disc with a P-shaped notch**: lemon-green or ink-green face, a four-pointed star
  at the centre, the pattern held inside the disc, and outer-ring ticks encoding the module bits. The seal matches
  only when the preview's config hash matches the chain's.
- The star is the only ornament: status dots, success states, the Recommended marker, the loading shimmer.
- Modules are building blocks, grant positions are ticket stubs, and the curve is the protagonist.
- Shape language: buttons, pills and inputs are all `rounded-full`; panels use an 18px radius; seals are circular.
  Nothing has square corners.

## Colour

Tokens live in `globals.css` as RGB triplets, one set per theme; `tailwind.config.ts` exposes them as colours. Every
text colour was measured against the page and panel colours (WCAG 2 contrast ratio and APCA Lc); the numbers below
are WCAG ratios on the page colour.

Why the values are what they are. The first version used the logo's two colours directly: page `#0F1D1D`, lime
`#D6FD3E`. Users reported eye strain in both themes, and the measurements explain it. Dark mode put primary text at
15:1 and the lime at 14.8:1 (lime sits at the peak of the eye's brightness sensitivity at full saturation), while
roughly 85 uses of `bone/40`-`bone/55` put secondary text at 3.5-4.7:1: glare and squinting on the same screen.
Light mode had lime text and the primary button label at 2.6:1 and secondary text at 2.5-3.8:1. An audit of eight
pages found 179 (dark) and 509 (light) text elements below WCAG AA; this system has none (disabled controls, which
WCAG exempts, aside).

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| ink | #121916 | #F4F5F1 | Page background |
| surface | #1A221F | #FCFDFA | Panels |
| raised | #242C29 | #EDEEEA | Inputs, hover, tracks, nested cards |
| knob | #343D39 | #FCFDFA | The selected thumb of a segmented control |
| line / line-strong | #2D3632 / #464E4B | #DADDD8 / #BFC4BE | Borders and dividers / control outlines |
| bone | #DADFDB (13.2:1) | #1E2824 (13.9:1) | Primary text |
| muted | #B6BDB8 (9.3:1) | #4B5551 (7.1:1) | Secondary text |
| subtle | #969E99 (6.5:1) | #616A66 (5.1:1) | Labels, meta: the lowest tier anyone has to read |
| faint | #6A726E | #8A918D | Placeholders, disabled, decoration only |
| flare | #BFE16B (12.1:1) | #406C13 (5.7:1) | Accent as text and indicator: links, progress, selection, focus |
| cta / on-cta | #D1F556 / #111F1C | #142B29 / #D1F556 | Primary action: lime on ink in dark, ink carrying lime in light |
| verdigris | #73D5A7 | #176E4A | Up, success |
| amber | #F0BE67 | #8F550B | Warning, countdowns |
| ember | #F2985F | #A34409 | Severity grading only (indexer lag), between amber and rose |
| rose | #F17F85 | #B13038 | Down, danger, cancellation |

Rules:

- Text colour is one of the four solid tiers. Never set text with an alpha (`text-bone/50`): its contrast then depends
  on whatever it lands on, which is how the old secondary text ended up unreadable.
- Primary text stays near 13:1 in both themes. Higher is not better: white-on-black contrast causes halation.
- The lime appears in two forms only. As the primary action it is a fill (dark) or the label on an ink button
  (light), the logo's two colourways. As `flare` it is a softened lime in dark mode and a deep leaf green in light
  mode, because lime cannot be read on a light page. Never use lime for large areas of text or for decoration.
- Market direction has its own colours: up is `verdigris`, down is `rose`. Lime means "act", not "went up".
- Status pills are a 10% tint of their colour with the colour as text, no outline (at least 4.8:1 in both themes).
  An expired grant campaign is muted; `rose` is kept for failure and cancellation.
- Price impact is coloured by size, not sign: quiet under 1%, amber from 1%, rose from 5%.
- Panels are separated by tone plus a 1px `line` border; light mode adds a faint shadow. No glows, no background
  texture, no gradients behind text.
- Deterministic art (`HashSeal`) draws from `--seal-*` tokens: the logo's lime and ink, softened a step, so a list
  of seals is not a wall of fluorescent discs.

### Palettes

Readers choose a palette in the theme menu, under the mode (System / Light / Dark). A palette changes only the
neutral tones (page, panels, lines and the tint of text); accents and status colours are shared, and every
lightness step is the same, so contrast is identical in all three. Graphite is the default. Moss leans toward the
logo's ink green; Stone is warm. The choice is kept in localStorage (`perk-palette`) and applied as `data-palette`
by the same pre-paint script as the theme.

## Type

- Headings: Bricolage Grotesque 600 with `font-optical-sizing: auto`, so a 20px heading uses the text cut rather
  than the 96pt display cut that was forced everywhere before; tracking -0.02em (-0.03em on the hero). The wordmark
  (`.wordmark`) keeps the display cut at every size because it is part of the logo lockup.
- Body: Instrument Sans 400/500, 15px, line height 1.6. Chinese falls back to PingFang SC / Noto Sans SC, Japanese to
  Hiragino Sans / Noto Sans JP.
- Figures (`.num`): the text face with tabular figures, so columns align without a typewriter look. Identifiers
  (`.mono`: addresses, hashes, module ids, the proof JSON) use JetBrains Mono.
- Small prices keep the zero count as a real subscript in the surrounding face (`components/ui/Subscripted`):
  `formatPrice` writes Unicode subscript digits, which none of the site's faces contain.
- Minimum sizes: 12px for anything a person reads, 13px for labels (`.label`, no letter-spacing), 11px only for
  tiny badges. Charts measure their container and draw at 1:1, so axis labels are the size they say they are.

## Layout

- Content is 1120px wide on a 12-column grid with 24px gutters; page margins are 24px, or 16px on mobile.
- Vertical rhythm is an 8px baseline; panel padding is 24px, section spacing 48px, and the gap from header to the
  first screen 64px.
- Panels take a 1px `line` border and an 18px radius (light mode adds a faint shadow); linked panels lift their border
  to `line-strong` on hover. Menus and toasts use `.popover`, a floating surface with a soft shadow.
- The header is two rows on a phone (brand and controls, then navigation) and only sticks to the top from `sm` up.
- Every page has one headline number: a large figure with a small label beneath it, with everything else secondary.

## Motion

- The curve path strokes in over 600ms (`stroke-dashoffset`).
- Numbers cross-fade over 200ms; there is no rolling counter.
- Hover and press are 160ms ease-out.
- While a transaction is pending, a 2px line travels inside the call to action; there is no spinner.
- On seal hover the outer ticks light and rotate 6 degrees clockwise.
- Nothing ambient loops forever: the LP Grant pass sheen crosses twice and its claim button pulses three times, then
  both stay still. Only in-flight states (a pending transaction, a loading placeholder) keep moving.
- The theme is applied before first paint by an inline script in `app/layout.tsx`; the theme menu offers System,
  Light and Dark and follows the system live while on System.
- `prefers-reduced-motion` is respected.

## Components (`src/components/`)

- `art/HashSeal` the disc seal, `art/CurveChart` the price curve, `art/DecayRing` the decay ring, and
  `art/Sparkle` the four-pointed star (`size`, `tone`, `twinkle`). The drawing algorithms are settled; adjust size
  and colour through props rather than changing them.
- `ui/Panel`, `ui/Stat` for the headline number, `ui/Kv` for key-value rows (identifiers in mono, everything else in
  the text face), `ui/ModuleBlocks`, `ui/Ticket` for grant positions, `ui/Pill`, `ui/Button` (primary / ghost /
  danger), `ui/Field` (sunken input with a focus ring; `mono` for identifiers, `numeric` for amounts),
  `ui/Segmented`, `ui/Notice` for risk disclosures (a tinted, outlined box), `ui/Icon` for the few line icons, and
  `ui/Subscripted` for small prices. The header carries the logo, circle-cropped at 28px, beside the wordmark.
- Status pills: CURVE_ACTIVE amber, GRADUATION_PENDING flare, GRADUATED verdigris. Grant campaigns: AWAITING_ROOT
  muted, ROOT_PROPOSED amber, ACTIVE verdigris, EXPIRED muted, CANCELLED rose.

## Pages

- **Home** - the tagline on the left, four live figures on the right (launches, graduated, active grants, 24h
  volume). Below, launch cards in three columns, one on mobile: seal, name and symbol, quote-asset pill, status
  pill, and either a small curve while bonding or the pool id once graduated.
- **Launch** - two columns. Left, the form grouped into basics, quote asset, template and an optional dev buy. The
  quote asset is a card selector built from the deployment's `quoteAssets` plus native OKB, showing symbol, decimals
  and category, with a disclosure on tokenised-equity cards. Templates are filtered by quote, and Perk Launch is
  marked Recommended with a summary of what LP Grant on or off means. Right, a sticky preview: the seal updating
  live with the form, then the predicted address, hook, module blocks, the fee rate and its split, and the config
  hash. Signing is enabled only while the preview hash still matches the chain.
- **Token** - header seal, name, status pill and the immutable facts. While bonding the main area is the curve with
  the order panel beside it; after graduation it is pool information and the swap panel. Below sit quote rewards,
  creator revenue, and where fees go.
- **Grant** - the decay ring as the headline number, with remaining allocation and countdown; a timeline from
  graduation through root proposal, activation and close, drawn with hairlines and dots; allocation split into base,
  boost and credit; the activation form; positions as ticket stubs; and risk disclosures itemised in a Notice.
- Empty and loading states use the seal's outline as a skeleton rather than flashing grey blocks.

## Copy

Keep each locale in its own language: English appears inside translated copy only for the wordmark, the tagline and
technical identifiers such as the config hash and the pool id. Units follow the number in muted small text. Avoid
exclamation marks.
