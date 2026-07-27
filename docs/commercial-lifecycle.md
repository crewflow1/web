# Unified commercial lifecycle (Programme D)

One authoritative, **cash-first** answer to the question a builder actually has
about a job — *"how much money is still coming to me, and how much is late?"* —
plus the chronological commercial audit trail. A read-model that **composes the
existing pure modules**; it forks nothing and adds no migration.

Route: `/jobs/[id]/commercial`. Entry point: a ledger-truthful cash strip at the
top of the job page linking through.

## The headline: cash from the ledger, not from invoice status

The pre-existing job "Commercial position" derived *paid/outstanding* from
**invoice status** — a `partially_paid` £20k invoice with £5k received counted
its **full £20k** as paid, so the job read **£0 outstanding** while £15k was
genuinely owed. The customer portal already showed the truth (it sums
`invoice_payments`); the owner's own screen did not.

Programme D fixes this: `lib/commercial/cash.ts` (`computeCommercialCash`)
derives **received** = Σ real `invoice_payments` allocated to *this job's*
invoices, and **outstanding** = billed − received. The old status-based panel
was removed so the job no longer shows two contradictory numbers.

`computeCommercialCash` returns the full cash waterfall: contract (original +
approved variations = revised) → **billed** → **received** → **outstanding**
(with the **overdue** portion split out) → **still to bill** (revised − billed).
Cash rows are gross (VAT-inclusive — what moves through the bank); cost/profit
stay ex-VAT.

## The timeline

`lib/commercial/timeline.ts` (`buildCommercialTimeline`) assembles a curated,
UK-construction-vocabulary event stream from **source tables** — contract
agreed, variation approved/declined/raised, invoiced, payment received,
retention released, order placed, cost recorded — newest first, each with a £
figure, an in/out flow, and a deep link.

It is built from source tables, **not** the `activity_log`: the log has no
triggers for retention/PO/payment events, doesn't render or link them, and is
purged at 24 months — shorter than a construction retention/defects horizon.
Source tables carry every timestamp + £ and are always-truthful. (Actor — the
"who" — is a deliberate later overlay.)

## Security invariants (proven, not assumed)

- **Tenant client only.** The loader reads through `createClient()` (RLS +
  impersonation-aware `current_org_ids()`). It must **never** touch the
  service-role admin client — `finances` has no `customer_id` and is protected
  by RLS alone. Pinned by a hermetic source-contract test
  (`__tests__/security/commercial-lifecycle-tenant-client.test.ts`).
- **F2 — a payment counts only for its own job.** A real receipt can be split
  across invoices of different jobs/customers, so `computeCommercialCash` only
  ever sums payments whose `invoice_id` belongs to *this* job — never a parent
  receipt total. (Unit-pinned; the parent `payments` grouping lands with payment
  allocation #400 and preserves this rule.)
- **Portal is out of scope by design.** Reusing this operator model on the
  customer portal (which runs on the service-role client) would leak costs /
  margin / PO / supplier data. The cash figures are kept separate from the
  cost/profit block so a customer-safe projection can be built as a *separate*
  allowlisted loader in a later slice — never a redaction pass over this one.

## Composition (extends, never forks)

`computeCommercialCash` (new) + `computeRetentionPosition` + `computeCommittedCosts`
+ `computeJobProfitability` (all pre-existing) + `buildCommercialTimeline` (new),
over data read once via the tenant client. `invoice_payments` is loaded with a
single indexed `.in("invoice_id", …)` (empty-guarded); no new migration, no new
index — the job-scale two-hop is already index-covered.

## Tests

- **Unit** — `__tests__/commercial/cash.test.ts` (13, incl. the partial-payment
  fix + F2 exclusion + overdue), `__tests__/commercial/timeline.test.ts` (8,
  event derivation + ordering + curation).
- **Integration / RLS** — `__tests__/integration/rls/commercial-lifecycle.test.ts`
  (real Postgres: a non-member sees none of the job's invoices, payments,
  retention releases or POs; anon denied the cash leg).
- **Security** — the tenant-client source contract above.
- **E2E** — `e2e/commercial-lifecycle.spec.ts` (the view is behind the auth wall).

## Deferred (noted, not built)

- Customer-portal commercial view (separate allowlisted projection: agreed price
  incl. approved variations, billed/paid/outstanding, retention released — never
  cost/margin).
- Retention release **due-date + reminder** (needs a small date field — the
  highest-leverage add for actually recovering held cash).
- Outstanding/overdue rollups on the jobs list + dashboard.
- Grouped-receipt timeline events + actor overlay (land with payment allocation).
