import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./emails/**/*.{ts,tsx}",
  ],
  darkMode: "class",
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      colors: {
        // CrewFlow brand placeholders — retained for back-compat during migration.
        brand: {
          DEFAULT: "#0F172A",
          accent: "#F59E0B",
        },
        // ── Unified CrewFlow marketing tokens (dark "Blueprint" system) ──
        // Channel vars live in app/_marketing/tokens.css (:root). Named so they
        // never clobber Tailwind's default slate/amber/emerald/red scales still
        // used by the legacy light sub-pages until they migrate.
        navy: {
          950: "rgb(var(--cf-navy-950) / <alpha-value>)",
          900: "rgb(var(--cf-navy-900) / <alpha-value>)",
          850: "rgb(var(--cf-navy-850) / <alpha-value>)",
          800: "rgb(var(--cf-navy-800) / <alpha-value>)",
          700: "rgb(var(--cf-navy-700) / <alpha-value>)",
        },
        gold: {
          100: "rgb(var(--cf-gold-100) / <alpha-value>)",
          500: "rgb(var(--cf-gold-500) / <alpha-value>)",
          600: "rgb(var(--cf-gold-600) / <alpha-value>)",
          DEFAULT: "rgb(var(--cf-gold-500) / <alpha-value>)",
        },
        blueprint: "rgb(var(--cf-blueprint) / <alpha-value>)",
        positive: "rgb(var(--cf-positive) / <alpha-value>)",
        danger: "rgb(var(--cf-danger) / <alpha-value>)",
        cfborder: "rgb(var(--cf-border) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--cf-text) / <alpha-value>)",
          mut: "rgb(var(--cf-text-mut) / <alpha-value>)",
          dim: "rgb(var(--cf-text-dim) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        body: ["var(--font-satoshi)", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        display: ["var(--font-clash)", "Georgia", "serif"],
      },
      boxShadow: {
        cf: "0 1px 0 rgba(255,255,255,.03) inset, 0 10px 30px rgba(0,0,0,.35)",
        "cf-gold": "0 8px 30px rgba(234,178,60,.18)",
      },
      borderRadius: {
        cf: "16px",
      },
      maxWidth: {
        cf: "1200px",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
