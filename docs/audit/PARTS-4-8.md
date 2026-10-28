# CrewFlow Encyclopaedia — Parts 4–8 (Inventories, Coverage, Summary)

Companion to the master index (`00-INDEX.md`) and the per-domain detail files `01`–`11` + `PART-2-STAFF.md`. Commit `128dc5aa`, 2026-10-28.

---

## PART 4 — MASTER FEATURE INVENTORY

One consolidated row per product domain. "Pages" = documented page/route sections; "Controls" = tabulated control/feature rows in that file. Status is the domain's centre of gravity (per-item status is in the file).

### Owner / Staff product (Part 1)

| # | Domain (file) | Audience | Pages | Controls | Centre-of-gravity status | Dark/flagged within |
|---|---|---|---|---|---|---|
| 01 | Home · My day · Inbox · Notifications · Mobile | owner+staff | 11 | 69 | IMPLEMENTED; worker-portal/offline LIVE | Inbox comms (provider-dark) |
| 02 | Sales · Customer portal | owner (portal=customer) | 33 | 111 | mostly LIVE | Portal "Pay now", AI Quote Writer, lead AI summary |
| 03 | Projects / Jobs | owner+staff | 15 | 102 | IMPLEMENTED | Public Jobs API, calendar push |
| 04 | Site & Safety | owner+staff | 37 | 210 | IMPLEMENTED; blueprints LIVE | Weather (no vendor key); zero AI |
| 05 | People / Payroll | owner (pay admin-only) | 10 | 36 | IMPLEMENTED | RTI/FPS filing, rota calendar push, `/api/v1/staff` |
| 06 | Money / Finance | owner/admin | 12 | 61 | LIVE (invoices/costs/CIS/payments) | 6 integrations dark (email, HMRC, accounting, portal-pay, banking, AI) |
| 07 | Operations | owner/admin | 46 | 139 | mostly LIVE | Merchants, telematics, maintenance-reminders |
| 08 | Settings · Onboarding · Account | all (admin-heavy) | 29 | 139 | mixed | SSO/SCIM, marketplace, GDPR-erasure, self-serve billing, 6 integrations |
| — | **Owner/Staff subtotal** | | **193** | **867** | | |

### CrewFlow HQ (Part 3)

| # | Domain (file) | Pages | Controls | Status | Notes |
|---|---|---|---|---|---|
| 09 | HQ core / control plane | 18 | 31 | IMPLEMENTED | Autonomous-apply family DARK; controls record state only |
| 10 | HQ growth + AI employees | 19 | 39 | IMPLEMENTED; many boards deterministic | No AI employee acts autonomously; Outreach draft-only; Receptionist voice dark |
| 11 | HQ customers / billing / ops | 13 | 48 | IMPLEMENTED; billing partial | Stripe automation dark; dangerous controls safeguarded |
| — | **HQ subtotal** | **50** | **118** | | |
| — | **GRAND TOTAL** | **~243** | **~985** | | |

(Counts reconcile to `_coverage-raw.md`; some domains document detail sub-routes within a parent section, so route-file count ≥ page-section count.)

---

## PART 5 — COMPLETE BUTTON & ACTION INVENTORY

**The exhaustive, per-control tables live in `01`–`11`** (one `| Button/Control | Where | What happens | Required info | Result | Status |` row per control). This part is the consolidated view and, critically, the **buttons ≠ server-actions ≠ API-handlers** reconciliation the brief demanded.

### 5.1 What "button" means here (control classes catalogued)

Every auditor was required to tabulate not just primary buttons but: **three-dot / overflow menus, nested dropdowns, modal action buttons, icon buttons, tabs, toggles/switches, checkboxes, filters, search bars, sort controls, status selectors, calendar navigation, pagers, confirmation-dialog buttons, and mobile-only controls.** ~**985** such rows are tabulated across the domain files.

### 5.2 Buttons are NOT the server/API surface

- **~571 server actions** (158 `"use server"` files) and **147 API route handlers** exist. These are the *plumbing behind* buttons, not buttons. They are **not** counted in the ~985.
- We used them the other way round — to find **orphans** (plumbing with no button) and **dead buttons** (buttons wired to nothing). Per-domain button tables map each button to its handler with `path:line`.

### 5.3 Orphaned server actions / params (plumbing with NO user-facing button)

| Item | File:evidence | Note |
|---|---|---|
| `clockIn` `gps_lat`/`gps_lng` params | `/me` (`01`) | No UI control captures geolocation |
| `upsertStaffNiNumber` / `canonicaliseNiNumber` | `lib/staff/secrets.ts` (`05`) | **Zero callers** — no UI/import to set NI, yet NI shows on payslips/CSV |
| `deleteFuelLog` | fleet (`07`) | Complete server action, no UI caller; `createFuelLog` `return_to=fuel`/`driver_id`/`notes` never populated |
| `updateNoteAction` | `admin/notes/actions.ts:769` (`09`) | POST-reachable, allowlist-gated, no UI button |
| `assignAlert` | `admin/alerts/actions.ts:1266` (`09`) | POST-reachable, allowlist-gated, no UI button |
| Dark HQ roster runners | `server/services/hq-*-exec-runner.ts` (`10`) | CFO/COO/HR/legal/security/devops runners — cron/pipeline only, no UI |

### 5.4 Dead-ends / no-op controls (button exists, does little/nothing)

| Control | File | Behaviour |
|---|---|---|
| Report "decisions we need from you" | `02` | Display-only; no response control; Overview nudges it anyway |
| Permits dashboard `?filter=` link | `04` | Lands unfiltered (no-op param) |
| Staff-list row checkboxes | `05` | Inert (no bulk action wired) |
| Settings → Members add/remove | `08` | Placeholder — read-only roster, no invite/remove |
| Webhook "rotate secret" | `08` | Not a real rotation (delete+recreate, loses history) |
| Fleet "Log a fill" | `07` | Links to the register, not a fuel-entry form |

### 5.5 Side-effect-bearing controls (what fires on success — for the "Result" column at a glance)

- **Email (Resend, live only with key):** invoice Send/Remind, CIS statement, report subscription, leave request/decision, site-report publish-to-portal, quote send, review request, HQ notifications "Requeue", `/admin/demos` promote (creates auth user+org+invite), resend invite.
- **In-app notifications (DB trigger):** checklist-assign, leave events, approvals.
- **Automation events:** `job.completed` (dispatches), `payment.recorded` (ships `enabled:false`).
- **Payment:** invoice "record payment" → atomic `allocate_payment` RPC (+10s dedupe). Stripe SaaS checkout at onboarding (`app/payment/*`). Portal "Pay now" is **dark**.
- **AI (governed):** expense/import OCR, AI insights narrative, AI question box, AI Quote Writer, shared-memory semantic search, saga decomposition — most **dark** pending inference tier/vendor creds.
- **No SMS anywhere** in the owner/staff product.

---

## PART 6 — FEATURE FLAGS, HIDDEN & INCOMPLETE FUNCTIONALITY

### 6.1 Feature-flag reality in production

Verification: `lib/env.ts` defaults + `docs/launch/PRODUCTION-ACTIVATION-MATRIX.md` + the `/api/health` capability probe (email on, SMS off, WhatsApp on, missed-call-textback off, weather unavailable, API-keys implemented/15 endpoints). Direct prod env enumeration was **not** available (checkout not Vercel-linked) — recorded as a limitation.

**ON in prod:**
- `FEATURE_ENTERPRISE_SSO` — on at platform level, but **per-org off everywhere** (SSO/SCIM return 401, not 404).
- `FEATURE_MFA_ENFORCEMENT` — on but **inert** (no self-serve UI; enforcing needs a raw `organizations.require_mfa` write).
- `NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS`; VAPID web-push; Stripe **SaaS** checkout (approval-gated, no flag); Resend email; WhatsApp inbound (built; real inbound still Meta-blocked per prior work).

**OFF / dark in prod:** `FEATURE_PUBLIC_API_JOBS`, `FEATURE_MARKETPLACE` (routes `notFound()` while dark), `FEATURE_GDPR_ERASURE`, `FEATURE_RETENTION_PURGE`, `SELF_SERVE_BILLING`, `CALENDAR_CONNECT`, `ACCOUNTING_CONNECT`, `HMRC_CONNECT`, `BANKING_CONNECT`, `MERCHANTS`, `TELEMATICS_CONNECT`, `PORTAL_PAYMENTS`, `MICROSOFT_SSO`, `ACCOUNT_LINKING`, `VOICE_INBOUND`, `FEATURE_HQ_AUTONOMOUS_APPLY` (+ `CREWFLOW_EXECUTOR_APPLY`, `CREWFLOW_HQ_APPLY_ON_APPROVAL`, `CREWFLOW_EXECUTOR_SHADOW`). Automations has no master flag but forces `delay`/`ai_decision`/`webhook` workflow nodes to draft. `CH_BULK_IMPORT_ENABLED` absent (importer dark).

All dark paths use **two-switch discipline** (flag **and** credential, refuse-before-fetch) and honestly render "Off/unavailable" — none fakes a result (product-truth upheld).

### 6.2 Built-but-dark capabilities (code complete, gated off)

Owner/staff: online portal payments; AI Quote Writer; lead AI summary; expense/import OCR; AI insights narrative + question box; HMRC MTD filing; accounting push; open-banking; calendar sync; marketplace; public Jobs/Leads/Staff API; GDPR erasure + retention purge; self-serve billing; Microsoft SSO; account linking; weather forecasts; payroll RTI/FPS; rota calendar push; merchant PO EDI; telematics; maintenance reminders; missed-call text-back.
HQ: autonomous apply/execute (whole family); most AI-employee generative legs; AI Receptionist **voice/telephony** (schema exists — `phone_numbers`, mig 20261098 — provider dark); Outreach send path (draft-only); finance/analytics LLM narratives (deterministic placeholders today); Stripe billing automation.

### 6.3 Hidden / not-in-navigation routes (reachable, undocumented in menus)

| Route | What it is | File |
|---|---|---|
| `/activity` | full audit-log page | 01 |
| `/qa` | internal guided-flows / QA reference (member-reachable by URL) | — (orchestrator recon) |
| `/a/[token]` | asset **QR-scan landing** (active-org-scoped) | 07 (assets) |
| `/staff/rota/generate`, `/staff/rota/conflicts` | rota solver + conflict detector (read-only) | 05 |
| `/health-safety/worker-links`; `/quality/ncrs*`, `/quality/templates*` | H&S worker links; NCR + ITP template sub-pages | 04 |
| `/jobs/[id]/variations/new`, `/timeline`, EOT-pack PDF | job sub-surfaces with no tab | 03 |
| `/reports/ageing`, `/reports/retention`, `/expenses/budgets` | card/link-only money pages (not in report registry) | 06 |
| Many Operations sub-routes | assets holdings/inspections/calibration/scan/templates; stock valuation/replenishment/vans/stocktake; suppliers cis/payments/performance/compare; PO matching — header/link-only | 07 |
| 8 PDF/CSV export routes (Site & Safety) + money export APIs | in-page buttons only | 04, 06 |

### 6.4 Placeholders / incomplete (visible, not fully functional)

Settings → Members (read-only roster, no invite/remove); `/settings/security` (no password-change, no session management — TOTP + recovery only); webhook secret rotation; staff-list row checkboxes; report "decisions" responder; `/assets/scan` camera (partial). **No BROKEN surface** was found on code evidence.

### 6.5 Doctrine / consistency notes (not user-facing bugs, worth a product look)

- `/stock/valuation` comments say "D1 decided (weighted-average)" while sibling stock files still say "D1 undecided" (behaviour consistent — non-posting report).
- Rota "generate" page says the solver ignores skills/certs; staff-detail page says it prefers required quals.
- Two completeness divergences from the F-1 pagination standard: `/compliance` hard `.limit(500)`, `/assets` hard `.limit(1000)` (siblings paginate) — large datasets could silently truncate.

---

## PART 7 — COVERAGE & VERIFICATION REPORT

### 7.1 Coverage math

| Surface | In codebase | Documented | Coverage |
|---|---|---|---|
| `app/(app)` page routes | 185 | all (within 147 owner/staff page-sections; detail sub-routes under parents) | **100% accounted** |
| `app/admin` (HQ) page routes | 79 | all (within 50 HQ page-sections) | **100% accounted** |
| customer-portal pages | 19 | 19 (file 02) | **100%** |
| worker-portal / offline / access-pending / auth / onboarding / payment | — | covered (01, 08) | accounted |
| API route handlers | 147 | mapped as plumbing (not buttons); flagged where dark | accounted |
| Server actions | ~571 | mapped behind buttons; orphans listed (§5.3) | accounted |
| Feature flags | ~30 | ON/OFF mapped (§6.1) | **100%** |
| Roles | 3 | matrix in PART-2 | **100%** |
| **Buttons/controls** | — | **~985 tabulated** | per-domain tables are the inventory |

Two `app/(app)` segments outside the domain partition were resolved directly: `/a/[token]` (asset QR scan) and `/qa` (internal flows reference). **No orphaned/unknown route remains.** HQ nav asserts every nav entry resolves to a live page (`flatHqNav()`), so no dangling HQ menu items.

### 7.2 What was verified vs not

- **Verified from code/DB/prod state:** route existence, role/flag gating, server-action/handler wiring, DB guards (RLS, triggers, RPC), the autonomous-apply dark lock (test-pinned), `ai_cost_window` HQ-only (migration), prod migration tip, `/api/health` capabilities.
- **NOT verified (honest limitation):** no authenticated multi-role **browser click-through**. Therefore the dominant status is **IMPLEMENTED, NOT LIVE-VERIFIED**. "LIVE & WORKING" was reserved for items with corroboration beyond "code exists" (e.g. worker-portal isolation, deployed money migrations). We do **not** claim 100% live coverage.
- **Unverifiable from repo:** the Supabase email/password grant toggle (affects whether password sign-in works); live third-party provider behaviour (all dark anyway).

### 7.3 Systemic finding (highest priority)

**Nav-visibility is used as the primary access boundary on many "admin" surfaces that are not role-gated server-side.** These pages call `requireOrgContext()` (any member) rather than `requireManagementRole()`. A staff user can reach them by URL; data is still constrained by **RLS** and destructive mutations still **re-check** owner/admin, so this is an **inconsistency / defence-in-depth gap**, not a reproduced breach. Instances: entire Site & Safety domain (04), `/reviews` (02), `/inbox*` (01), rota generate/conflicts (05), most Operations routes (07). Two likely-unintended **member-open mutations**: inspection-template publish/archive and `recordSupplierBill` (07). Contrast: Money (06) and Staff/Payroll (05) are correctly page-gated. *Reported for a product/security decision — no change made.*

### 7.4 Orphans, dead controls, duplication

- Orphaned plumbing / params: §5.3. Dead/no-op controls: §5.4.
- **Duplication:** the blueprints/drawings markup subsystem appears both under Site & Safety "Drawings" (04) and `/jobs/[id]/blueprints/*` (03) — same components, job-scoped vs library-scoped; deduplicated in the button tables by noting context.
- "One money engine" is upheld — budget/programme/valuation writes never post to `finances`; the only finances-posting paths are invoice payments, cost entry, and `recordSupplierBill` (03, 06, 07).

### 7.5 Unresolved gaps (explicitly not verified / open questions)

1. Live behaviour of every flow (browser pass) — out of scope.
2. Intended policy on the nav-gate vs server-gate surfaces (§7.3) — needs owner decision.
3. NI entry path (none exists) vs NI appearing on payslips (05).
4. Supabase password-grant toggle state (08).
5. Whether the two member-open mutations (07) are intended.

---

## PART 8 — EXECUTIVE SUMMARY

**In plain English — what CrewFlow is today (commit `128dc5aa`, live on crewflow.uk).**

### What a construction company **owner** can do
Run essentially the whole business from one app: win work (leads → quotes → a customer portal), deliver it (jobs with budgets, programme, valuations, drawings with on-plan markup, certificates, variations, EOT), keep sites safe and compliant (RAMS, permits, toolbox talks, site diary, snagging, works-quality inspections, inductions, document/compliance libraries), manage people (staff, rota with an auto-scheduler, leave, and a payroll engine that now includes employer NI and pension), and run the money (invoices with void/record-payment, expenses, a cost ledger, CIS subcontractor deductions with statements, VAT/tax estimates, profit/cashflow/ageing reports, and an AI-insights surface). Operations adds assets (with PAT/LOLER/calibration and QR scanning), fleet, a guarded stock/warehouse system, materials requests, suppliers and purchase orders with GRN/3-way matching. Settings cover billing, security/MFA, SSO, integrations, API keys, webhooks, automations and data retention. **This is a broad, genuinely built ERP — not a prototype.**

### What **staff** can do
Field workers get a focused experience: "My day" (clock in/out, timesheets, assigned jobs, leave requests), open and progress jobs, run the site-and-safety field tools (toolbox talks, diary, snags, quality, drawings, site sign-in), and receive notifications. They cannot see money, sales, operations admin, pay, or settings in their menu. Sub-contract workers can use an anonymous token portal. (Important caveat in §7.3: several admin pages are hidden from staff menus but not blocked server-side — data is still protected by database rules, but the menu is not a hard wall.)

### What **CrewFlow HQ** (you) can manage
A full platform control plane: a CEO/command-centre overview, approvals and decisions, a task queue and workflow sagas, a roster of AI "employees" (sales, research, qualification, outreach, marketing, product, CTO, etc.), shared memory, an AI receptionist, and operational tooling for the customer base — organizations/signups, the company directory with activate/suspend/approve, onboarding & migration, Stripe billing, revenue/finance and usage analytics, the live **AI cost observability** dashboard, health/ops monitoring, support, and tightly-safeguarded **impersonation**. **Crucially, no AI employee acts autonomously in production** — every "apply/execute/send" path is dark or draft-only, and HQ approve/decide controls only record state.

### Built vs unfinished
- **Fully built & live:** the core owner workflows above — jobs, quoting, invoicing/payments (bank-transfer + manual), CIS, costs, H&S, staff/leave/payroll(estimate-grade), operations, the customer portal (view + bank-transfer pay), onboarding, auth, HQ control plane and cost governor.
- **Built but dark (config/credential flip to activate):** online card payments, all AI generation (quote writer, insights, OCR, narratives), HMRC/accounting/banking/calendar integrations, marketplace, public API, SSO/SCIM at org level, GDPR erasure, self-serve billing, AI-receptionist **voice**, HQ autonomous execution, weather. These are **not** advertised as available (product-truth), and each needs a credential or flag, not new code.
- **Placeholder / incomplete:** add/remove team-member UI, password-change & session-management UI, webhook secret rotation, a few no-op controls (§6.4).
- **Honest gaps:** no geolocation capture on clock-in; no offline write/queue; no UI to set a staff NI number; payroll is estimate-grade (RTI filing dark).

### Deployed vs only-in-code
Everything in this audit is **deployed** (it's on `main`/prod). The distinction that matters is **live vs dark**: a large, coherent product surface is live; a second large tranche is deployed-but-gated behind credentials/flags (Part 6).

### What a paying customer genuinely gets **today**
A working, multi-tenant construction ERP covering sales → jobs → site safety/compliance → people/payroll(estimates) → money (invoicing, CIS, costs, reports) → operations, usable on desktop and mobile web, with a customer portal (view + bank-transfer payment + proof upload). What they do **not** get until you activate it: online card payments, any AI feature, HMRC/accounting/bank automation, and voice reception. The platform is launch-capable for a founder-assisted first customer on the live surface; the dark tranche is the activation roadmap, not missing code.

---
*Read-only audit. No application code, migration, flag, or production data was changed. Per-control detail with `path:line` evidence is in files `01`–`11`; cross-cutting evidence in `_reconciliation-ledger.md`.*
