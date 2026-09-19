# Perk visual system

In one line: **a verifiable credential**, wearing Perk's skin. The brand mark (`public/brand/perk-logo.jpeg`) is a
fluorescent lemon-green fox silhouette on deep ink green, with a four-pointed star, inside a circle cut open by a
"P". The interface grows out of it: bold rounded geometric silhouettes, one very bright accent, large areas of dark
space, and the star as the finishing touch.

## Concepts

- Silhouette meets instrument panel. Headings use a geometric sans with character (Bricolage Grotesque, wide,
  optical sizing), body text uses Instrument Sans, numbers use JetBrains Mono.
- Each launch's `HashSeal` is a **disc with a P-shaped notch**: lemon-green or ink-green face, a four-pointed star
  at the centre, the pattern held inside the disc, and outer-ring ticks encoding the module bits. The seal matches
  only when the preview's config hash matches the chain's.
- The star is the only ornament: status dots, success states, the Recommended marker, the loading shimmer.
- Modules are building blocks, grant positions are ticket stubs, and the curve is the protagonist.
- Shape language: buttons, pills and inputs are all `rounded-full`; panels use a 20px radius; seals are circular.
  Nothing has square corners.

## Colour

Tokens live in `globals.css`. The names are stable; only the values are brand-specific.

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| ink | #0F1D1D | #F3F6EE | Page background (deep ink green / moss white) |
| surface | #112323 | #FFFFFF | Panels |
| bone | #E9F2EA | #0F1D1D | Primary text (mist white / ink green) |
| muted | bone 56% | ink 56% | Secondary text |
| line | bone 10% | ink 12% | Hairlines |
| flare | #D6FD3E | #7FA800 | **Lemon-green accent**: calls to action, the current point, emphasised numbers, the star |
| verdigris | #7BE3B5 | #1F8F62 | Success, positive return |
| amber | #F2C14E | #B8801A | Warning, decay countdown |
| ember | #F7924A | #C65F26 | **Severity grading only** (indexer 1k-5k blocks behind); sits between amber and rose and is never a brand colour |
| rose | #FF6B8A | #C0395C | Danger, negative return, burning |

Rules: only ink-green text may sit on lemon green; at most one large lemon-green area per screen, either the call to
action or the headline number; the background carries a 3% monochrome grain (SVG `feTurbulence`) for texture; the
primary call to action has a 24px lemon-green glow at 10%, rising to 16% on hover. Backgrounds are never gradients.

## Type

- Display numbers and headings: Bricolage Grotesque 600, `font-variation-settings: "opsz" 96, "wdth" 100`, heading
  tracking -0.03em. Display numbers run 40 to 72px with `tabular-nums`, falling back to JetBrains Mono where a
  tabular variant is unavailable.
- The wordmark *Perk* is Bricolage Grotesque 700 with a star. The tagline "Choose the launch. Compose the market."
  sets its second sentence in flare rather than in italics.
- Body: Instrument Sans 400/500, 15px, line height 1.55. Chinese falls back to PingFang SC / Noto Sans SC, Japanese
  to Hiragino Sans / Noto Sans JP.
- Data: JetBrains Mono 400, 13px. Addresses and hashes are 12px with the middle elided.

## Layout

- Content is 1120px wide on a 12-column grid with 24px gutters; page margins are 24px, or 16px on mobile.
- Vertical rhythm is an 8px baseline; panel padding is 24px, section spacing 48px, and the gap from header to the
  first screen 64px.
- Hairlines replace shadows. Panels take a 1px line border, no shadow, and a 20px radius; the border lifts to bone
  24% on hover.
- Every page has one headline number: a large figure with a small label beneath it, with everything else secondary.

## Motion

- The curve path strokes in over 600ms (`stroke-dashoffset`).
- Numbers cross-fade over 200ms; there is no rolling counter.
- Hover and press are 160ms ease-out.
- While a transaction is pending, a 2px line travels inside the call to action; there is no spinner.
- On seal hover the outer ticks light and rotate 6 degrees clockwise.
- `prefers-reduced-motion` is respected.

## Components (`src/components/`)

- `art/HashSeal` the disc seal, `art/CurveChart` the price curve, `art/DecayRing` the decay ring, and
  `art/Sparkle` the four-pointed star (`size`, `tone`, `twinkle`). The drawing algorithms are settled; adjust size
  and colour through props rather than changing them.
- `ui/Panel`, `ui/Stat` for the headline number, `ui/Kv` for key-value rows, `ui/ModuleBlocks`, `ui/Ticket` for
  grant positions, `ui/Pill`, `ui/Button` (primary flare / ghost / danger), `ui/Field`, and `ui/Notice` for risk
  disclosures with an amber or rose left border. The header carries the logo, circle-cropped at 28px, beside the
  wordmark.
- Status pills: CURVE_ACTIVE amber, GRADUATION_PENDING flare, GRADUATED verdigris. Grant campaigns: AWAITING_ROOT
  muted, ROOT_PROPOSED amber, ACTIVE verdigris, EXPIRED and CANCELLED rose.

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
