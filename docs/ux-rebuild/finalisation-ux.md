# Product UX finalisation — IA / Home / Money / object-workspaces / design-system

Three read-only audits (owner-vs-staff Home & roles; Money terminology & IA; area
landings, object workspaces, design-system consistency) mapped Phases 4–9. The
headline: **the prior wave's regrouping did the heavy lifting** — 5 of 8 area
landings are already GOOD, all four object workspaces (customer/supplier/staff/
asset) are coherent, and the design system's feared decorative excess (gradients/
glass/neon/card-soup) is essentially ABSENT. So the correct response to "few,
high-impact, no churn" is a small set of clear fixes plus an honest backlog — not
a sweep.

## Shipped in this pass

### Staff navigation exposure (the CEO's exact concern — R1)
Area headers linked to a fixed `area.href`, so a **staff** member clicking "Site &
safety" landed on `/health-safety` (the admin RAMS register) and "People" on
`/staff` (the roster incl. pay) — routes their own sidebar deliberately hides.
Fix: a new `areaLandingHref(area)` (`app/(app)/_nav/nav-model.ts`) resolves the
first **role-visible** child; owner landing is unchanged (first child == area.href
for every area), staff now land on Toolbox talks / Leave. Applied to the desktop
sidebar header, the mobile drawer "overview" link, and the mobile quick-bar
(hardcoded `/health-safety` → `/toolbox`).

### Money terminology (Phase 7)
The CEO's two hypotheses were both risky as literally stated, so — with the
delegated latitude — the safe, accurate alternatives were chosen:
- **Finances → "Costs"** (NOT "Ledger": `/finances` is a cost/spend log — categories
  are all cost types, no journals/income/GL — so "Ledger" would over-promise
  bookkeeping). Fixes the "Finances = the whole area / = a ledger" ambiguity.
- **Expenses → "Receipts"** (it's the receipt-capture/approval inbox). Together they
  read as one legible pipeline: **Receipts → (approve) → Costs**, the app's biggest
  confusable pair.
- **Payments** left as-is (renaming to "Bank reconciliation" would name only half —
  it also records customer receipts).
- **One name per route:** the aged-debtors page called `/cash` "Get paid"; it now
  says "Cash position" (its canonical name).
Touch points were label-only (nav-model, i18n catalog, the two page `<h1>`s + the
`/finances` subtitle, the activity-log filter labels, the i18n snapshot test); the
old terms are retained as **search keywords** so `⌘K` for "expenses"/"finances"
still finds them. No calculation, RLS, route, or domain logic changed.

## Prioritised backlog (audit-found, deliberately deferred — not churn-shipped live)

Ranked; each is a real improvement but either opinion-sensitive or larger than a
"few, high-impact" fix, so it should land with review rather than be swept in now.

1. **People `/staff` → an area hub.** Today it's the thinnest landing: a bare member
   directory with Rota/Leave/Payroll demoted to tiny subheader text. Add a "needs
   you" strip (leave awaiting approval · rota conflicts · payroll due) and promote
   the sibling routes (all already exist: `/staff/rota/conflicts`, `/staff/leave`,
   `/payroll`). *Moderate — new data composition.*
2. **Site & safety `/health-safety` → a light area index.** The landing is only the
   RAMS register; 10 of 13 site registers (diary, snags, toolbox, permits, quality…)
   are sidebar-only — the exact "grouping didn't fix arrival" case.
3. **Home `/dashboard` de-noise.** The DailyBriefing already carries "what needs me";
   collapse the ~8 stacked KPI rows to one reference band and remove the literal
   duplication ("Outstanding" vs "Total outstanding"). *Money-page — do with care.*
   Consolidate the owner attention stack (DailyBriefing + RetentionPanel +
   InsightsSection are three overlapping panels) onto the briefing.
4. **Staff workspace "Jobs assigned" list.** `getStaffPerformance` already fetches the
   job rows then discards them; surface a compact list (needs a few extra columns —
   title/customer — so not quite pure-reuse).
5. **Design-system drift (guardrail, not a sweep).** Real but low-severity: ~542 raw
   `<button>` vs `Button` (start with the ~22 exact re-types), hand-rolled status
   pills vs `Badge`, and **0/184 `PageHeader` + breadcrumbs on only 16/184** (adopt
   on the 8 area landings + object `[id]` routes for wayfinding — the Phase-4 point).
   The CEO's explicit "don't mechanically rewrite 184 pages" governs: targeted, not
   bulk.
6. **Defence-in-depth page gates (R2).** `/health-safety` and `/staff` still render
   admin content on a direct URL (RLS is the backstop); R1 removed the nav path, a
   staff redirect would match the nav's admin-only intent.
7. **Deeper Money reconciliation.** The job-level Billing-vs-Commercial "Outstanding"
   duplication and the money-OUT/AP side living under Operations (not Money) — both
   are structural, beyond a label fix.
