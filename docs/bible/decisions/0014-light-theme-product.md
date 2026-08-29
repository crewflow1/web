# ADR 0014 — The tenant product is light-theme; dark chrome is HQ's

- **Status:** Accepted (records the product decision shipped in the
  product+HQ UX rebuild, PR #838; written down per the 2026-08-29 master
  reconciliation's documentation actions)
- **Date:** 2026-08-30

## Context

The UX rebuild (PR #838) standardised the tenant-facing product — dashboard,
jobs, money, settings, portals — on a single light visual language
(white/slate surfaces, slate-900 text), with **no theme provider and no dark
variant**. HQ's boardroom surfaces (`/admin/*-ai`) deliberately use dark
chrome as their own identity. Roadmap/UX notes that assumed an eventual
dark mode were left unresolved on paper.

## Decision

The tenant product ships **light-only**. There is no dark mode toggle, no
`prefers-color-scheme` variance, and no theme provider in the tenant app.
HQ boardroom pages keep their dark identity as a separate, HQ-only visual
system.

## Rationale

1. **Trade context.** CrewFlow is read on site, outdoors, on phones in
   daylight — where light surfaces with high-contrast dark text are the
   most legible option, and where a dark theme is at its worst.
2. **One theme = testable contrast.** WCAG contrast is pinned by tests
   against one palette; a second theme doubles the audit surface for zero
   customer demand (no design-partner request on record).
3. **No provider = no flash, no drift.** Omitting the theme provider
   removes hydration flash and the class of half-themed component bugs.

## Consequences

- Roadmap/UX atoms assuming a dark tenant theme are **G (superseded)** in
  the master reconciliation.
- New tenant surfaces build on the light tokens; new HQ boardroom surfaces
  may use the dark chrome. Neither imports the other's palette.
- Introducing a dark tenant theme later is a product decision that starts
  with a contrast-pinned second palette, not a CSS toggle.
