# H2-CASH — Billing Plans ("Get paid")

**Status:** built on `feat/h2-cash-billing-plans` (off prod `ed748b5`). Unmerged, undeployed.
Migration `20261039`. Additive; **no provider, bucket, cron or env introduced.**

## What it is

The layer **above** invoices: a builder carves a job's contract into stages
(deposit, first fix, on completion, retention-aware balance) and each stage
**generates a normal invoice** through the existing invoice authority. The plan
stores no money of its own — invoices + payments stay the single source of truth
for value and cash. It answers, on one page: what's the contract, what's
scheduled, what's billed, what's been received, what's **collectable now**
(retention removed), and which stages are still to invoice.

## The money model (one source of truth — nothing forked)

Amounts on a stage are **NET (ex-VAT)**. VAT is added per stage on top at its rate
(0/5/20). Stages **partition the contract**:

```
Σ(stage net) ≤ contract net (basis)      -- DB guard tg_billing_stage_within_basis
```

A **deposit** is simply the first slice; a later stage bills a further,
non-overlapping slice (**never** "earned less deposit" — no credit machinery). A
**balance** stage absorbs the remainder (`basis − Σ others`) so a deposit+balance
or staged plan sums to exactly the contract.

**Penny-exactness:** `lib/money.ts::apportion` (largest-remainder) guarantees a
split like 33.33 / 33.33 / 33.34 of £10,000 = £3,333 / £3,333 / £3,334 = £10,000,
never £9,999.99. `equalSplit` uses it for the "N equal stages" convenience.

### Authorities the summary COMPOSES (never re-sums)
| Figure | Owner |
|---|---|
| contract / billed / received / outstanding / overdue / stillToBill | `lib/commercial/cash.ts` (GROSS) |
| retention held / accrued / released | `lib/retentions/compute.ts` (ex-VAT) |
| scheduled net / stage amounts | the billing plan (NET) |

`lib/billing/summary.ts::computeGetPaidSummary` presents two clearly-separated
axes (NET planning · GROSS cash) so VAT bases are never mixed, plus the one
deliberate cross-axis figure — the **retention-netting fix**:

```
collectableNow = max(0, cash.outstanding(gross) − retention.held(exVAT))
```

VAT is never retained, so subtracting ex-VAT held from gross outstanding yields
the true chase-now debtor. This fixes the known defect where withheld retention
showed as ordinary overdue debt.

## Lifecycle / state machine

A stage's status is **DERIVED** from its linked invoice, never stored
(`lib/billing/plan.ts::deriveStageStatus`):

```
planned ──generate──▶ invoiced ──payment──▶ part_paid ──payment──▶ paid
                          └─past due date & owed──▶ overdue
```

`overdue` goes through the one authority (`lib/invoices/overdue.ts`).

## Reuse — no second invoice/payment/retention system

- **Invoices:** `generate_stage_invoice(stage, due?)` RPC inserts an ordinary
  invoice — `quote_id NULL`, `job_id` + `customer_id` from the job, ex-VAT amount
  + per-stage VAT, sequential `next_invoice_number`, one descriptive line item,
  status `draft`. `total` is the generated column (never written).
- **Payments / allocation:** untouched. A stage invoice is an ordinary invoice
  with a total, so `allocate_payment` + the over-allocation guard +
  `_tg_invoice_payments_sync_status` all apply automatically. Record payment via
  the existing flow. (A stage invoice always has a non-zero total — a £0 invoice
  would flip to `paid` on the status trigger's `0 ≥ 0`, so `amount > 0` is enforced.)
- **Retention:** untouched — held/released/due stays owned by `lib/retentions`.
- **Variations:** an approved variation lifts `cash.revised`; re-scheduling the
  extra is the operator's choice (add a stage), never an automatic rewrite of
  historical stages.

## Security & integrity (DB-enforced)

- **RLS:** members read; **owner/admin write** (`is_org_admin` in the insert/
  update/delete policies) — the admin boundary survives a direct-PostgREST caller.
- **Org binding:** composite FK `(plan_id, org_id)` and `(invoice_id, org_id)`;
  a SECURITY DEFINER guard (`tg_billing_assert_job_org`) forces a row's job to
  belong to its org — forged `job_id`/`plan_id`/`invoice_id` can't cross tenants.
- **Idempotency:** partial-unique on `invoice_id` + a `FOR UPDATE` CAS in the RPC
  → a double-click or two-admin race bills a stage **once**.
- **Immutability:** an invoiced stage's money is frozen for **all roles**
  (`tg_billing_stage_frozen_when_invoiced`).
- **Ceiling:** `Σ(stage) ≤ basis` enforced with a `FOR UPDATE` plan lock
  (TOCTOU-safe), `basis 0` = no ceiling (progress mode).
- **Generation** is admin-only (the RPC's own `is_org_admin` check) and refuses a
  customerless job (would orphan the invoice).

## Online customer payment — designed DARK, not built

Reusing the existing Stripe **webhook verify → claim (event_id UNIQUE) →
idempotent dispatch → mark** pattern (`stripe-webhook-handler.ts`), the future
end-customer payment seam is: a **separate** `PaymentProvider` (its own keys +
`/api/webhooks/payments` endpoint, selected by an optional `PAYMENTS_PROVIDER`
env → `NullPaymentProvider` when unset), where **CrewFlow's DB is the source of
truth**: `createPaymentSession(invoiceId)` re-reads the invoice server-side
(amount/currency never trusted from the client); `handleWebhook` verifies the
signature, dedupes the event, checks `invoice_id`+`org_id`+`amount`+`currency`+
status against the invoice, and only then writes an `invoice_payments` row via
the existing allocation path. **Not built this milestone** — no keys, no charges,
no UI. Activating it is a product + credentials decision.

## Tests

- **Unit** (`__tests__/billing/*`, 23): `apportion` penny-exactness, stage
  resolution (deposit+balance, percent independence, VAT-on-top, over-carve,
  no-ceiling), `equalSplit`, status derivation, the get-paid summary + retention
  netting, the briefing signal.
- **Integration / real Postgres** (`__tests__/integration/billing/*`, 7): RLS
  admin-gate, cross-tenant denial, Σ≤basis, the generate RPC (job-scoped,
  quote-NULL invoice + line item + stage link + idempotency + immutability),
  member-can't-generate, customerless-job guard, anon denial.

## Cost

Near-zero: additive tables + one RPC on existing Postgres; no provider, cron,
realtime or egress. Reads compose already-fetched authorities.

## Adversarial review (2-agent, on the implemented code)

Payments-security + commercial-maths red-teams (500k+ fuzz cases on the money
maths). **No P0/P1 security or cross-tenant/privilege hole**; all 10 forgery/
double-bill/replay attacks blocked. Fixed:
- **P1 (functional):** all-percent plans were silently rejected for ~25–50% of
  contract values — k independently-rounded percent stages overshot the basis by
  up to k×½p, tripping the fixed-tolerance Σ≤basis guard, and the action swallowed
  the error. Fixed at the root: percent stages are capped at the running remainder
  (Σ penny-exact ≤ basis; last stage absorbs the penny), the DB tolerance scales
  with stage count, and the action now logs a rejected insert.
- **P2:** an invoiced stage's `invoice_id` could be nulled/relinked via direct
  PostgREST → re-invoice. The freeze trigger now forbids changing `invoice_id`
  once set (only the FK-cascade unlink, when the invoice is already gone, is
  allowed) — teardown-safe.
- **P3:** stage.job_id must equal plan.job_id (attribution) — now enforced.

**Residual P3 (documented, non-blocking):** (a) a direct-PostgREST admin deleting
an invoiced stage orphans (does not hide) its invoice — the invoice survives and
stays customer-visible; a DB delete-guard was rejected because it would block
legitimate org/job cascade teardown. (b) lowering `plan.basis_amount` below Σ
stages isn't re-validated (cosmetic; all consumers clamp ≥ 0). (c) the per-org
invoice-number allocation inherits `next_invoice_number`'s known non-atomicity
(platform-wide; a concurrent same-org generation retries, never double-bills).

## Known limitations / follow-ups (tracked)

- **Online payment** deferred (dark seam above) — needs provider creds + product decision.
- **Applications-for-payment / QS valuations / pay-less notices** deferred; fixed-
  amount progress stages cover the simple interim case.
- **Credit notes / refunds / overpayment credit** — the schema doesn't preclude
  them; `amount > 0` stays enforced (design the seam, don't relax it yet).
- **Daily Briefing wiring:** `lib/billing/signals.ts` exposes a ready-to-invoice
  signal seam; PR #425's briefing service consumes it once both merge (kept
  decoupled to avoid cross-branch dependency).
- Stage invoice PDF shows one line (the stage) — richer multi-line stage invoices later.
