import type { Config } from "tailwindcss";

const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      // Values live in globals.css per theme. Text has four solid tiers (bone, muted, subtle, faint) instead of
      // opacity steps, so its contrast is measured rather than whatever an alpha happens to give on a surface.
      // `ink` is the page and `bone` the text in both themes (the names predate the light default).
      colors: {
        ink: rgb("--c-ink"),
        surface: rgb("--c-surface"),
        raised: rgb("--c-raised"),
        line: rgb("--c-line"),
        "line-strong": rgb("--c-line-strong"),
        knob: rgb("--c-knob"),
        bone: rgb("--c-bone"),
        muted: rgb("--c-muted"),
        subtle: rgb("--c-subtle"),
        faint: rgb("--c-faint"),
        flare: rgb("--c-flare"),
        cta: rgb("--c-cta"),
        "on-cta": rgb("--c-on-cta"),
        "on-flare": rgb("--on-flare"),
        verdigris: rgb("--c-verdigris"),
        amber: rgb("--c-amber"),
        ember: rgb("--c-ember"),
        rose: rgb("--c-rose"),
        // the mark's own colours, the same in both themes: fills and decoration, never small text on the page
        yolk: rgb("--brand-yellow"),
        honey: rgb("--brand-amber"),
        tangerine: rgb("--brand-orange"),
        shell: rgb("--brand-gray"),
        charcoal: rgb("--brand-charcoal"),
        cream: rgb("--brand-cream"),
      },
      fontFamily: {
        display: ["var(--font-sans)", "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "sans-serif"],
        sans: ["var(--font-sans)", "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: { page: "1200px" },
      borderRadius: { panel: "20px", control: "12px" },
      boxShadow: {
        card: "var(--shadow-card)",
        lift: "var(--shadow-lift)",
        pop: "var(--shadow-pop)",
      },
      transitionDuration: { fast: "160ms" },
      transitionTimingFunction: { spring: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    },
  },
  plugins: [],
};

export default config;
