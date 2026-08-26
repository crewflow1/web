# First-Customer Release Blockers — targeted hardening ledger

Branch `first-customer/release-blockers` off `8784cd0b`. Scope = the FOUR minimum fixes to move CrewFlow YELLOW-GREEN → GREEN for customer #1. No broad wave; no dark-provider activation; do not regress the proven foundations (tenant isolation, comp privacy, VAT/CIS/payroll, job costing, stock, offline, mobile).

## Rule Zero (verified 2026-08-26 ~00:27 UTC)
- origin/main **8784cd0b** · production **8784cd0** · health **healthy** · db **ok**
- migration parity **378/378**, tip **20261218000000**
- dark providers: email only (sms/whatsapp/weather false) — none activated
- open PRs: 6 dependabot only (840–845), none conflicting
- Sentry live in prod (`monitoring.enabled:true`)

## Intended permission model (from `app/(app)/_nav/nav-model.ts` — the product's own declared intent)
- **Sales** group (`/leads /quotes /customers /price-book`) → `ADMIN_ROLES` (owner/admin)
- **Money** group (`/cash /invoices /payments /expenses /finances /cis /tax /reports`) → `ADMIN_ROLES`
- **Operations** group (`/suppliers /purchase-orders /stock /fleet /assets /materials …`) → `ADMIN_ROLES`
- **Projects** (`/jobs …`) → `ALL_ROLES` (staff included); Job templates admin-only
- **People**: group ALL_ROLES but Staff/Rota/Payroll admin-only; `/me` staff
- **Site**: group ALL_ROLES; RAMS/permits/site-reports/documents admin-only; toolbox + site-compliance staff-reachable
The backend must enforce this same boundary (nav-hiding is not enforcement).

---

## FIX 1 — Central Money authorization
**Root cause:** no central role guard; money pages/APIs relied on `requireOrgContext()` (any member) + member-wide RLS, so `staff` could reach Sales/Money surfaces by direct URL/API/Cmd+K and create invoices/expenses. In-org over-exposure (not cross-tenant, not comp leak).
**Design:** central helpers in `server/auth/session.ts` reusing existing `owner|admin` authority — `isManagementRole` / `requireManagementRole` (page redirect → /dashboard?error=forbidden, same UX as existing requireAdmin) / `requireManagementContext` / `requireManagementApi` (JSON 403 for fetch/XHR).
**Applied (status: DONE, tsc 0):**
- **Segment guard layouts** (cover list + [id] + new + every nested tab; un-bypassable by URL): `invoices, quotes, finances, expenses, leads, customers, reports, payments, cis, price-book` (10 layouts).
- **List pages** additionally guard inline: invoices, quotes, leads, customers, finances, expenses (`/cash`/`/tax` already gated; left as-is).
- **APIs → 403:** `/api/reports` GET, `/api/reports/export` GET (revenue/VAT/top-customers CSV), `/api/finances` GET+POST, `/api/invoices` GET+POST.
- **Server actions:** all 11 org-facing quote actions (create/update/send/approve/review/delete/ownerAccept/ownerDecline/variation/EoT×2) + 3 expense actions gated; public token actions untouched (separate authority).
- **Cmd+K/search:** `MANAGEMENT_ONLY_SEARCH_TYPES = {customer, quote, invoice, lead, purchase_order}` filtered from hits for non-management at both return points; staff keep jobs/documents/snags/site-reports/RAMS/permits/staff.
- **Not gated (deliberate):** suppliers/purchase-orders/stock/assets pages (Operations group; ops-data not money; out of the four-fix scope — POs reachable read-only by staff carry supplier pricing, noted for reviewer A), staff page (roster names only, pay RLS-protected).

## FIX 2 — Invoice void + Job cancellation (status: DONE, adversarially SQL-tested)
- **Migration `20261219000000_invoice_void.sql`:** enum +`void`; `voided_at/voided_by/void_reason`; trigger `tg_invoices_void_guard` — refuses paid/partially_paid AND any row in invoice_payments (credit-note territory, deliberately unsupported + documented), requires reason, stamps voided_at itself, terminal; `tg_invoice_payments_refuse_void` blocks money landing on a void invoice. **Financial effect by construction:** every authority (ISSUED_, OUTSTANDING_, OVERDUE_COLLECTABLE_) is a positive allowlist → void drops out of revenue/receivables/ageing automatically; cash-VAT unaffected (void impossible once payments exist).
- **Migration `20261220000000_job_cancelled.sql`:** jobs CHECK + `cancelled`; `cancelled_at/by/reason`; trigger — completed→cancelled REFUSED, reopen only cancelled→new (audit fields cleared), stamps timestamp.
- **Local adversarial SQL tests (9/9):** void-no-reason ✗, void-with-reason ✓+stamp, un-void ✗, pay-void-invoice ✗, void-with-payments ✗ (payment trigger still auto-set partially_paid — coexistence proven); cancel ✓+stamp, completed→cancel ✗, cancelled→in-progress ✗, reopen→new ✓+cleared.
- **App:** `voidInvoice` action (management-gated, org-pinned, trigger-refusals surfaced as friendly banners) + void form/banner on invoice detail; jobs schema + form + labels/styles gain `cancelled`; `/me` My-jobs excludes cancelled; calendar default excludes cancelled (explicit filter can still show); `updateJob` surfaces the trigger's human-readable refusal verbatim. Pre-regen `as never` bridges at 4 sites (documented; removed post-deploy regen).

## FIX 3 — Supabase Auth SMTP (status: STOPPED — CEO manual step required)
- Programmatic read-only verification is NOT possible with available credentials: CLI v2.98 has no auth-config read (only `config push`, a write — refused); the management API GET returned 401 with the keychain credential; no `SUPABASE_ACCESS_TOKEN` in env. No secrets printed.
- **Behavioural evidence:** magic-link login works in production today (real users sign in) → the channel functions at LOW volume. Staff invites bypass this path entirely (generateLink + Resend).
- **EXACT MANUAL STEP (CEO):** Supabase Dashboard → project `jzntbskdqdopzwdqwvkp` → Authentication → Emails/SMTP Settings → confirm **Enable Custom SMTP** is ON with the production sender (recommended: Resend SMTP — host `smtp.resend.com`, port 465, username `resend`, password = a Resend API key, sender e.g. `noreply@crewflow.uk` on the verified domain). If it is OFF, Supabase's built-in sender (~2–4 emails/hour) is the limit — acceptable for one hand-held design partner, not beyond. No provider switch, no new spend (Resend already live for transactional email).

## FIX 4 — Quote → Job data carry (status: DONE)
- Old: accepted quote → job with only org/customer/status + notes blob (site/scope/value dropped).
- New: `buildJobCarryFromQuote` (best-effort, failure-degrades to bare provenance): carries **site** (quote.property_id → properties.address → jobs.site_address_line1; property-less quotes already resolve to the customer address at render via `resolveJobAddress`) + **scope** (line-item DESCRIPTIONS, never prices, into notes). **Value stays un-duplicated by design** — provenance is the `quotes.job_id` backlink (already stamped) + the auto-invoice's `job_id`; the job workspace derives revenue from those. Applied to BOTH accept paths (owner + public token; admin client org-pinned). Conversion idempotency unchanged (job created only when `!quote.job_id`).

## Test updates (all extend, none weaken)
- New real-PG integration suite `__tests__/integration/invoices/void-and-job-cancel.test.ts` (4/4): void-requires-reason, trigger-stamped, terminal, no-pay-on-void, refuse-void-with-payments (even from stale status; payment-sync coexistence proven), allowlist exclusion, cancel+stamp, completed→cancel refused, reopen-only-to-new + audit cleared.
- `overdue-authority`: the old "there is no 'void'" pin replaced by its own prescribed successor ("if added it must join NON_COLLECTABLE") — now asserts void EXISTS and IS non-collectable; `void` added to `OVERDUE_NON_COLLECTABLE_STATUSES` keeping the partition exact.
- Session-module mocks extended with faithful `requireManagementRole`/`requireManagementApi` mirrors (approval-workflow, accept-quote-by-token, create-variation-eot, reports/export, expense-draft-reject-gate).
- `reports/export` source-pin STRENGTHENED: now requires `requireManagementApi()` and forbids bare `requireOrgContext()`.
- `active-org-list-scoping` CAPTURES_CTX widened to accept the strictly-stronger management-guard capture form.
- F-1 guards: 13 allowlist keys re-keyed to shifted lines (same justifications); ONE new BOUNDARY_ALLOWLIST entry (quotes/actions.ts:99 — the 50-line scope-summary sample, reason written).
- Loud-read shape ledger: app/(app) discard 56→58 (+2 = the two deliberate best-effort carry reads; ledgered in docs/loud-read-failures.md per the UP rule).
- e2e fixture: global-setup listUsers perPage 1000 (seed user fell past the default-50 page on an accumulated local stack; fixture-only).
- NEW `e2e/cross-browser-critical.spec.ts` — engine-portable critical journeys for the WebKit/Firefox matrix.

## Local gates (branch, post-changes)
- typecheck 0 · lint 0
- unit **10906/10906** · security **8146/8146**
- integration (real PG) **2214 passed / 96 env-skipped / 1 pre-existing local clock-skew flake** (site-compliance visitor; green in CI; documented since Wave A.5)
- production build ✓ compiled
- chromium e2e + WebKit/Firefox critical matrix: (below)

## Adversarial review cycle (4 reviewers — round 1 all found real blockers; all fixed)
- **A (security) round 1: DO NOT DEPLOY** — 11 staff bypasses (mostly pre-existing ungated API twins: invoices/finances exports, invoice [id] PATCH/pdf/send/remind, quotes pdf/send, customer statement, /tax page + quarterly-pdf, /insights + ai endpoints, payment actions, bank-reconcile actions) + my finances gate BROKE the documented staff cost-entry flow. **All fixed:** ~12 routes → requireManagementApi; ~30 actions → requireManagementRole (payments, allocate, customers×5, price-book×8, leads×8, proof-actions); /tax + /insights pages gated; **cost entry design restored** (finances layout deleted, /finances/new + POST member-open, list/GET management-only). Round 2: one residual (/api/ai/question) → fixed. 
- **B (financial) round 1: DO NOT DEPLOY** — void still counted in job/P&L revenue (compute + 6 feeders), accounting export, customer portal (incl. a Stripe-stranding path), retention base. **All fixed:** isRevenueRow in compute (computeJobProfitability, profitByMonth, totalProfitThisMonth) + status threaded through every feeder; export + portal query filters; checkout GUARD refuses void; UNCERTIFIED={draft,void}; billing netting; send/remind/cron refuse void; **race closed** (payments trigger FOR SHARE). Round 2: two residuals (commercial-page map stripped status; month tile) → fixed.
- **C (domain) round 1: DO NOT DEPLOY** — properties.address is JSONB (carry threw + silently killed scope too); notes 10k > form 5k cap (edit lockout). **Fixed:** JSONB compose (line1,line2,city,postcode → 200-cap), separate try blocks, 5000-cap. Round 2: **SAFE TO DEPLOY** (residual non-blocking: openapi create-input still advertises cancelled; noted).
- **D (UX) round 1: NOT GREEN** — staff "+ Add cost" broken; void refusals rendered nothing. **Fixed:** cost entry restored (traced end-to-end); invoice page renders banners for all 5 void codes (1:1 mapping verified). Round 2: **GREEN FOR DESIGN PARTNER**.
- Also closed from review: born-cancelled (DB BEFORE INSERT refusal + edit-only form option + API 400 refine + createJob verbatim error), openapi jobs enum truthful, SDKs regenerated.

## Final review verdicts (round 2/3)
- **A security: SAFE TO DEPLOY** (last residual /api/ai/question gated; boundary complete; no over-gating; token flows untouched)
- **B financial: SAFE TO DEPLOY** ("no surface remains where a void invoice counts as money or reaches a customer")
- **C domain: SAFE TO DEPLOY** (carry works end-to-end incl. property-linked; caps aligned; born-cancelled closed at DB+API+UI)
- **D UX: GREEN FOR DESIGN PARTNER** (cost entry traced working; void banners 1:1 with action codes)
- Deferred non-blocking (backlogged): openapi create-input still lists cancelled (advisory-only, dark API); staff can't self-correct a mis-keyed cost (owner fixes); /api/activity metadata sweep; silent forbidden bounce; dead cancelled_by/cancel_reason writers; dashboard jobsThisWeek counts cancelled; import "cancelled"→"new" coercion; stale comments.

## Final local gates (branch tip)
- typecheck 0 · lint 0 · unit **10906/10906** · security **8146/8146**
- integration (real PG) **2214 passed / 96 env-skipped / 1 pre-existing clock-skew flake** (green in CI)
- production build ✓ · **chromium e2e 153/0** (10 conditional skips)
- **Cross-browser critical matrix: chromium 7/7 · WebKit 7/7 · Firefox 7/7** (home render, login form, auth-wall redirect+destination, money-surface auth wall, quote-portal fail-closed, worker-portal fail-closed, 375px no-overflow) — via `playwright.matrix.config.ts`
- e2e fixture fixes: 3× `listUsers` pagination (default-50 page missed seed users on an accumulated local stack)

## Deploy
(appended at release)
