# H2-CASH M2 — Cash visibility + customer payment surfaces + briefing

**Status:** built on `feat/h2-cash-m2-cash-visibility` (cumulative: main + #425 Daily
Briefing + #426 M1 Billing Plans + M2). Unmerged, undeployed. **Zero migrations** —
pure read/aggregation + UI. No provider, bucket, cron or env introduced.

## What it delivers

When an owner opens CrewFlow they can answer, in one place (**`/cash` — "Get paid"**):
how much am I owed, how much is overdue, what's due this week, what's expected this
month, what's ready to invoice, what retention am I holding — and drill straight from
each number into the invoice/job. The customer sees a matching, safe **Paid / Due now /
Overdue** summary on their portal. The Daily Briefing gains a **ready-to-invoice** signal.

## One source of truth — nothing forked

Every £ traces to the existing authorities; M2 adds **no new outstanding formula**:

| Figure | Source |
|---|---|
| owedNow / overdue / due-this-week / due-this-month | per-invoice `remaining = total − Σ payments` + `isInvoiceOverdue` (the overdue authority) |
| retentionHeld / retentionDueNow | `computeRetentionDueRollup` |
| readyToInvoice | Σ planned (un-invoiced) stages of active billing plans (M1) |
| collectableNow | `owedNow − retentionHeld` (retention never chased as debt) |
| recentlyPaid | `invoice_payments` ledger (not inferred from invoice status) |

`lib/commercial/org-cash.ts` (PURE) composes these; `server/services/org-cash.ts` does the
RLS-scoped, paged, best-effort reads. `lib/customers/portal-payments.ts` (PURE) derives the
customer summary from **their own invoices only**.

## Definitions

- **owedNow** — Σ per-invoice remaining across collectable invoices (sent / awaiting_payment
  / partially_paid / overdue). Never a stored value; never an invoice's full total when part-paid.
- **overdue** — the remaining on invoices past their due date (via `isInvoiceOverdue`). A
  £10,000 invoice with £6,000 paid contributes **£4,000**, not £10,000. **Retention held is
  excluded** — it's shown separately and never counted as overdue debt.
- **dueThisWeek / dueThisMonth** — remaining on **invoiced & dated** invoices due within the
  window (not overdue). These are *invoiced/contractually due*, not a forecast.
- **readyToInvoice** — planned billing-stage net that hasn't generated an invoice. "Ready" =
  an operator-created stage not yet billed (explicit intent, never inferred from a date alone).
- **collectableNow** — `owedNow − retentionHeld` (floored at 0): the true chase-now figure.

## Daily Briefing integration (real, not copied)

M2 is a **cumulative branch** including #425, so the wiring is genuine + tested: a
`billing_ready` money signal was added to `lib/briefing/compose.ts` (BRIEFING_ITEM_KEYS +
the item) and fed by `server/services/briefing.ts` (a light read of planned stages of active
plans) → "£X ready to invoice across N jobs" linking to `/cash`. Ranked with the existing
overdue / retention-due money signals. Deterministic; no LLM.

## Customer portal (customer-safe)

The portal invoices page gains a **Paid to date / Due now / Overdue** summary from the
customer's own issued invoices (deposit/stage invoices included — they carry `customer_id`).
No costs, margins, internal notes, forecasts, or other customers/jobs are exposed. Online
"Pay now" remains the dark seam from M1 (`docs/billing-plans.md`) — not built/activated.

## Security / isolation

Owner reads are RLS-scoped to `current_org_ids()`; the portal reads are scoped by
`org_id + customer_id` through the single `loadCustomerByPortalToken` authority. Proven:
`__tests__/integration/billing/org-cash-isolation.test.ts` (a member of another org, and
anon, see **zero** of an org's invoices / payments / billing stages).

## Performance / cost

Bounded, paged reads composing already-fetched authorities (no N+1, no per-job round-trips —
one read per entity, aggregated in JS). **~£0 incremental** — existing Postgres/Supabase/
Vercel, no cron, no realtime, no provider, no LLM.

## Tests

- **Unit (9 new):** org-cash (5 — summary reconciliation, collectable-floor, overdue-not-
  double-counted, buckets, queues); portal-payments (3 — paid/due/overdue sums, draft-excluded,
  part-paid shows remaining); the briefing `billing_ready` signal (1).
- **Integration (3 new, real Postgres):** cross-tenant isolation, the **[P0] dual-org-member**
  regression (bare RLS blends both orgs; the `org_id` pin scopes to one), and anon isolation.
- The E2E "owner cash / portal / briefing" journeys run against the authenticated harness;
  dedicated Playwright specs for the three journeys are a tracked M3 follow-up.

## Adversarial review (commercial-maths + RLS, on the implemented code)

Every figure traced to the ledger; reconciliation, bucketing, VAT bases and portal
customer-safety verified correct. Fixed:
- **P0** — `buildOrgCash` ignored its `orgId`; because `current_org_ids()` returns
  *every* org a viewer belongs to (many-to-many memberships), a user in two orgs
  would see **blended** cash on one org's `/cash`. Now every read is explicitly
  `.eq("org_id", orgId)`-pinned (matching `retention-snapshot.ts`). Regression-tested
  (a dual-org member's bare RLS read blends both orgs; the pinned read scopes to one).
- **P2** — the `job_billing_stages` read was unbounded (silent 1000-row truncation of
  `readyToInvoice`); now paged via `fetchAllRows` + org-pinned.

**Residual P3 (documented):** `collectableNow = owedNow − retentionHeld` is a portfolio
heuristic — `owedNow` is inc-VAT and `retentionHeld` is ex-VAT and accrues on *all*
non-draft invoices (incl. fully-paid), so it can understate chase-now cash when
retention is held on already-settled invoices. Precise per-invoice retention
attribution is an M3 refinement. (Same formula as M1's job-level summary.) Minor: the
portal invoice read is `.limit(200)`; whole-table in-memory aggregation is fine to
low-thousands (SQL aggregates are the later step).

## Known limitations / M3

- Portal **upcoming agreed stages** + **retention line** (needs per-job billing-plan joins) — deferred.
- Dedicated Playwright journeys A/B/C (owner cash, portal, briefing) — deferred.
- Communication/chasing **activation** (the deterministic triggers exist via the briefing/signals) — deferred, provider-gated.
- **Online invoice payment** — the dark `PaymentProvider` seam (M1 docs); needs Stripe creds + a product decision.
- A short-horizon **cash forecast** (planned/expected vs invoiced/due) beyond the current buckets.
