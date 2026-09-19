import type { Config } from "tailwindcss";

const rgb = (v: string) => `rgb(var(${v}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        ink: rgb("--c-ink"),
        surface: rgb("--c-surface"),
        bone: rgb("--c-bone"),
        flare: rgb("--c-flare"),
        verdigris: rgb("--c-verdigris"),
        amber: rgb("--c-amber"),
        ember: rgb("--c-ember"),
        rose: rgb("--c-rose"),
      },
      fontFamily: {
        display: ["var(--font-display)", "Songti SC", "serif"],
        sans: ["var(--font-sans)", "PingFang SC", "Noto Sans SC", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      maxWidth: { page: "1120px" },
      borderRadius: { panel: "20px" },
      transitionDuration: { fast: "160ms" },
      // hairlines: /6 and /8 are used for dividers; not in the default opacity scale, so without these the classes
      // were never generated and borders fell back to preflight's light gray
      opacity: { 6: "0.06", 8: "0.08" },
    },
  },
  plugins: [],
};

export default config;
