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

### Money — the one unambiguous fix (kept)
**One name per route:** the aged-debtors page linked to `/cash` calling it "Get
paid" while the page's canonical name is "Cash position"; the link now says "Cash
position". Reviewer-confirmed to read correctly. Label-only.

### Money terminology rename (Phase 7) — HELD for CEO decision, not shipped
The audit proposed **Finances → "Costs"** and **Expenses → "Receipts"** (the CEO's
own examples, Finances→Ledger / Payments→Bank-rec, were shown to be inaccurate).
I implemented it, then the adversarial UX reviewer found two decisive problems, so
I **reverted it** rather than ship a contested, user-facing relabel live without
CEO sight:
1. **It was only half-applied.** ~13 hardcoded surfaces still said "Finances" /
   "Expenses" (the approve-a-receipt flow "post to Finances", breadcrumbs, the
   dashboard activity-log filter via `lib/activity/render.ts`, tax/company-health
   drill-throughs, `/finances/new`). A half-rename is worse than none.
2. **"Receipts" is actively wrong.** In bookkeeping "receipts" = money *received*;
   sitting beside Invoices + Payments it reads as money-IN, but `/expenses` is the
   money-OUT capture inbox. It also collides with goods-receipts/GRN (Operations →
   Purchase orders) and billing receipts (settings/billing). "Costs" is defensible
   ("the safer half" per the reviewer) but collides with job-costing "Costs" and
   still needs the full ~13-surface sweep.

**Recommendation for the CEO** (a clean, reviewed decision to approve, not a live
surprise): rename **Finances → "Costs"** ONLY, applied to ALL ~13 surfaces at once
(nav, catalog, every `/finances*` `<h1>`/breadcrumb/button, the approve-flow copy,
`lib/activity/render.ts`, the tax + company-health drill-throughs); keep
**Expenses** as-is (do NOT adopt "Receipts"); accept the minor job-costing "Costs"
overlap. This is a byte-identical-guarded nav change (`__tests__/i18n/i18n-wiring`),
so it should land as its own reviewed slice. Full surface list in the review notes.

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

## Pre-existing items surfaced by the adversarial security review (NOT caused by this branch)

Flagged for a SEPARATE security audit / product decision — this branch neither
introduced nor weakened them, and they do not gate this deploy:

- **Staff can read co-workers' `hourly_pay` by direct URL.** The RLS policy
  "members can read profiles of co-workers" (migration 20260515170000) grants
  row-level SELECT on `public.users`, and `/staff` selects `hourly_pay` on the
  user-JWT client. The R1 nav change removes the UI path for staff, but the real
  fix is column-level / a `hourly_pay`-excluding view. **Recommend a dedicated
  audit** — this is a genuine pre-existing data exposure.
- **Job workspace shows Commercial / Valuations / Billing tabs + contextual Cmd+K
  commands to the staff role.** Consistent with the pre-existing design (any org
  member can VIEW job figures; role gates only WRITE actions — budget edit, submit,
  certify). Only Valuations is net-new (de-orphaned). For IA consistency with
  "staff avoid Money," optionally role-gate these tabs/commands to owner/admin; the
  deeper question — should staff see job commercial *figures* at all — is a
  pre-existing product decision needing a server-side display gate, out of scope
  for a UX/perf pass.

## Adversarial review outcome (Phase 15)
- **Performance:** no blocker/major — auth consolidation behavior-preserving,
  dashboard wave-merge byte-identical output, no orphaned rejections. One MINOR
  (an over-claiming Suspense comment) fixed.
- **Security/domain:** SAFE TO DEPLOY — no RLS/permission/audit/financial weakening,
  no dark activation, no migration; the membership-role guard was strengthened.
- **UX/IA:** the Money rename was half-applied and "Receipts" was conceptually wrong
  → the rename was **reverted/held** for a CEO decision; the role-correct nav landing
  and the `/cash` drift fix were confirmed sound and kept.
