# HQ — Customers · Billing · Finance · Ops · Analytics · Support (control plane)

Audit date: 2026-10-28 · Auditor: read-only product auditor · Scope: `app/admin/` customer/billing/finance/ops/analytics/support surfaces.

**Method / limitation:** Classification is from code + known prod state only. Browser verification (authenticated multi-role prod access) was NOT performed — see `docs/audit/CONVENTIONS.md`. Default status is *IMPLEMENTED, NOT LIVE-VERIFIED* unless corroborated by a deployed migration or prod fact. Evidence cited as `path:line`.

## Access model (applies to every page below)

- **Gate:** `app/admin/layout.tsx:43` calls `requireHqPage()` → `server/auth/hq.ts:30`. Non-allowlisted = `notFound()` (404, never 403 — surface existence not leaked); anonymous = `/login`.
- **"Super-admin" = ENV allowlist** `CREWFLOW_SUPERADMIN_EMAILS` via `isSuperAdminEmail` (`server/auth/hq.ts:14-16`), NOT a DB/JWT role — cannot be an RLS policy, so the gate lives in the request path in exactly one place.
- **Defence-in-depth:** every server action and the force-dynamic pages (`finance`, `ai-costs`, `ops`, `impersonation`) re-check `isSuperAdminEmail` before acting; actions `redirect("/dashboard")` on failure. Pages that rely ONLY on the layout gate (no inline re-check): `customers`, `customers/[id]`, `onboarding`, `billing`, `analytics`, `health`, `support` — acceptable since the layout wraps all children, but worth noting none re-gate.
- **Data access:** all these surfaces read cross-tenant via `createAdminClient()` (service_role, bypasses RLS) by design — HQ sees every org.

---

### Page: Signups & intake — route `/admin/organizations` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (core intake is prod-exercised in customer-1 onboarding memory; classify conservatively).
- **Access:** super-admin only (layout gate; actions in `../actions.ts` re-check). 
- **Purpose:** Unified CEO approval board for two pre-customer stages: `demo_requests` (landing submissions) + `organizations` (completed signups).
- **What it displays:** 6 metric tiles (pending demos, demos booked, trial orgs, active orgs, MRR = active×£500, projected MRR = +trial×£500) `organizations/page.tsx:302-313`; suspended-count note; search/status/sort filters (URL-driven, `_filters`); Demo-requests list; Organisations list with status pills, owner email (resolved via paged `memberships` join), trial-days-left.
- **Feature inventory:** (1) demo intake triage; (2) org lifecycle triage; (3) estate MRR tiles; (4) F-1 paged full-estate reads (orgs, demos, owner memberships) `:148-209`; (5) search/filter/sort in URL.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Approve (demo) | demo row :470 | `setDemoRequestStatus` → status `approved`; **sends approval email** | confirm modal | demo marked approved, prospect emailed | reversible by re-flip / **email = side effect**; audit via demo row | IMPL, NOT VERIFIED |
| Mark demo booked | demo row :482 | status `demo_booked` + confirmation email | confirm | — | email side effect | IMPL, NOT VERIFIED |
| Reject (demo) | demo row :494 | status `rejected` + polite email; optional note sent to prospect | confirm + note | — | email side effect | IMPL, NOT VERIFIED |
| Approve / Start trial (org) ⚠ | org row :581,607 | `setOrganizationStatus` → `trial`; owner emailed, gains dashboard access | confirm | **grants PRODUCTION access** | reversible (suspend/cancel) | IMPL, NOT VERIFIED |
| Activate paid ⚠ | org row :594 | status → `active`; owner emailed | confirm | changes prod billing state | reversible | IMPL, NOT VERIFIED |
| Suspend ⚠ | org row :619 | status → `suspended`; owner bounced to /access-pending immediately + emailed | confirm | **locks prod workspace** | reversible (activate) | IMPL, NOT VERIFIED |
| Cancel ⚠ | org row :632 | status → `cancelled`; access revoked, owner emailed | confirm | **revokes prod access** | record stays; reversible | IMPL, NOT VERIFIED |
| Reject (org) | org row :645 | status → `rejected` + email, optional note | confirm + note | — | email side effect | IMPL, NOT VERIFIED |

(Status-change audit trail for org lifecycle lives in `../actions.ts` `setOrganizationStatus` — not re-read here; but the Customers-OS `setCustomerLifecycle` path, which overlaps, is audit-logged.)

---

### Page: Customers OS (list) — route `/admin/customers` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** layout gate only (no inline re-check) `customers/page.tsx:35`.
- **Purpose:** One row per org with the headline numbers for triage; click → `/admin/customers/[id]`.
- **What it displays:** search/subscription/setup-fee/sort filters; desktop table + mobile cards: company, owner, subscription pill, setup-fee, MRR, LTV, migration %, health score (risk-banded), last login. Data from `listCustomersForHq()`.
- **Feature inventory:** (1) estate customer directory; (2) financial headline per org; (3) health risk banding; (4) URL-persisted filter/sort; (5) deep-link to detail.
- **Buttons & controls:** navigational only (row link, "Open →", filter Apply). No mutations on this page.

---

### Page: Customer detail (Customers OS) — route `/admin/customers/[id]` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED. **Highest concentration of dangerous controls in the domain.**
- **Access:** layout gate; all mutating actions (`../actions.ts`, `_stripe-actions.ts`, impersonation action) re-check `isSuperAdminEmail`.
- **Purpose:** Full per-customer operator cockpit: identity, KPIs, lifecycle, recovery, financials, Stripe checkout, member roster, internal notes, onboarding/migration editor, CEO notes, timeline, health detail.
- **What it displays:** identity header (owner, phone, VAT, slug, ToS acceptance); 6 KPI tiles (MRR/LTV/onboarding/migration/ETA/last-login); Users roster (name/email/role/joined — **explicitly never pay data** `:481`); aggregated timeline (demo+payment+migration+support+usage, 50 cap); health reasons. `loadCustomerSnapshot(id)`.
- **Feature inventory:** (1) identity & compliance header; (2) KPI tiles; (3) Actions row; (4) Recovery actions; (5) Financials editor; (6) Stripe checkout + provisioning links; (7) Users roster; (8) internal-notes panel (shared with /admin/notes); (9) onboarding/migration editor (emits customer milestone notifications); (10) CEO notes; (11) activity timeline; (12) health detail.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Open workspace | :232 | Link to `/dashboard` (resolves via active-org cookie) | — | nav | n/a | IMPL |
| Email/Message/Call | :238-253 | `mailto:` / `tel:` links | — | opens client | n/a | IMPL |
| **Impersonate** ⚠⚠ | `_impersonate.tsx` modal → `startImpersonation` | session swap into customer workspace (see Impersonation page) | **reason required** (modal) | cross-tenant RLS access granted | reversible (Exit); **audited + HQ-broadcast** | IMPL, NOT VERIFIED |
| Suspend ⚠ | `LifecycleButton` :259 | `setCustomerLifecycle` status `suspended` + `suspended_at` | native confirm | **locks prod workspace** | reversible; audit `customer.lifecycle_suspended` `actions.ts:378` | IMPL, NOT VERIFIED |
| Cancel ⚠ | :267 | `setCustomerLifecycle` `cancelled` | confirm | **revokes prod access** | record kept; audited | IMPL, NOT VERIFIED |
| Reactivate ⚠ | :275 | `setCustomerLifecycle` `active` (clears suspended/cancelled) | confirm | unlocks prod workspace | audited | IMPL, NOT VERIFIED |
| Reset onboarding | :297 | `resetOnboarding` clears `onboarding_state` | confirm | customer checklist restarts | audited `customer.onboarding_reset` | IMPL, NOT VERIFIED |
| Mark setup complete | :309 | `markSetupComplete` stamps `completed_at` (merge-preserves state) | confirm | hides customer banner | audited | IMPL, NOT VERIFIED |
| **Resend invite** ⚠ | :321 | `resendInvite` → `supabase.auth.admin.inviteUserByEmail` | confirm | **sends real auth invite email** | audited `customer.invite_resent` | IMPL, NOT VERIFIED |
| Save financials ⚠ | form :343 | `updateCustomerFinancials` — setup-fee status, MRR, LTV override, billing email; stamps/clears `setup_fee_paid_at` | — | writes org financial columns | audited `customer.financials_updated` | IMPL, NOT VERIFIED |
| **Open setup-fee checkout (£1,000)** ⚠⚠ | :454 | `createSetupCheckout` → real Stripe `checkout.sessions.create` (payment mode) | — | **creates live Stripe customer + checkout session** | audited `stripe.checkout_created`; webhook is source of truth | IMPL, NOT VERIFIED (Stripe partial) |
| **Open subscription checkout (£500/mo)** ⚠⚠ | :463 | `createSubscriptionCheckout` → Stripe subscription session | — | **live Stripe session** | audited | IMPL, NOT VERIFIED |
| Provision Stripe products → | :427 | opens `/api/admin/stripe/provision` (route exists) | — | provisions Stripe products | not re-read; flagged | IMPL, NOT VERIFIED |
| Run integration diagnostic → | :435 | opens `/api/admin/stripe/verify` | — | read-only diagnostic | — | IMPL |
| Save progress | form :556 | `updateCustomerProgress` onboarding/migration %, stage, ETA; emits milestone notifications to customer | — | writes org + **customer notifications** | audited `customer.progress_updated` | IMPL, NOT VERIFIED |
| Save notes | form :631 | `updateCustomerNotes` (private `admin_org_notes`) | — | writes notes | audited | IMPL |
| Internal notes add/pin/archive | `_internal-notes-panel` | shared `/admin/notes` actions | — | writes `hq_internal_notes` | — | IMPL |

**Stripe status:** real SDK wired (`_stripe-actions.ts`), gated behind `STRIPE_SECRET_KEY` + price resolution; structured error codes surfaced to banner `:712-734`. Memory notes self-serve billing is partial/operator-managed. Treat as PARTIALLY IMPLEMENTED pending config + webhook proof.

---

### Page: Onboarding & migration — route `/admin/onboarding` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** layout gate only.
- **Purpose:** Cross-tenant read-only triage of every customer's migration progress; edits happen in customer detail.
- **What it displays:** 4 KPI tiles (customers filtered, imports in flight, files uploaded, failed rows); filters (q/status/stalled/sort); per-customer rows w/ migration progress bar, onboarding %, files, rows imported/failed, ETA, last upload; **expandable import drill-down** (per-import file list + committed/rolled-back status).
- **Feature inventory:** (1) estate migration triage; (2) stalled-first sort; (3) per-import file drill-down (loaded only for open row — no N+1); (4) deep-link to detail for edits.
- **Buttons & controls:** navigational only — "Edit progress →" (to detail), "Open files"/"Collapse" (expand), filter Apply. **No mutations.**

---

### Page: Billing OS — route `/admin/billing` → **
- **Status:** PARTIALLY IMPLEMENTED (operator-managed invoices live; Stripe automation NOT wired — `actions.ts:30-32` + page `:40-44` state "No Stripe automation yet").
- **Access:** layout gate; `./actions.ts` re-checks `isSuperAdminEmail`.
- **Purpose:** Per-customer revenue triage + manual invoice ledger (`billing_invoices`).
- **What it displays:** 4 filter-aware KPI tiles (MRR, outstanding, paid total, failed payments); filters (q/status/setup/outstanding-only/sort); customer rows (subscription + setup pills, failed-count badge, MRR/LTV/outstanding/paid/next-renewal/invoice-count); **expandable** invoices list + record-invoice form + next-renewal form (due-date prefilled from `settings.billing.default_invoice_due_days`).
- **Feature inventory:** (1) estate billing triage; (2) manual invoice ledger; (3) invoice status lifecycle; (4) next-renewal date; (5) org `setup_fee_status` auto-sync on setup-fee invoices; (6) customer + HQ notifications on setup-fee-paid.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Save invoice | form :379 | `createBillingInvoice` inserts `billing_invoices` row; syncs org setup_fee_status for setup kind | kind/amount/status/due/notes | writes ledger row | audited `billing.invoice_<status>` | IMPL, NOT VERIFIED |
| Mark paid | invoice row :500 | `setBillingInvoiceStatus` `paid` (**no confirm** — deemed routine); notifies on setup-fee-paid | — | flips invoice + org setup state | audited | IMPL, NOT VERIFIED |
| Mark failed ⚠ | :502 | status `failed` (customer sees failure) | confirm | customer-visible failure | audited | IMPL, NOT VERIFIED |
| Refund ⚠ | :505 | status `refunded` ("irreversible from the UI") | confirm | accounting change | **flagged irreversible**; audited | IMPL, NOT VERIFIED |
| Void ⚠ | :508 | status `void` (drops from MRR/chase) | confirm | accounting change | audited | IMPL, NOT VERIFIED |
| Save (next renewal) | form :453 | `setNextRenewal` writes `next_renewal_at` | date | writes org | audited `billing.renewal_set` | IMPL |

---

### Page: Finance AI — route `/admin/finance` → **
- **Status:** PARTIALLY IMPLEMENTED — deterministic board metrics live; **board narrative is DARK** (populates only once a model tier is bound behind the governor) `finance/page.tsx:181-195`.
- **Access:** `requireHqPage()` re-checked inline `finance/page.tsx:52`; `force-dynamic`.
- **Purpose:** Board-level money picture, honest-by-construction (every metric labelled Fact / Derived / Insufficient data with basis).
- **What it displays:** board metric cards (Fact/Derived/Insufficient badges) from `loadFinanceBoard()`; board-narrative panel (dark empty-state) ; period/generated footer.
- **Feature inventory:** (1) deterministic board metrics with provenance labels; (2) governed prose narrative (dark); (3) honest "Insufficient data" rendering (never fabricated zeros).
- **Buttons & controls:** none — read-only reporting surface. (Narrative = dark AI, no activation control here.)

---

### Page: Analytics / Executive dashboard — route `/admin/analytics` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (deterministic; health cron corroborated by memory `#542`).
- **Access:** layout gate (page not inline-gated); `./actions.ts` re-checks; `force-dynamic`.
- **Purpose:** Deterministic exec analytics across the base + health-engine control.
- **What it displays:** AI COO insights panel (deterministic bullets — "LLM-generated narrative lands later"); Revenue KPIs (MRR/ARR/growth/churn/forecast/avg-value/outstanding/lost) + 4 SVG sparklines; Customer analytics (health bands, migration, usage, highest-risk list); Benchmarking (averages + top-by-MRR/LTV/health); Health engine (cached scores + recent `health_score_events` stream); CSV + PDF export links.
- **Feature inventory:** (1) deterministic insights; (2) revenue analytics + sparklines; (3) customer/usage analytics; (4) benchmarking; (5) health-engine event stream; (6) CSV/PDF export; (7) manual health recompute.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Recompute health now | form :467 | `recomputeHealthNow` → `recomputeAllOrgs("manual")`; writes only changed scores | — | batch recompute of org health | re-runnable; audited `health.batch_recomputed` | IMPL, NOT VERIFIED |
| Export CSV | :94 | `/api/admin/analytics/export.csv` (route exists) | — | **downloads estate analytics CSV** | — | IMPL, NOT VERIFIED |
| Export PDF | :100 | `/api/admin/analytics/export.pdf` | — | downloads PDF | — | IMPL, NOT VERIFIED |

---

### Page: AI cost governance — route `/admin/ai-costs` → **
- **Status:** PARTIALLY IMPLEMENTED — measurement surface LIVE; spend figures zero while tiers dark (per-tier truth stated on page). Governor atomic reserve-then-settle corroborated (`mig 20261070`, `20261147000000`). `ai_cost_window` observability migration `20261235000000` deployed.
- **Access:** `requireHqPage()` inline `ai-costs/page.tsx:82`; `force-dynamic`; `./actions.ts` re-checks. **`ai_cost_window` rollup is HQ-only CONFIRMED:** function `execute` revoked from `public, anon, authenticated` (`supabase/migrations/20261235000000_ai_cost_observability.sql:124-125`) — reachable only via service-role (`ai-cost-report.ts:105`), itself only from this HQ-gated page.
- **Purpose:** Four-question governance: can anything spend → what spent this month vs £100/org ceiling → which orgs near/over/anomalous → which capability.
- **What it displays:** accounting-health banner (stuck-reservation probe, fail-toward-degraded); spend windows (today/week/month + by provider/model/engine); Provider-activation block (per-tier model binding, ungoverned-credential risk warning derived from pinned entry-point count); transcription self-test; This-month KPIs (committed, in-flight, invocations, failures, blocked orgs, spike flags, overrun calibration alarm); month-over-month trend; by-org table (% of ceiling incl. in-flight, spike detection); **editable budget controls**; by-feature table (every registered capability).
- **Feature inventory:** (1) observability windows; (2) activation truth per tier; (3) accounting-health probe; (4) transcription self-test (real governed path); (5) estate spend KPIs + overrun alarm; (6) spend trend; (7) per-org table; (8) per-org ceiling override editor; (9) per-employee limit editor; (10) by-feature breakdown.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| Set ceiling ⚠ | form :651 | `setOrgCeilingAction` → RPC `ai_set_org_ceiling` (clamped to hard max, audited in same txn) | org id + £ + note | per-org AI ceiling override | reversible (Clear); audited `ai_budget_control_audit` | IMPL, NOT VERIFIED |
| Clear (ceiling) | :811 | `clearOrgCeilingAction` → RPC | org id | back to default | audited | IMPL |
| Set limit ⚠ | form :721 | `setEmployeeLimitAction` → RPC `ai_set_employee_limit` | org+user id + £ | per-employee AI cap | reversible; audited | IMPL, NOT VERIFIED |
| Clear (limit) | :847 | `clearEmployeeLimitAction` → RPC | org+user | removes cap | audited | IMPL |
| Run transcription self-test | form :450 | `runTranscriptionSelftestAction` runs synthetic WAV through REAL governed STT path (HQ budget org); dark tier returns honest `deferred` | — | reservation→provider→settle→ledger; **never exposes credential** | re-runnable; audited `transcription.selftest` | IMPL, NOT VERIFIED |

**Note:** these controls EDIT the governor; they never activate a provider (no tier bound). This is the `#902` observability surface.

---

### Page: Ops / System status — route `/admin/ops` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (health DB probe + DR backup heartbeat corroborated by memory).
- **Access:** `requireHqPage()` inline `ops/page.tsx:39`; `force-dynamic`.
- **Purpose:** Single source of truth for "is the plumbing healthy".
- **What it displays:** headline traffic-light (green/amber/red + summary); env-var presence (**presence only, never values** `:82`); email queue KPIs + recent-failures details; off-platform backup (DR) status w/ age/last-run/upload + GREEN≤7d/WARN>7d/RED>10d thresholds (heartbeat is source of truth, not the Mac scheduler); cron roster grouped by family (last run/success, 7d runs/fails); recent cron-failures table; optional Sentry link. `buildOpsSnapshot()`.
- **Feature inventory:** (1) traffic-light; (2) env presence; (3) email queue health; (4) DR backup heartbeat; (5) cron health roster; (6) recent-failures; (7) Sentry deep-link.
- **Buttons & controls:** Open Sentry → (external, conditional), Open notifications → (nav). **No mutations** — pure read dashboard.

---

### Page: Customer health deep dive — route `/admin/health` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** layout gate only; `force-dynamic`.
- **Purpose:** Churn + upsell control room — per-customer health w/ deterministic next-best-action (no LLM).
- **What it displays:** 4 KPI tiles (critical/at-risk/healthy/unscored, full set); filter (band/operator-bucket) + name search; per-customer cards (band pill, health, MRR, setup fee, outstanding, last login, onboarding/migration %, active/urgent tickets, score trend) + deterministic recommendation w/ action deep-link. `listHealthDeepDive()`.
- **Feature inventory:** (1) health KPIs; (2) band/bucket filtering; (3) per-customer triage card + trend; (4) rules-based next-best-action.
- **Buttons & controls:** navigational only — recommendation link (to the relevant surface), customer deep-links, filter Apply/Reset. **No mutations.**

---

### Page: Support queue (list) — route `/admin/support` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED.
- **Access:** layout gate only (list); `./actions.ts` re-checks on every mutation; `force-dynamic`. Service-role cross-tenant read.
- **Purpose:** Cross-tenant ticket queue; click → `/admin/support/[id]` for thread + controls.
- **What it displays:** 4 KPI tiles (active, urgent active, awaiting-CrewFlow, resolved-7d — full set); filters (q/status/priority/category/sort, default "needs attention"); ticket rows (number, subject, internal-notes badge, org, status/priority/category pills, last-reply preview + direction/date). `listSupportTicketsForHq()`.
- **Feature inventory:** (1) cross-tenant queue; (2) needs-attention sort; (3) filters; (4) internal-notes indicator; (5) deep-link to thread.
- **Buttons & controls (list):** navigational (row link, filter Apply/Reset). **Mutations live on `/admin/support/[id]`** via `support/actions.ts` (not in this list page but in-domain):

| Action (support/actions.ts) | What happens | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|
| `replyAsHq` | insert `support_messages` (customer-visible or internal); customer-visible = **notifies customer** | thread reply | audited `support.hq_reply`/`internal_note` (x2 rows) | IMPL, NOT VERIFIED |
| `setTicketStatus` | status + resolved/closed stamps; notifies customer | status change | audited `support.status_changed` | IMPL, NOT VERIFIED |
| `setTicketPriority` | priority; urgent pings HQ | priority change | audited | IMPL |
| `setTicketCategory` | category | — | audited | IMPL |
| `assignTicket` | assigns/unassigns | — | audited | IMPL |
| `generateSupportReplyDraft` | enqueues + drains `support_reply_draft` task; **NEVER auto-sends** (human edits + sends) | draft artifact (governed/dark) | audited `support.reply_draft_generated` | IMPL, NOT VERIFIED (dark AI) |

---

### Page: Impersonation centre — route `/admin/impersonation` → **
- **Status:** IMPLEMENTED, NOT LIVE-VERIFIED (HQ-10 real session-swap shipped).
- **Access:** `requireUser()` + per-action `isSuperAdminEmail` re-check; `force-dynamic`.
- **Purpose:** Drop into a customer workspace and see what they see; team-wide active-session view + kill switch.
- **What it displays:** "you are impersonating X" red banner (if active); start-new form (customer picker — F-1 paged full org list, required reason); active sessions across team (w/ force-end); recent history (audit log, 50).
- **Feature inventory:** (1) start impersonation; (2) exit own session; (3) force-end any session (kill switch); (4) active-session visibility; (5) audit history.
- **Buttons & controls:**

| Button/Control | Where | What happens | Required info | Result | Reversible?/Audit? | Status |
|---|---|---|---|---|---|---|
| **Start impersonating** ⚠⚠ | form :174 (+ customer-detail modal) | `startImpersonation`: ends any existing session, writes `impersonation_sessions`, sets httpOnly `cf_impersonation_session` cookie (24h cap), purges route cache, redirects to /dashboard | **reason ≥3 chars required** + ClientConfirm | **grants temporary cross-tenant RLS access** to prod customer data | reversible (Exit, 24h auto-expire); **audited `impersonation.started` + loud HQ notification** | IMPL, NOT VERIFIED |
| Exit impersonation ⚠ | form :125 | `endImpersonation`: deletes cookie, ends row, purges cache | — | returns to HQ | audited `impersonation.ended` (w/ duration) | IMPL |
| **Force end** ⚠ | form :208 | `forceEndImpersonation`: ends ANOTHER operator's session immediately | confirm | their cross-tenant access stops | audited `impersonation.force_ended` | IMPL, NOT VERIFIED |

**Safeguards (strong):** cookie carries only session id; every load re-validates row + allowlist (`impersonation.ts:76-96`); cookie holder must match `admin_email` (no cross-operator cookie sharing); hard 24h cap (fail-closed); access enforced via `current_org_ids()` RLS predicate so Exit is instant revocation; start is broadcast to whole HQ. Non-super-admins always get `null` even if they forge the cookie.

---

### Route: Switch to customer — route `/admin/switch-to-customer` → **
- **Status:** IMPLEMENTED (route handler, `runtime=nodejs`).
- **Access:** `requireUser()` + `isSuperAdminEmail` (`switch-to-customer/route.ts:33`).
- **Purpose:** Resolver link, not a control: active impersonation → `/dashboard`; otherwise → `/admin/customers` to pick one. Deliberately NO self-org shortcut (impersonation is the only path into a customer workspace).
- **Buttons & controls:** none (GET redirect only). Not a mutation; not dangerous on its own (relies on an already-granted impersonation session to reach customer data).

---

## DOMAIN SUMMARY

**Pages audited:** 13 (12 `page.tsx` + 1 route handler). Plus in-domain action files: `customers/actions.ts`, `customers/[id]/_stripe-actions.ts`, `billing/actions.ts`, `ai-costs/actions.ts`, `analytics/actions.ts`, `support/actions.ts`, `impersonation/actions.ts`.

**Status tally:**
- IMPLEMENTED / IMPL-NOT-LIVE-VERIFIED: 9 pages (organizations, customers list, customer detail, onboarding, analytics, ops, health, support, impersonation, switch-to-customer).
- PARTIALLY IMPLEMENTED: 3 (billing — no Stripe automation; finance — narrative dark; ai-costs — tiers dark / measurement-only).
- Pure read dashboards (no mutations): onboarding, finance, ops, health, customers-list, support-list, switch-to-customer.

**Dangerous / sensitive controls (with safeguards):**
1. **Impersonation start / exit / force-end** (`impersonation/actions.ts`, customer-detail modal) — grants cross-tenant RLS access to PROD data. Safeguards: mandatory reason, confirm, httpOnly cookie, server re-validation every load, email-match, 24h fail-closed cap, instant `current_org_ids()` revocation, audit + HQ broadcast. Strongest-safeguarded dangerous path.
2. **Org/customer lifecycle: Suspend / Cancel / Activate / Approve / Reject** (`organizations/page.tsx`, `customers/actions.ts`) — change PROD workspace access + send customer emails. Safeguards: confirm modals, audit rows (`customer.lifecycle_*`), reversible.
3. **Stripe checkout: setup-fee £1,000 / subscription £500/mo + Provision products** (`_stripe-actions.ts`, `/api/admin/stripe/provision`) — create LIVE Stripe customers/sessions. Safeguards: gated on `STRIPE_SECRET_KEY`, price resolution, structured errors, audit `stripe.checkout_created`, webhook = source of truth. No confirm on the checkout buttons themselves (they open hosted Stripe, so the real charge is confirmed by the customer in Stripe).
4. **Billing invoice flips: Mark failed / Refund / Void** (`billing/actions.ts`) — customer-visible / accounting changes. Safeguards: confirm (except "Mark paid"), audit, Refund explicitly flagged irreversible.
5. **Resend invite** (`customers/actions.ts`) — sends real Supabase auth invite email. Safeguard: confirm + audit.
6. **AI budget controls: Set ceiling / Set employee limit** (`ai-costs/actions.ts`) — change spend governance. Safeguards: hard-max clamp + audit in same RPC txn; never activate a provider.
7. **Analytics CSV/PDF export** — estate-wide financial/customer data egress. No confirm; HQ-gated only.

**Hidden / undocumented functionality & internal-only surfaces:**
- `ai_cost_window` service-role-only rollup, correctly HQ-walled (grants revoked from anon/authenticated) — confirmed HQ-only as the brief asked.
- Finance board narrative + analytics "AI COO insights" are deterministic placeholders explicitly labelled "LLM lands later"; honest-by-construction, not misrepresented.
- Transcription self-test runs the REAL governed STT path (dark tier returns honest `deferred`) — an internal ops diagnostic, not production-wired STT (no telephony).
- `support/[id]` holds the actual support mutations (reply/status/priority/category/assign/AI-draft); the `/admin/support` list page is read-only.

**Internal tools not production-ready / dark:** Billing Stripe automation (operator-managed only; webhooks "land later"); Finance board narrative (dark); AI cost tiers (dark — spend figures zero by construction); support AI draft (governed/dark, never auto-sent).

**Orphaned routes / server-actions with no UI:** none found in-domain. All actions are wired to visible controls. `switch-to-customer` is a resolver with no UI of its own (intentional). The HQ-3.0 `logImpersonationAttempt` stub was deleted (`customers/actions.ts:393-396`) after HQ-10 superseded it — clean.

**Access-gate observation:** `customers`, `customers/[id]`, `onboarding`, `billing`, `analytics`, `health`, `support` (list) do NOT re-check `isSuperAdminEmail` inline — they rely solely on the layout `requireHqPage()`. All *mutating actions* do re-check (defence-in-depth), so this is low-risk, but the read pages' sole reliance on the layout gate is worth recording.
