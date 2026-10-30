# CrewFlow — Launch Readiness Tracker

**Target:** sign a real NI/UK construction business (5–30 employees) at **£1,000 setup + £500/month**, sales-led.

**Status key:** `VERIFIED` (automated test passes or behaviourally confirmed live) · `LIVE` (merged + deployed to prod) · `BUILT` (code complete, not yet live) · `APPLY-HELD` (migration built, awaiting founder apply approval) · `UNTESTED` (exists, not yet end-to-end verified this programme) · `DEFERRED` (intentionally post-launch) · `BLOCKED` (needs founder/external action).

_Maintained factually. A feature is not `VERIFIED` until its stated evidence holds. Last update: 2026-10-30, prod `b588b6a`._

---

## A. Core customer journey (the launch gate)

| Step | Status | Evidence |
|------|--------|----------|
| Lead create → convert to customer | **VERIFIED** | `e2e/core-journey.spec.ts` test 1 (real browser, prod build); customer row DB-confirmed |
| Quote build + line items + **VAT math** (2×£100@20% = £240) | **VERIFIED** | test 2; server-computed `quotes.total = 240` DB-confirmed |
| Quote approval → self-approve → **accept** | **VERIFIED** | test 3; `quotes.status = accepted` |
| Accept **auto-creates Job + draft Invoice** (£240) | **VERIFIED** | test 3; `quotes.job_id` set, one `invoices` row `total=240` linked to the job |
| Assign staff to job (single-assignee, persists) | **VERIFIED** | test 4; `jobs.assigned_to` set, DB-confirmed |
| Record payment → invoice **status = paid** + balance | **VERIFIED** | test 5; `invoice_payments` sum = 240, `invoices.status = paid` |
| Dashboard money tiles render for owner | **VERIFIED** | test 5 (Cash in this month / Outstanding visible) |

**Journey verdict:** the full lead→payment journey is **VERIFIED by automated tests** (`e2e/core-journey.spec.ts`, 5 serial tests, green ×2 on a production build). Runner note: must run against `npm run start`, not `next dev` (dev drops Pattern-A `router.push` nav — a dev-only artifact).

**Product realities (not defects):** quote acceptance requires prior approval (draft→request→approve→accept; sole owner self-approves); job + invoice are auto-created on accept (no manual convert buttons); staff assignment is single-assignee (`jobs.assigned_to`).

---

## B. Roles, permissions, data isolation

| Item | Status | Notes |
|------|--------|-------|
| R2 capability model + R3 owner/admin mgmt + R4 33-module enforcement | **LIVE** | merged; capability gates across modules |
| Owner-facing admin permission editor (incl. Manage-toggle fix) | **LIVE** | #978 merged + deployed `b588b6a` |
| R5 Phase 1 — `job_assignments` model + backfill | **APPLY-HELD** | #975, CI-green, independently reviewed; migration not applied |
| R5 Phase 1 — GDPR service-side DSAR export for the dark table | **APPLY-HELD** | #975; adversarial-reviewed APPROVE; included via membership-gated admin lane |
| R5 Phase 2 — jobs assignment-aware SELECT RLS | **APPLY-HELD** | #977, isolated-Postgres verified, adversarial-reviewed APPROVE |
| R5 Phases 3–5 — operational child tables / commercial denial / workforce self-scope | **BUILT (planning) / not started (migrations)** | 36 job-child tables inventoried + classified in the approval pack |
| **Staff see only assigned jobs/data at the DB** | **NOT LIVE** | org-wide member RLS still in effect until R5 applied — **launch gate for any customer onboarding staff** |

---

## C. Commercial / onboarding / integrations

| Item | Status | Notes |
|------|--------|-------|
| Stripe config (£1,000 setup + £500/mo prices, webhook) | **LIVE (config)** | self-serve OFF; no live charge proven |
| Stripe sales-led onboarding + live charge | **UNTESTED / BLOCKED** | needs founder dashboard action; no autonomous charge |
| Resend (quote/invoice email, bounces, HMAC webhook) | **UNTESTED** | `comms.email: true` in prod health; delivery not re-verified this programme |
| Sentry monitoring | **UNTESTED** | `monitoring.enabled: true` in prod health |
| CrewFlow HQ (onboarding, demo→customer promote, support) | **UNTESTED** | verify in real browser (follow-up) |
| Customer portal (quote view/approve, isolation) | **UNTESTED** | portal-token isolation covered by existing specs; full flow not re-verified |

---

## D. AI (launch scope)

| Feature | Status | Notes |
|---------|--------|-------|
| AI quote drafting | **UNTESTED** | surface exists on quote builder; benefit/guardrails not re-verified |
| AI business insights | **UNTESTED** | gated on `reports:view`; not re-verified end-to-end |
| AI receptionist / outbound / dispatch / advanced | **DEFERRED** | post-launch; stay dark |

---

## E. Deferred (intentionally post-launch)

- Multi-worker job assignment UI (model built in R5 P1; UI not built).
- R5 Phases 3–5 production application (apply-held).
- Self-serve billing.
- Advanced AI features above.

---

## F. Outstanding founder/external actions

1. Approve **#975 → #977** merge + **apply R5 migrations** (after the staff-job-read app reconciliation) — unblocks staff data isolation (the top launch gate for staffed customers).
2. Authorise / perform the first **live Stripe charge** (£1,000 + £500/mo), sales-led.
3. Confirm launch AI scope (quote drafting + insights) once their end-to-end verification completes.
