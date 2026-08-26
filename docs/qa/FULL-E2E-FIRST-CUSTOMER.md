# CrewFlow — Full End-to-End Acceptance Test (Pre-First-Customer Release Gate)

**Prepared:** 2026-08-25 · **Baseline:** `main` = production = `8784cd0b` · **Method:** ran the repo's own automated suites against a seeded **local real-Postgres** stack (unit / security / integration / Playwright e2e), plus direct code verification of every audit-flagged item and live production smoke. No app behaviour changed; no fixes applied; nothing merged/deployed; no dark provider activated.

---

## Phase 0 — verified current truth

| Check | Result |
|---|---|
| origin/main SHA | `8784cd0b6b9dbcb0837f84c446e10466ea35fe66` |
| Production SHA | `8784cd0` (matches) |
| **Production health** | ✅ `ok:true, status:healthy` |
| **DB health** | ✅ `db:ok` (Supabase host resolves again — CEO restored the project) |
| Migration parity | ✅ prod **378 applied, tip `20261218`** == 378 main files == 378 local |
| Dark-provider state | email `true`; sms/whatsapp/missed-call/weather `false` — **no dark provider activated** |
| Monitoring | ⚠️ prod health now `monitoring.enabled:true` (Sentry DSN appears configured in prod since the audit — error capture now live) |

**Gate: PASS** — production is healthy, so E2E proceeded (against the seeded local stack, never production).

---

## Test environment
- **Local Supabase** (real Postgres), migrated to `20261218` (378/378 — exact match to prod).
- Automated tiers run from the baseline worktree with the CI env set.
- **Environment caveats (not product defects):** (1) `xml-crypto` (declared dep, used only by the DARK enterprise-SSO SAML path) was missing from the borrowed `node_modules` — installed to complete the env. (2) Cross-browser (WebKit/Firefox) not run — the repo's Playwright config is chromium-only (same as CI). (3) One integration test flakes locally on Docker clock-skew (below).

---

## Automated suite results (the E2E backbone)

| Tier | Result | Notes |
|---|---|---|
| **Unit** (`vitest.config`) | **10893 passed** | 1 suite failed to *load* = `xml-crypto` env artifact (dark SSO). Zero product-test failures. |
| **Security** (`vitest.security.config`) | **8145 passed / 1 env-fail** | The 1 fail = same `xml-crypto` load (dark SSO). All real invariants green: loud-read, rate-limit fail-open/closed, RLS, tenant boundaries. |
| **Integration** (real Postgres, 248 files) | **2210 passed / 1 fail / 96 skipped** | 1 fail = **clock-skew flake** (`site-compliance-isolation`: `signed_out_at >= signed_in_at` against a Docker DB clock drifted ahead of the JS clock; green in CI). ~46 files skip locally = dark-provider/flag-gated features (receptionist, automation, telephony, Stripe, WhatsApp, portal-token, cadence) — expected. |
| **Playwright e2e** (chromium, 53 specs / 158 cases) | **148 passed / 0 failed / 10 skipped** | Real app (production build) + real Postgres. Auth-redirect contract, mobile no-overflow @375px, axe a11y, offline queue, PWA cache-privacy, security headers, stock/blueprint/cash flows. |

**Green on real Postgres (high-signal):** cross-tenant FK completeness; jobs/leads/quotes cross-tenant integrity; tenant-isolation; payment-allocation; CIS statement-email idempotency; AI budget atomic ceiling under 100-way concurrency; **staff-compensation RLS (6/6)**.

---

## Suite-by-suite verdicts + audit-item verification

### Suite P/36 — Permissions / Money-role enforcement → **CONFIRMED GAP (P1)**
Verified by code, not assumption. `app/api/reports/export/route.ts` GET is gated by **`requireOrgContext()` only — no role check** — and returns company **revenue-per-month, VAT-per-quarter, top-customers-by-revenue** to any org member incl. `staff`. The money **pages** (`/invoices`, `/quotes`, `/finances`, `/expenses`) have no role guard (member-wide RLS + org context). The reports *page* filters management-only reports by `isAdmin`, but the export API and money pages do not. In-org over-exposure (not cross-tenant, not a pay leak). *(Live staff-JWT proof appended if e2e env allows.)*

### Suite E/35 — Compensation privacy regression → **PASS**
`__tests__/integration/staff/compensation-rls.test.ts` **6/6** on real Postgres: staff cannot read co-worker `hourly_pay`/`staff_compensation` or `emergency_contact`; self-or-admin read, admin-only write. `users` table exposes only safe columns to co-workers.

### Suite C/20 — Quote → job conversion → **CONFIRMED drops data (P1)**
`app/(app)/quotes/actions.ts:812` & `:1094` insert the job with only `org_id, customer_id, status:"new"`, and a `notes` blob. **Dropped:** `property_id` (site address — present on the quote), line-items/scope, contract value, title. New job = near-empty shell.

### Suite F/22 — Site & Safety → **STRONG engine; incidents/RIDDOR NOT-BUILT (P1)**
No `incidents`/`accidents`/`riddor`/`near_misses` table in any migration; no route. RAMS/permits/toolbox/inductions/ITP/NCR/snags/muster + external worker sign-off portal all real (confirmed by prior deep trace + green safety integration tests). Expired certs warn-not-block; internal staff can't discover RAMS/permits in nav (both P1, prior-audit-confirmed).

### Suite O/43 — Error/recovery → **CONFIRMED DB-intervention gaps (P1)**
`invoice_status` enum = `draft|sent|awaiting_payment|partially_paid|paid|overdue` — **no void/cancelled**. `jobs.status` = `new|in-progress|completed|blocked` — **no cancelled**. Voiding an issued invoice, cancelling a job, or fixing a raw timesheet entry has no in-product path → **direct Supabase edit**. (Password reset, PRG back-button, offline write queue, audited supplier-payment void all work.)

### Suite I/26–29 — Money / VAT / CIS / Payroll → **PASS (calculations correct; prepare-not-file)**
Financial + CIS + payment-allocation integration suites green on real Postgres. VAT (cash/standard/FRS/reverse-charge) single-authority; CIS idempotency 7/7; corp-tax marginal relief correct (verified prior). HMRC filing is DARK/prepare-only and the UI says so (product-truth honest). Accounting CSV is sales-side only; no credit-notes/refunds; cash position receivables-derived.

### Suite V/42 — Data integrity → **PASS**
No cross-org rows, no broken FKs, no double-count stock, no duplicate CIS sends, no duplicate payment side-effects — the dedicated integration suites (cross-tenant-fk-completeness, tenant-isolation, stock ledger, CIS idempotency, payment-allocation) are green.

### Suite S/39 — Observability → **IMPROVED (Sentry now live in prod); paging still a question**
Prod health reports `monitoring.enabled:true` and the build activates Sentry source-map upload → error capture appears **now live in production** (was dark at audit). Health endpoint gates `ok` on a live DB probe + honest outbound-readiness booleans. `cron_runs` telemetry complete (45/45). Open items (prior-audit): `/admin/ops` surfaces only 8 crons; no in-app failed-email requeue; uptime-monitor/paging wiring (BetterStack) — verify separately.

### Suite R/38 — Support / HQ → **STRONG tooling; correction-tooling gap**
HQ console substantial; impersonation best-in-class (super-admin gated, 24h cap, reason required, audited, kill switch). But routine corrections (invoice void / job cancel / timesheet fix) land on DB (Suite O) — the main supportability liability.

### Suites A/D/M/N/U (browser/UX) — **PASS (chromium)**
Playwright e2e 148/0: auth login-redirect contract holds end-to-end; **no horizontal overflow at 375px** across staff dialog, toolbox detail, and every stock page; axe a11y clean at desktop + 375px; offline diary queue syncs exactly once + shared-device sign-out purge; PWA CacheStorage holds only allowlisted public assets; security headers present. **Cross-browser (WebKit/Firefox) NOT run** (chromium-only config; same as CI) — a residual gap, not a defect.

### Suite T — Performance (code-level, from prior audit)
Dashboard 85-query fan-out solved (parallel waves); residual sequential tails in dashboard/job-workspace/`/me` are latency-only P2/P3. Not re-measured live this run.

---

## Issue register (this programme)

**P0 (this run):** none new. Production is healthy; automated suites show **zero real product failures**; no cross-tenant, pay-leak, or financial-calc defect.

**P1 (confirmed):**
1. Money area not authz-enforced (staff read revenue/VAT/invoices/quotes/costs via URL/API; can create invoices/expenses). *WA: provision only owner/office accounts.*
2. Quote→job conversion drops site/scope/value. *WA: PM re-enters.*
3. Issued-invoice void / job-cancel / timesheet-fix require DB edits. *WA: no.*
4. No incidents/accidents/RIDDOR module. *WA: paper/external.*
5. Expired certs warn but never block; worker can't see own expiry. *WA: admin vigilance.*
6. Internal staff can't discover RAMS/permits to sign in nav. *WA: worker-portal links.*
7. No quote discount / no quote duplication. *WA: fudge prices / templates.*
8. Single-assignee jobs, no crew. *WA: rota.*
9. Payroll RTI filing dark + estimates. *WA: bureau/Basic PAYE Tools.*
10. Import gaps (price-book/assets/opening-balances/safety-docs). *WA: manual entry.*
11. No live payments (Stripe dark). *WA: offline invoicing (acceptable for #1).*
12. Verify Supabase Auth SMTP for login/reset (bypasses Resend). *WA: config.*

**P2/P3:** Reviews oversold; no duplicate-customer guard; CIS not job-linked; corp-tax omits payroll wages; accounting CSV sales-only; perf waterfalls; no field emergency card; feature flags global-only; `/admin/ops` 8/45 crons; no failed-email requeue; console-only logs; no form-draft autosave; credit-notes/refunds NOT-BUILT; hard customer/job delete no restore.

---

## Workflows requiring DB intervention (supportability)
Void/correct an **issued invoice**; **cancel a job**; edit a **raw timesheet entry**; per-org **feature-flag toggle**; **requeue a permanently-failed email**; restore a hard-deleted customer/job. These are the routine corrections that currently need Supabase access — the top supportability fix set.

---

## Scenario tally
- **Total test cases executed:** ≈21,500 (unit 10,893 · security 8,146 · integration 2,307 · e2e 158)
- **Passed:** ≈21,394
- **Failed:** **3 — all environment artifacts, zero real product defects** (2× `xml-crypto` load in the DARK SSO path; 1× Docker clock-skew flake)
- **Blocked/skipped:** ≈152 (dark-provider/flag-gated integration files + 10 e2e conditional skips)

## Verdict

**YELLOW-GREEN** — safe for a hand-held, high-touch design-partner customer #1. Unchanged from the readiness audit, now **corroborated by a full automated E2E run with zero real product failures** and a healthy production. Production being restored + Sentry now live in prod are net improvements; the confirmed P1s remain (all with concierge workarounds).

- **No P0.** No cross-tenant breach, no pay leak, no financial-calc error, no data-corruption path — all directly tested green.
- The gate to GREEN is the same enumerable P1 set (Money-role guard, support-correction tooling, quote→job carry, RIDDOR, cert-gating, plus config verifications).

**Would I personally onboard a paying 5–30-person UK construction company onto this exact build tomorrow?**
**YES — as a hand-held design partner**, provisioning only owner/office accounts initially (until the Money-role guard lands), with the concierge playbook and documented workarounds. **NO — as unattended self-serve.** The product is safe and genuinely capable; what's missing is self-serve billing, a few authorization/correction fixes, and construction-statutory incident logging — none of which blocks a supported first customer.

