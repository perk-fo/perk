import type { Config } from "tailwindcss";

const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      // Values live in globals.css per theme. Text has four solid tiers (bone, muted, subtle, faint) instead of
      // opacity steps, so its contrast is measured rather than whatever an alpha happens to give on a surface.
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
      },
      fontFamily: {
        display: ["var(--font-display)", "PingFang SC", "sans-serif"],
        sans: ["var(--font-sans)", "PingFang SC", "Noto Sans SC", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: { page: "1120px" },
      borderRadius: { panel: "18px" },
      transitionDuration: { fast: "160ms" },
    },
  },
  plugins: [],
};

export default config;
