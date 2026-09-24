# Perk visual system

In one line: **a warm, playful market for verifiable launches**. The client's mark, a hatching chick (yolk-yellow
head, honey wings, tangerine beak, a grey shell with a zigzag crack), sets the tone: a warm off-white page, heavy
friendly headings, yellow for the one thing to do on each screen, and small monospace labels that read like a
printed catalogue. The chick moves: it blinks, breathes, hops when hovered, follows the pointer in the hero and
hatches on a loop while something loads. The client's prototype (kept out of the repository) is the reference for
the home page; every other page follows the same system.

## Concepts

- Each launch is a **market credential**. The home page's credential card is a concept piece; each real launch has
  its `HashSeal`, a stamp generated from its configHash, which matches only when the preview's hash matches the
  chain's.
- The chick is the brand's voice. It appears in the lockup, loading states, empty states, transaction toasts and the
  not-found page, and nowhere as decoration for its own sake.
- The eight-spoke asterisk (`art/Sparkle`) is the only ornament: section kicker, the corner of the hero scene, the
  heart of every seal.
- Shape language: buttons and inputs are 12px rounded rectangles, cards 20px, badges fully round, seals zigzag
  stamps. Stacked, slightly rotated cards are the signature composition.

## Colour

Tokens live in `globals.css` as RGB triplets, one set per theme; `tailwind.config.ts` exposes them as colours. Light
is the default for a first visit (the brand was designed in it); the theme menu offers Light, Dark and System, and
the choice is stored in `perk-theme` and applied before first paint by the script in `app/layout.tsx`. The palette
variants of the previous design (Graphite, Moss, Stone) were retired with it.

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| ink | #F8F7F2 | #181916 | Page background |
| surface | #FFFEFA | #22231F | Cards |
| raised | #F0EFE8 | #2B2D26 | Inputs, hover, tracks, soft fills |
| line / line-strong | #DEDED4 / #C7C6BA | #3B3D33 / #56584C | Borders / control outlines |
| bone | #1C1C1C (15.9:1) | #F3F2E8 (15.7:1) | Primary text |
| muted | #55554C (7.0:1) | #CBCCBF (10.9:1) | Secondary text |
| subtle | #686860 (5.2:1) | #AEB0A2 (8.0:1) | Labels and meta: the lowest tier anyone has to read |
| faint | #A1A194 | #76786B | Placeholders, disabled, decoration only |
| flare | #A64B00 (5.4:1) | #FCD53F (12.4:1) | Accent text and indicators: links, selection, focus |
| cta / on-cta | #FCD53F / #1C1C1C | #FCD53F / #1C1C1C | Primary action: charcoal on yolk (12:1) in both themes |
| verdigris | #177245 | #5ED69A | Up, success |
| amber | #935A00 | #F9C23C | Warning, countdowns |
| ember | #B8430A | #FF9A52 | Severity grading only (indexer lag) |
| rose | #C0342B | #FF7D73 | Down, danger, cancellation |

Brand colours, the same in both themes, for fills and art only: `yolk` #FCD53F, `honey` #F9C23C, `tangerine`
#FF822D, `shell` #D3D3D3, `charcoal` #1C1C1C (plus `cream` for tinted surfaces).

Rules:

- Text colour is one of the four solid tiers or a status colour; never text with an alpha.
- Tangerine is 2.3:1 on the light page, so it is never small text there: accent text uses `flare`.
- Yellow fills carry charcoal text. White text on yellow is never used.
- Market direction has its own colours: up is `verdigris`, down is `rose`. Yellow means "act".
- Progress runs as a yolk-to-tangerine gradient; the fee split uses the brand colours per recipient.
- The strong secondary action (the wallet button) is `.btn-dark`: charcoal in light, cream in dark.

## Type

- One family, **Figtree**, for headings (800, tracking -0.03em; -0.01em for Chinese and Japanese) and text (400/500,
  15px, line height 1.6). Chinese falls back to PingFang SC / Noto Sans CJK SC, Japanese to Hiragino Sans / Noto Sans
  CJK JP.
- The wordmark is "Perk." at weight 850 with a tangerine full stop, always next to the chick (`brand/PerkBrand`).
- Eyebrows and indices (`.eyebrow`, `.label-en`) are JetBrains Mono, 10-11px, uppercase, wide tracking.
- Figures (`.num`) use tabular digits; identifiers (`.mono`: addresses, hashes, module ids) JetBrains Mono.
- Small prices keep the zero count as a real subscript (`ui/Subscripted`).
- Minimum sizes: 12px for anything a person reads, 13px for labels, 10px only for monospace eyebrows.

## Layout

- Content is 1200px wide; page margins 32px, 16px on mobile. No page may scroll sideways at 360px.
- Every page opens with `ui/PageHeader`: eyebrow, a 36-48px heading, an optional description and a right slot.
  Sections inside use `ui/SectionHeading`.
- The header is one row from `lg` up (lockup, navigation with a highlighter under the current section, network dot,
  sync pill, language, theme, wallet) and two rows on a phone, where only `sm` and up keep it sticky. On a phone the
  sync pill shrinks to its dot.

## Motion

Everything here stops under `prefers-reduced-motion`.

- The chick (`brand/PerkChick`, modes in `globals.css` `.chick-*`): `idle` blinks every few seconds, breathes and
  sways its tuft, and hops with two wing flaps when it (or a `.chick-host` around it) is hovered; `follow` also
  points its eyes at the pointer; `loading` wobbles the egg while the chick rises out of it and flaps; `static`
  does nothing (favicons, tiny sizes).
- The hero credential card leans toward the pointer (up to 12 degrees), its backing cards fan out while it is
  hovered, the orbit rings turn slowly, the plus signs float, and the corner asterisk spins.
- Linked cards lift 4px with a longer shadow and a honey border on a springy curve; their icons wiggle, arrows
  (`.nudge`) slide up and right, launch-card seals tilt.
- Buttons rise 2px on hover and press to 97%; the primary one gains a tangerine glow.
- Entrances fade up (staggered in grids) with `animation-fill-mode: backwards`, so a finished entrance never pins
  `transform` and blocks hover motion.
- The CountUp figures, the choice-card check (pops in), the seal preview on /launch (re-stamped when the hash
  changes) and live-status dots (a soft pulse) complete the set. Nothing else loops forever.

## Components (`src/components/`)

- `brand/PerkChick` the mark on a 64-unit grid, `brand/PerkBrand` the lockup, `brand/PerkLoader` the loading state.
  The favicon (`app/icon.svg`, `public/brand/perk-chick.svg`) is the static chick; `app/apple-icon.png` is rendered
  from it.
- `art/HashSeal` the credential stamp: a zigzag-rimmed plate in one of six brand colour schemes, three-fold bars and
  dots, an outer dot ring and the asterisk heart, all derived from the hash, with the module bits as rim ticks.
  Without a hash it draws its outline (loading placeholder).
- `art/Sparkle` the asterisk (`spin` for the slow turn), `art/CurveChart`, `art/PriceChart`, `art/DecayRing`.
- `ui/Panel` (bold title, right slot), `ui/PageHeader` and `ui/SectionHeading`, `ui/Stat`, `ui/Kv`,
  `ui/ModuleBlocks`, `ui/Ticket`, `ui/Pill` (tinted badges; `yolk` for "graduation pending"), `ui/Button` (primary /
  ghost / danger), `ui/Field`, `ui/Segmented`, `ui/Notice`, `ui/EmptyState`, `ui/FeeSplitBar`, `ui/Icon`,
  `ui/Subscripted`.
- `LaunchCard` the gallery card (token image or seal, price, status, curve with a progress bar, or the pool),
  `meme/TokenAvatar` the token image with its seal as a corner badge, `market/MarketTable` the market list.
- `PauseBanner` and `InviteBar`: yolk-tinted bars under the header. Buttons for a paused action say so and are
  disabled (`lib/pause`); exits never need this, because the contracts cannot pause them.
- Header menus (theme, language, account) are transient: a press anywhere outside, Escape, or moving keyboard focus
  away closes them (`lib/use-dismiss`). The theme menu stays open while choosing; the others close on a choice.
- `TxToasts`: the chick hatches while a transaction is in flight; a check pops in when it lands.
- `NotFoundView`: the site's not-found page, also shown for admin pages to anyone without the role.
- `meme/RefundPanel`: replaces the order panel on a REFUNDING launch; approve, then redeem the whole balance for its
  pro-rata share of the launch's quote.
- The fee split's 15% share is liquidity in general (the pool seed on the curve, then the pool's LP fee to every
  position); it is labelled "Liquidity", never "LP Grant".

## Pages

- **Home** - the client's prototype, wired to live data. Left, the kicker, the two-line slogan (second line muted),
  the description, "Start trading" (yolk) and "Launch" (outlined), and a one-line note. Right, the credential scene:
  a sample credential card (marked "Sample"; it never shows invented launch data) with the chick at its centre,
  orbit rings and floating plus signs, on a yolk and a tangerine backing card over graph paper. Then four live
  figures that count up when they scroll into view ("—" until they arrive, never a made-up 0), three pathway cards
  (01 Discover, 02 Participate, 03 Create, the last on a sun-tinted card), a Featured row when General Admins have
  picked launches, and the most traded launches as cards in three columns, one on mobile.
- **Launch** - two columns. Left, the form grouped into basics, quote asset, template and an optional dev buy. The
  quote asset is a card selector built from the API's quote assets (falling back to the deployment's `quoteAssets`
  plus native OKB while the API is unreachable): the ones allowed on-chain, with active templates, and offered by the
  admins, showing display name or symbol, decimals, category and icon, with the admins' risk notice in the reader's
  language (tokenised stocks get the standard one when none is written). Templates are filtered by quote, and Perk Launch is
  marked Recommended with a summary of what LP Grant on or off means. Right, a sticky preview: the seal updating
  live with the form, then the predicted address, hook, module blocks, the fee rate and its split, and the config
  hash. Signing is enabled only while the preview hash still matches the chain.
- **Token** - header seal, name, status pill and the immutable facts. When the token's metadata has an image it takes
  the seal's place at 72px with the seal as a small badge on its corner (`meme/TokenAvatar`, back to the seal alone if
  the image fails to load); the description (three lines) and link
  pills sit under the pills. A launch the admins hid shows a notice saying it is still on-chain and can be sold. While bonding the main area is the curve with
  the order panel beside it; after graduation it is pool information and the swap panel. Below sit quote rewards,
  creator revenue, and where fees go.
- **Grant** - the decay ring as the headline number, with remaining allocation and countdown; a timeline from
  graduation through root proposal, activation and close, drawn with hairlines and dots; allocation split into base,
  boost and credit; the activation form; positions as ticket stubs; and risk disclosures itemised in a Notice.
- Page-level loading shows the hatching chick (`brand/PerkLoader`); list placeholders use the seal's outline and soft
  bars; empty states show the idling chick on a dashed well (`ui/EmptyState`); the not-found page makes the chick
  the zero of "404".

- **Admin** (`/admin`) - only for wallets holding an admin role (`lib/admin`: the Core Admin and Grant Admin read
  from the chain, General Admins from the API); everyone else, including a visitor with no wallet connected, gets
  the not-found page and no navigation entry. A pill row links the sections the wallet's roles open, and each
  section is itself not found for other roles:
  - Protocol (Core Admin): the emergency pause, stuck graduations (propose, cancel or execute a rescue), refunds.
  - Roles (Core Admin): who holds each role, appointing or revoking the Grant Admin, adding or removing General
    Admins, and the log of off-chain admin changes.
  - Quote assets (Core Admin, General Admins): each asset's on-chain state and display settings (name, icon,
    category, risk notice per language, order, offered or not); the Core Admin can also stop or allow new launches
    and list a new asset, a checklist of transactions that resumes where it stopped.
  - LP Grant (Grant Admin, Core Admin): lists under review with their dataset check (cancel, or activate once due)
    and graduated launches still waiting for a list.
  - Moderation and Featured (General Admins, Core Admin): search, hide a launch or only its media, and order the
    home page's featured row.
  Off-chain sections ask for a wallet signature first (EIP-4361, no gas); the session lives in sessionStorage.

## Copy

Keep each locale in its own language: English appears inside translated copy only for the wordmark, the tagline,
technical identifiers such as the config hash and the pool id, and the small monospace eyebrows ("01 / DISCOVER",
"ON THE MARKET"), which the client's design keeps in English as typography in every locale. They still live in the
message files, so a locale can translate them. Units follow the number in muted small text. Avoid exclamation marks.
