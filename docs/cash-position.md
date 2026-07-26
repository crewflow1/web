# H2-CASH M3 — Precise cash position, forecast & customer schedule

**Status:** built on `feat/h2-cash-m3-precision` (cumulative: main + #425 Daily
Briefing + #426 M1 Billing Plans + #427 M2 Cash Visibility + M3). Unmerged,
undeployed. **Zero migrations** — pure read/derivation + UI over the existing
commercial authorities. No provider, bucket, cron or env introduced.

M3 turns the cash layer from "roughly right" into a **construction-grade read
model**: it eliminates M2's retention approximation, adds an honest forecast that
never dresses a plan up as guaranteed cash, gives the customer their agreed
payment schedule, and proves owner ↔ job ↔ org ↔ customer all reconcile.

## The one rule: ledger facts ≠ contractual facts ≠ plans ≠ forecasts

Every figure on `/cash`, the job Get-Paid page, the portal and the briefing is
classified. Nothing blurs the line between money that is owed, money that is
agreed, and money someone *plans* to bill.

| Figure | What it is | Kind | Source |
|---|---|---|---|
| **billed** | Σ non-draft invoice totals (gross) | ledger fact | `lib/commercial/cash.ts` |
| **received** | Σ payments allocated to the job's invoices (gross) | ledger fact | invoice_payments ledger |
| **normal outstanding** | Σ per-invoice `max(0, total − paid)` (gross) | ledger fact | `cash.ts` (per-invoice capped) |
| **overdue** | outstanding on invoices past their due date | ledger fact | `isInvoiceOverdue` authority |
| **dueSoon (next 7/30d)** | outstanding on invoiced, dated, not-overdue invoices | ledger fact | `cash-forecast.ts` |
| **retentionHeld** | rate% × non-draft invoiced NET − released (ex-VAT) | contractual fact | `lib/retentions` |
| **retentionWithheldFromCollectable** | retention still EMBEDDED in unpaid invoices = `min(held, Σ min(remaining_i, accrued_i))` | contractual fact | `retention-attribution.ts` |
| **retentionDueNow** | held retention past its release date | contractual fact | `lib/retentions/schedule` |
| **collectableNow** | `outstanding − retentionWithheldFromCollectable` (floored) | derived (fact − fact) | `summary.ts` / `org-cash.ts` |
| **revised contract** | original + approved variations (gross) | contractual fact | `cash.ts` (live quotes) |
| **stillToBill** | `max(0, revised − billed)` | contractual fact | `cash.ts` |
| **plannedBilling** | Σ gross of agreed, un-invoiced billing stages | **a plan** | `cash-forecast.ts` |
| **draftedNotIssued** | Σ gross of drafted, un-sent invoices | ledger fact | `cash-forecast.ts` |
| **unscheduledValue** | `max(0, stillToBill − plannedBilling − draftedNotIssued)` | **a gap** | `cash-forecast.ts` |

The **cash outlook** on `/cash` lists these in descending certainty — Overdue →
Due → Planned billing → Unscheduled — and labels each in plain English
("Agreed billing stages planned to invoice — not yet billed"). **Planned billing
is never called "expected payment."** There is no fake probability and no LLM.

## Precise retention attribution — the M2 "P3" fix

M2 netted retention crudely: `collectableNow = outstanding − retentionHeld`,
where `retentionHeld` accrues on **every** non-draft invoice, including
fully-paid ones. So retention on a settled invoice wrongly shrank chase-now cash.

M3 attributes retention to the invoice whose works generated it and nets **only
what's still embedded in an unpaid balance**:

```
accrued_i   = round2(rate% × invoice.net_i)          (ex-VAT)
embedded_i  = min(grossRemaining_i, accrued_i)        (0 when the invoice is paid)
withheld    = min(retentionHeld, Σ embedded_i)        (per job, then summed org-wide)
collectableNow = max(0, outstanding − withheld)
```

**Worked example** (5% retention, two £12,000 invoices):
- Invoice A **unpaid** → accrued £500, embedded £500.
- Invoice B **paid in full** → accrued £500, embedded **£0** (nothing owed).
- `retentionHeld = £1,000` but `withheld = min(1000, 500) = £500`.
- `collectableNow = 12,000 − 500 = £11,500`. The old maths showed £11,000 — it
  wrongly withheld invoice B's £500. The remaining £500 held retention is a
  future receivable (`retentionOutsideOutstanding`), surfaced by the retention
  schedule, never chased as invoice debt.

Because every `embedded_i ≤ remaining_i`, `Σ embedded ≤ outstanding`, so
`collectableNow ≥ 0` without the floor (we floor anyway). The netting is summed
**per job** (each job has its own rate and held pool) — never a global `min`,
which would let one job's slack absorb another's overflow.

Released retention is respected: a partial release lowers `retentionHeld`, so
`min(held, embedded)` frees the released portion back into collectable.

## The forecast — due vs planned vs unscheduled

Everything is the **GROSS cash axis** (what moves through the bank). Crucially,
**unscheduled uses the LIVE gross contract** (`revised − billed − planned −
drafted`), NOT the frozen ex-VAT `job_billing_plans.basis_amount` snapshot — so a
variation approved *after* a plan was created correctly flows into the forecast
instead of silently vanishing (the drift the M1 basis snapshot would cause).

Windows are **next 7 days / next 30 days / later**, non-overlapping under the
hood (`0–7`, `8–30`, `31+`, `undated`) with cumulative presentation. Overdue is
excluded from "due" (a pound is in exactly one bucket). Undated collectable
invoices are shown as "undated", never silently overdue.

Planned billing is **capped at the remaining contract** (`plannedCapped =
min(plannedTotal, stillToBill − drafted)`) so a stale plan or a stage VAT set
above the contract's can never make the forecast claim more near-term cash than
the contract holds. `revised` is a **signed** sum (an accepted omission variation
reduces it, matching `computeCommercialCash`).

**Reconciliation:** per job, `billed + draftedNotIssued + plannedCapped +
unscheduled === revised` whenever the contract isn't over-billed (`billed ≤
revised`; an over-bill surfaces as `billed > revised` rather than a hidden
negative). Org totals are the **sum of per-job positions**
(`aggregateCashForecast`, `computeOrgRetentionNetting`) — so `/cash` can't
disagree with the jobs beneath it. Org `collectableNow` nets retention over the
**same collectable-status universe** `owedNow` counts, so a `paid`-with-residual
invoice can't steal cash across jobs. Unit-tested in `cash-forecast.test.ts` (the
capped partition, signed revised) + `org-cash.test.ts`/`plan-summary.test.ts`
(the precise-netting branch) + `retention-attribution.test.ts`.

## Overpayment / void invoices

Overpayment never creates negative debt: every aggregation re-applies the
per-invoice `max(0, total − Σpaid)` floor (the DB permits Σpayments > total; the
read layer caps it, consistently, in `cash.ts`, `org-cash.ts` and `cash-forecast.ts`).
There is **no `void`/`cancelled` invoice status** in this schema (verified) — a
`draft` is not-yet-owed and a `paid` invoice is £0 in every forward bucket, so
the "void → £0" requirement holds by construction.

## Customer portal — the agreed payment schedule

The portal gains a **Payment schedule** (deposit → stages → completion, each with
amount, status and date) plus a **Retention held** line (amount + release date)
when retention applies. Customer-safe **by construction**: `lib/customers/portal-schedule.ts`
exposes only `{name, gross, status, dueDate}` per stage + `{held, releaseDate}` —
cost, margin, plan basis, stage percent/basis, notes and staff PII are not
representable. Amounts are GROSS (matching the rest of the portal).

**Security — the load-bearing filter.** `job_billing_plans`/`job_billing_stages`
have **no `customer_id`**, and the portal runs on the RLS-bypassing admin client.
So `app/customer-portal/[token]/_schedule.ts` resolves the customer's OWN jobs
first (`jobs` where `org_id + customer_id`) and reads stages `.in("job_id",
customerJobIds)`. That app-level filter is the only barrier and is proven
load-bearing: `__tests__/integration/billing/portal-schedule-isolation.test.ts`
(a bare org-wide read sees customer A's stage; the job-scoped read does not) +
the source-contract guard `__tests__/security/portal-schedule-scope.test.ts`.

**Owner ↔ portal reconcile:** both derive from the same invoices + stages; the
customer simply sees a safe subset, never a contradictory figure.

## Daily Briefing — forward cash signals

Two deterministic signals, both **LOW severity** so they can never outrank a
safety breach or overdue debt (severity strictly dominates in the composer):
- `cash_due_soon` — "£X due from customers this week" (issued invoices, next 7d).
- `unscheduled_value` — "£X not yet scheduled to bill across N jobs" — the "plan
  how you'll get paid" nudge.

The briefing consumes the **one** org-cash authority (`buildOrgCash`) rather than
recomputing, so its numbers are identical to `/cash`. Ranking invariant is
tested (`__tests__/briefing/compose.test.ts`).

## Security / isolation

Owner reads are RLS-scoped AND explicitly `org_id`-pinned on every read
(preserving the M2 P0 fix — `current_org_ids()` returns every org a viewer
belongs to, so a dual-org member must not see blended cash). The new quotes read
and per-job grouping are org-pinned; grouping never mixes orgs. Proven by
`__tests__/integration/billing/org-cash-isolation.test.ts` (incl. the dual-org
regression) and the portal isolation test above.

## Performance / cost

Bounded, paged reads (`fetchAllRows`, 1000-row-truncation-safe) composing
already-fetched authorities; the per-job loop is pure JS over in-memory maps —
**no N+1** (no query inside any loop). The briefing reuses `buildOrgCash` once
(a deliberate consistency choice: identical numbers to `/cash`, at the cost of
re-reading invoices/jobs the briefing also reads — acceptable at SME scale, all
bounded). **~£0 incremental** — existing Postgres/Supabase/Vercel; no cron,
realtime, provider or LLM.

## Tests

- **Unit:** `retention-attribution` (10 — the P3 fix, per-job-not-global, floors),
  `cash-forecast` (7 — buckets, variation drift, overpayment floor, reconciliation
  partition, org=Σjobs), `portal-schedule` (5 — status mapping, customer-safe
  shape), briefing M3 signals + the severity-dominance invariant.
- **Integration (real Postgres):** portal-schedule cross-customer isolation (4),
  org-cash multi-org isolation incl. dual-org (3).
- **Security:** portal-schedule source-contract scope (4).
- **E2E (real app + real Postgres):** Journey A owner cash, Journey B portal
  (visibility + isolation + forged token), Journey C briefing, Journey D the
  retention regression (asserts £11,500 not £11,000 on the job page).

## Adversarial review (12 specialists, on the implemented code)

WAVE A recon (4) + WAVE C adversarial (8: retention, forecast, RLS/multi-org,
portal-safety, performance, financial-maths, construction-SME/CTO, a11y/mobile).
Fixed before shipping:
- **P1 org collectable universe mismatch** — embedded retention was netted over
  all non-draft invoices while `owedNow` counts only collectable statuses, so a
  `paid` invoice with a residual balance broke org = Σ jobs. Netting now uses the
  same collectable universe.
- **P1 forecast overstatement** — `revised` was floored per-quote (dropped
  omission variations) and planned billing could exceed the live contract (stale
  plan / stage-VAT-above-contract). Now signed `revised` + `plannedCapped`, and
  undated planned is shown via the total (not only the 30-day window).
- **P1 briefing dual-org blend** — the briefing's own reads weren't `org_id`-pinned
  (the M2 P0 class); now pinned (+ unique pagination tiebreaker across org-cash &
  briefing reads, closing a silent >500-row truncation).
- **P1 a11y** — a space in an `aria-labelledby` id broke two queue-section names;
  slugified.
- **P2** — a load failure now shows a "couldn't load" banner instead of a falsely
  reassuring "£0 owed"; the portal-retention security test was reconciled to the
  new (narrow) exposure; label contrast raised to AA; test coverage added for the
  precise-netting branch and the capped reconciliation identity.

**Documented residuals (not defects to fix in M3):**
- Retention accrues on all certified value regardless of a stage's
  `retention_applies=false` flag (a pre-existing `lib/retentions` authority
  behaviour). `collectableNow` stays correct (the netting caps it); only the
  held total can be slightly high. A product decision, tracked for the authority.
- Near month-end, "Due this week" (rolling 7d) can read higher than "Expected
  this month" (calendar month-end) — a pre-existing M2 tile semantic, unchanged.
- Sub-penny rounding: per-invoice accrual (`Σ round2(rate×net_i)`) can differ
  from the aggregate by ≤ ~£0.005 × invoice-count; capped at `held`, never
  reaches a chase figure.

## Not built / M4 (unchanged boundaries)

Online invoice payment (the dark `PaymentProvider` seam — needs Stripe creds + a
product decision) and automated chasing (email/SMS reminders off the overdue/
due-soon signals — provider-gated) remain **dark**. Deferred: applications-for-
payment / QS valuations, a longer cash-flow projection, CIS/subcontractor tax.
