import localFont from "next/font/local";

/**
 * Marketing-only display + body typefaces, self-hosted.
 *
 * Clash Display (display) + Satoshi (body) — the locked CrewFlow brand
 * pairing. Self-hosted via next/font/local so there is NO external font
 * request at runtime (no Fontshare dependency, no FOUT, no third-party
 * privacy leak) and zero layout shift.
 *
 * Licence: both families are free for commercial use under the Indian
 * Type Foundry (ITF) Free Font Licence, which permits web embedding and
 * self-hosting. Files live in ./fonts/.
 *
 * These export CSS variables (`--font-clash`, `--font-satoshi`) that are
 * applied to the marketing page root wrapper in app/page.tsx and consumed
 * by app/_marketing/marketing.css. They are NOT applied globally, so the
 * dashboard/auth/portal keep their existing Inter stack untouched.
 */

export const clashDisplay = localFont({
  src: [
    { path: "./fonts/ClashDisplay-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ClashDisplay-Semibold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ClashDisplay-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-clash",
  display: "swap",
  fallback: ["Georgia", "serif"],
  preload: true,
});

export const satoshi = localFont({
  src: [
    { path: "./fonts/Satoshi-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Satoshi-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Satoshi-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-satoshi",
  display: "swap",
  fallback: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Roboto",
    "sans-serif",
  ],
  // Body face: swap on a strong system fallback rather than preloading all
  // weights — keeps the LCP (display-face heading) critical chain lean without
  // any visible FOUT on the body copy.
  preload: false,
});
