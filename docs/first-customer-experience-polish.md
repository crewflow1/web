# First Customer Experience — polish milestone

> Goal: CrewFlow *feels* premium in the first five minutes — Linear-grade: fast, intentional,
> consistent. Perception, not architecture. All changes are additive, presentational, low-risk, and
> reuse existing primitives (`EmptyState`, `Skeleton`, `SummaryCard`, `FormShell`/`ConfirmForm`).

Discovery: four parallel audits (onboarding · dashboard+empty-states · toasts+loading · end-to-end
journey), full findings in `scratchpad/polish-*.md`. Below is the ranked backlog (customer-impact ÷
effort) with what shipped in this milestone.

## Shipped this milestone

1. **Onboarding completion screen — raw route slugs → human labels** (`app/(app)/onboarding/setup/complete/page.tsx`).
   The biggest premium-breaker, at the emotional peak of finishing setup: link text read
   `/onboarding/setup`, `/settings`, `/invoices`, `/staff`, `/imports`. Now "setup guide", "Settings",
   "Invoices", "Team", "Import" — hrefs unchanged, copy warmed.
2. **Instant detail-page loading** — added a consistent `SkeletonDetail` variant to
   `components/ui/skeleton.tsx` and `loading.tsx` to the four detail routes a new user hits
   (`customers/[id]`, `quotes/[id]`, `invoices/[id]`, `jobs/[id]`). Previously **0/12 detail routes had
   a loading state**, so a drill-down froze on the old page — the single biggest perceived-perf gap.
3. **No raw enums shown to users** — the invoice status buttons rendered `awaiting_payment` /
   `partially_paid`; now humanised (`app/(app)/invoices/[id]/_controls.tsx`).
4. **Empty cards become a next step** — the sample customer's detail cards (every new user clicks in)
   showed "No quotes yet." / "No jobs yet." dead-ends; `SummaryCard` now takes an optional `emptyCta`,
   and the Quotes/Jobs cards deep-link "Create a quote" / "Add a job" to the customer
   (`app/(app)/customers/[id]/page.tsx`).
5. **Copy polish** — postcode help jargon → "So we can match you to leads and jobs near you."
   (`onboarding/company/page.tsx`); "Add logo URL" → "Upload logo" (`lib/onboarding/checklist.ts`);
   the prospect-facing demo modal no longer shows `Server returned 500` (`_book-demo-modal.tsx`).

## Ranked fast-follow backlog (next polish pass)

- **HIGH:** collapse the sole-owner quote send (Request-approval → Approve → Mark-sent → one "Approve &
  send", `quotes/[id]/page.tsx`/`quotes/actions.ts`); quote-builder "+ Add customer" loses typed line
  items (`quotes/_builder.tsx:188` → open in new tab / inline add).
- **MED:** dashboard hierarchy — de-dupe the triple "Outstanding" tiles into one receivables hero +
  "Chase overdue"; drop nav-labels-as-KPIs (`dashboard/page.tsx`). Empty-state standardisation for the
  remaining bespoke `<p>No X yet</p>` pages (inbox/payments/payroll/imports/reports) → the existing
  `EmptyState` + CTA. Confirm dialogs on destructive financial/legal actions (remove-payment,
  compliance/payroll delete) via the existing `ConfirmForm`. Contextual success copy
  ("Saved." → "…updated."). `useOptimistic` on notification toggles.
- **LOW/cleanup:** remove the now-dead dashboard `FirstRun` (bypassed by P1's sample data + reroute);
  unify onboarding join-form fields with the company form.

## Testing
Presentational changes — no new business logic. Validated by: `tsc` clean · eslint clean · security
suite 108/3212 (no regression) · and in CI the production build (compiles the new `loading.tsx` route
segments + the `SkeletonDetail`) + e2e (renders the pages). No unit test added where it would be
gold-plating a one-line label transform.
