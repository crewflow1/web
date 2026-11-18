import localFont from "next/font/local";

/**
 * Marketing-only display + body typefaces, self-hosted.
 *
 * Clash Display (display) + Satoshi (body) — the locked CrewFlow brand
 * pairing. Self-hosted via next/font/local so there is NO external font
 * request at runtime (no Fontshare dependency, no FOUT, no third-party
 * privacy leak) and zero layout shift.
 *
 * Licence: both families are under the Indian Type Foundry (ITF) Free Font
 * License, which allows commercial use and self-hosting on our own site but
 * forbids making the font files available through a public repository. The
 * files are therefore NOT in git: scripts/fonts/provision-marketing-fonts.mjs
 * (predev/prebuild) writes the six slots below into ./fonts/active/
 * (gitignored) from a private source, sha256-verified against
 * ./fonts/manifest.json. Builds without that source (CI, forks, local dev
 * without the kit) get the OFL fallback pair from ./fonts/fallback/
 * (Bricolage Grotesque + Figtree). Never commit a Clash/Satoshi file:
 * __tests__/security/restricted-font-binaries.test.ts fails if you do.
 * See docs/compliance/FONT-LICENCE-RESOLUTION.md.
 *
 * These export CSS variables (`--font-clash`, `--font-satoshi`) that are
 * applied to the marketing page root wrapper in app/page.tsx and consumed
 * by app/_marketing/marketing.css. They are NOT applied globally, so the
 * dashboard/auth/portal keep their existing Inter stack untouched.
 */

export const clashDisplay = localFont({
  src: [
    { path: "./fonts/active/display-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/active/display-600.woff2", weight: "600", style: "normal" },
    { path: "./fonts/active/display-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-clash",
  display: "swap",
  // Clash is a SANS display face, so the swap fallback must also be sans —
  // a serif fallback (e.g. Georgia) mismatches the metrics and shifts the
  // large hero H1 on swap. Arial-based metric adjustment keeps CLS at ~0.
  fallback: ["Arial", "Helvetica", "sans-serif"],
  adjustFontFallback: "Arial",
  preload: true,
});

export const satoshi = localFont({
  src: [
    { path: "./fonts/active/body-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/active/body-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/active/body-700.woff2", weight: "700", style: "normal" },
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
