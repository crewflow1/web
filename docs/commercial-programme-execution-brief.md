# Commercial programme — shared execution brief (Portal → Variations → Finance → Integration)

> Coordination contract for the Stage One continuation after Asset Management.
> The lead agent owns final architecture, all shared DB objects, migration
> sequencing, security sign-off, CI classification and milestone reports.

## Verified baseline (do not re-derive)

| Fact | Value |
|---|---|
| Base line | `feat/asset-integration` @ `db86548` (tip of the 17 delivered asset PRs) |
| Migration tip | `20261003000000_asset_service_schedules.sql` — new migrations strictly after; never reuse timestamps |
| PR base (MANDATORY) | `directive/018-r6-controlled-live-execution` — CI `pull_request` fires only for base `main`/`directive/018`; verify all 6 GH gates REGISTER on every PR; Vercel-only is never green |
| Open PRs | #373–#374, #376–#389 asset programme + RC2 #375 — ALL UNMERGED |
| RC2 | #375 `READY — UNMERGED — UNDEPLOYED`, frozen; no production claims |
| Attachment CHECK authority | `20261002` — 15 targets (inspect in-repo before ANY widening; never from memory) |

## Programme order (directive)

**A** Portal shell + action centre → document library → approvals/engagement →
security/E2E · **B** Variations core/versioning → approval/PDF → job-value +
invoice allocation → E2E · **C** POs → supplier bills → payment allocation →
retention/applications (if approved) → profitability/attention → E2E ·
**D** unified commercial lifecycle · **E** repository-grounded Stage One
reconciliation.

## Ownership (conflict prevention)

**Lead-only (serialized):** every migration; RLS policies; the customer-token
model; commercial state machines (`lib/` modules); invoice-integrity and
payment-allocation invariants; the shared attachment CHECK; approval workflows;
portal access model.

**Parallel (read/design only):** portal audit · commercial architecture audit ·
variations/finance domain design (all three dispatched 2026-07-20) · later:
performance, accessibility, E2E planning, documentation.

## Architecture rules (binding)

Reuse: customers + portal token model (+ expiry infra), quotes + acceptance,
jobs, invoices + snapshots + customer denormalisation, Stripe + payment
records + webhook idempotency, suppliers, tenant_attachments, audit/activity,
notifications (`emitNotifications` — no DB dedup: callers key off their own
writes), approval/draft/task engines, react-pdf, RLS helpers, design system.
Never create: second portal auth, second quote/invoice/payment/document/audit
system, frontend-only approval rules, mutable accepted commercial documents,
floating-point money, service-role portal reads without explicit scoping.

## Enforced invariants (shipped)

- **Accepted-quote immutability** (20261004000000): once `quotes.status =
  'accepted'`, its money figures (subtotal/vat_total/total) and its scope
  (line-item add/edit) are frozen by DB triggers `quotes_freeze_accepted` /
  `quote_line_items_freeze_accepted`; `updateQuote` also refuses the edit up
  front ("raise a variation"). DELETE stays open so `ON DELETE CASCADE` works;
  the invoice snapshot only READS lines, so accept→invoice is unaffected.
  To change agreed scope, raise a variation — never edit the accepted quote.

- **Construction retention** (20261005000000): `jobs.retention_percent` +
  append-only `retention_releases` ledger. Held = `rate% × non-draft invoiced
  NET − released` (DERIVED, never stored). DB guards: no over-release
  (`tg_retention_release_guard` computes accrued from invoices via SECURITY
  DEFINER), releases immutable (UPDATE blocked for all roles), positive amount,
  org-consistency; DELETE open for cascade. A COMMERCIAL holdback, not CIS/HMRC
  — no tax logic. Retention accrues on the ex-VAT works value (UK convention).

## Carried lessons (from the asset programme)

`next build` is a gate tsc can't replace (node:crypto) · inspect shared
constraints from source, never memory · guard/trigger replacements reproduce
prior arms verbatim + regression suites must re-pass · per-file CI log quotes
or it didn't happen · integration tests: fresh rows per case when predicates
are entity-wide (the G2 lesson) · PR base = directive/018, count the gates.

## Discovery inputs (pending — fill from agent reports before slice 1 lands)

- Portal audit: token resolution + route/action inventory + gap list.
- Commercial audit: quotes/invoices/payments/money-precision map + extension
  seams for variations/POs/allocation/retention.
- Domain design: variations lifecycle + versioning + allocation invariants;
  PO/bills/allocation/retention DDL + PR slicing (lead reviews before build).

## Stop conditions

Product fork · irreversible migration · architecture-changing decision ·
regulatory/accounting decision (CIS/HMRC = explicitly out without CEO input) ·
missing external credential with no parallel work · confirmed security break ·
programme completion · genuine context boundary after a full handoff. Green
PRs are not stop conditions.
