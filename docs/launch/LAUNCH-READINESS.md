# CrewFlow — Launch Readiness Tracker

**Target:** sign a real NI/UK construction business (5–30 employees) at **£1,000 setup + £500/month**, sales-led.

**Status key:** `VERIFIED` (automated test passes or behaviourally confirmed live) · `LIVE` (merged + deployed to prod) · `BUILT` (code complete, not yet live) · `APPLY-HELD` (migration built, awaiting founder apply approval) · `UNTESTED` (exists, not yet end-to-end verified this programme) · `DEFERRED` (intentionally post-launch) · `BLOCKED` (needs founder/external action).

_Maintained factually. A feature is not `VERIFIED` until its stated evidence holds. Last update: 2026-10-31, prod `f110944`, DB tip `20261259000000` (**R5 applied + verified live**)._

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
| R5 Phase 1 — `job_assignments` model + backfill | **LIVE** | migration `20261242000000` applied 2026-10-31; backfill correct (1 legacy assignment carried on prod) |
| R5 Phase 1 — GDPR service-side DSAR export for the dark table | **LIVE** | shipped via #997/#998; `job_assignments` service-role-only (no client grant) verified on prod |
| R5 Phase 2 — jobs assignment-aware SELECT RLS | **LIVE** | migration `20261243000000` applied; staff-only-assigned-jobs proven on prod (below) |
| R5 Phases 3–5 — operational child tables / commercial denial / workforce self-scope | **LIVE** | migrations `20261244→20261259` applied; commercial + finances denial and rota/time self-scope proven on prod (below) |
| **Staff see only assigned jobs/data at the DB** | **VERIFIED** | Real authenticated RLS proof on prod (Internal HQ org, rolled-back, 0 residue, 2026-10-31): staff saw only their assigned job (other worker's job denied incl. direct fetch), `job_budgets`=0 + `finances`=0, other-worker rota/time=0; owner saw all + commercial + finances. Evidence: `docs/hardening/R5-APPLY-RESULT-2026-10-31.md`. Also CI first-customer E2E 11/11 (staff-denial scenario) on prod build. |

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

- Multi-worker job assignment UI (model + reconciliation RPCs now live; richer UI is incremental).
- Self-serve billing.
- Advanced AI features above.

---

## F. Outstanding founder/external actions

1. ~~Approve + apply R5 migrations~~ — **DONE 2026-10-31** (approved, applied 242→259, verified; staff data isolation now live).
2. Run the real **staff-login UI click-through** against prod — I can drive it in the in-app browser once a staff (then owner) session is established in Internal HQ; I cannot create a prod login or enter prod passwords myself (safety boundary). DB/RLS layer already proven.
3. **AI credentials** for live AI features: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` + `CREWFLOW_INTERNAL_ORG_ID` (features are code-complete + CI-tested, dark on creds only).
4. **Custom SMTP** verify in the Supabase Auth dashboard (transactional email sender).
5. Authorise / perform the first **live Stripe charge** (£1,000 + £500/mo), sales-led.
6. Review + approve **PR #1008** (cron-runs-prune timeout fix) and its migration `20261260000000` — a prod background-job defect found during this acceptance pass (fix on branch, not applied).
