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
        // CrewFlow brand. Deep navy-charcoal base with an indigo signal accent —
        // the palette the HQ Command Centre and the whole design system share.
        brand: {
          DEFAULT: "#0F172A", // slate-900: serious, trustworthy
          accent: "#6366F1",  // indigo-500: the CrewFlow signal colour
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      // Luxury depth + soft accent glows — the premium feel the design system
      // leans on. Additive: nothing existing references these until it opts in.
      boxShadow: {
        glow: "0 10px 40px -12px rgba(99,102,241,0.45)",
        "glow-emerald": "0 10px 40px -12px rgba(16,185,129,0.40)",
        card: "0 1px 2px rgba(0,0,0,0.30), 0 12px 32px -16px rgba(0,0,0,0.65)",
        "card-hover": "0 1px 2px rgba(0,0,0,0.30), 0 20px 48px -18px rgba(0,0,0,0.75)",
      },
      keyframes: {
        // Sweeping highlight for premium skeleton loaders.
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        // Soft upward entrance for content that fades in.
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Self-drawing stroke for charts / sparklines.
        draw: {
          "0%": { strokeDashoffset: "var(--draw-length, 1000)" },
          "100%": { strokeDashoffset: "0" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s ease-in-out infinite",
        "fade-up": "fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both",
        draw: "draw 1.2s cubic-bezier(0.22,1,0.36,1) forwards",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
