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
        // CrewFlow brand placeholders — tweak when brand colours are locked.
        brand: {
          DEFAULT: "#0F172A", // slate-900: serious, trustworthy
          accent: "#F59E0B",  // amber-500: hi-vis, construction-coded
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [animate],
} satisfies Config;
