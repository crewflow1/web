# Customer Experience Acceleration — milestone

> Perception-first polish toward a Linear/Stripe-grade feel. Additive, presentational, low-risk,
> reusing existing primitives (`EmptyState`, `Field`, `Button`, `ConfirmForm`). Discovery: **seven
> parallel audits** (onboarding, dashboard, empty-states, toasts/loading, journey, forms, mobile,
> nav/consistency/trust) — full findings in `scratchpad/polish-*.md` + `scratchpad/cx-*.md`.

## Shipped this pass

1. **Empty states standardised** — bespoke `<p>No X yet</p>` on **payroll** and **imports** → the shared
   `EmptyState` (icon + friendly copy). **Inbox** empty state gained "Add an enquiry" + "Set up AI
   receptionist" CTAs. (Customer-detail card CTAs shipped in the prior pass, #365.)
2. **Quote-builder no longer loses work** — "+ Add customer" opens in a new tab (`target="_blank"`), so
   a half-built quote's line items survive (`quotes/_builder.tsx`).
3. **Contextual success copy** — bare "Saved." → "Customer/Supplier/Job/Lead updated." on the edit
   actions.
4. **Autofocus on create forms** — `Field` gained an `autoFocus` passthrough; set on the customer
   form's first field so a user can type immediately (fewer clicks). Extends trivially to the other
   create forms (backlog).

Cumulative with #364 (first impression: guided onboarding + sample data + comms readiness) and #365
(completion-screen copy, detail-route loading skeletons, invoice status labels, customer-card CTAs).

## Ranked fast-follow backlog (impact ÷ effort; ready to build)

**HIGH**
- **Standardise on the `Button` primitive** — `components/ui/button.tsx` exists but only ~3 of ~113
  files use it; the rest hand-roll `bg-slate-900`. Roll out `<Button>`/variants → one design language.
- **Detail-page breadcrumbs** — customers/quotes/invoices/jobs/leads/suppliers `[id]` are dead-ends
  (no back link); add "← Jobs" etc. above each `<h1>`.
- **Sole-owner quote send** — collapse Request-approval → Approve → Mark-sent into one "Approve & send"
  for `isSoleApprover` (`quotes/[id]`).
- **Autofocus** on the remaining create forms (leads/suppliers/jobs/quotes) — same one-line pattern.

**MED**
- **Mobile nav "More" sheet** — `BottomNav` reaches only 5 of 22 destinations; add a "More" tab (pattern
  at `app/admin/_nav-mobile.tsx`). Quote-builder line-item table → stacked cards on mobile; bump touch
  targets to ≥44px.
- **Dashboard receivables hero** — de-dupe the triple "Outstanding" tiles into one hero + "Chase
  overdue"; drop nav-labels-as-KPIs.
- **Sidebar grouping + icons** (Work/Money/Team/Grow/System, lucide icons); **account dropdown** in the
  header; **visible ⌘K chip** on the Search pill (the palette exists, hidden).
- **Confirm dialogs** on destructive financial/legal actions (remove-payment, compliance/payroll
  delete) via `ConfirmForm`. Friendly validation copy (Zod messages, UK-postcode); replace raw
  `Request failed (503)` on invoice/finance forms.
- **`components/ui/card.tsx`** to end card radius/padding drift; a `success` Button variant to unify the
  two greens.

**LOW / cleanup**
- Landing page: an outcome-led headline + one social-proof band; theme the demo modal to match.
- Remove the now-dead dashboard `FirstRun`; adopt `FormShell` on the ~5 forms that re-implement it;
  merge the two same-named `Field` components.

## Testing
Presentational — no new business logic. `tsc` clean · eslint clean · security 108/3212 (no regression);
CI production build + e2e render the changed pages. No test added where it would gold-plate a copy/prop
change.
