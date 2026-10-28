# Reconciliation ledger (orchestrator working notes — not the deliverable)
Tracks cross-cutting findings from each domain auditor for Parts 6/7/8. main 128dc5aa.

## Domain files received
- [x] 01-owner-home-inbox-mobile.md (A1)
- [ ] 02-sales-and-portal.md
- [x] 05-people-payroll.md (A5)
- [ ] 03-projects-jobs / 04-site-and-safety / 06-money-finance / 07-operations / 08-settings / 09-hq-core / 10-hq-growth-ai / 11-hq-customers-billing-ops

## Orphaned / not-in-nav routes
- /activity (full audit log; bell-dropdown only) [A1]
- /staff/rota/generate, /staff/rota/conflicts (rota solver/conflicts; header-linked, not nav; only requireOrgContext) [A5]

## Orphaned server params / dead capabilities (NOT buttons)
- /me clockIn gps_lat/gps_lng — no UI control captures geolocation [A1]
- lib/staff/secrets.ts upsertStaffNiNumber/canonicaliseNiNumber — ZERO callers; no UI/import to set NI [A5]

## Dark / provider-gated (Part 6)
- Inbox comms (sendInboxReply queues, never sends w/o provider); inbound capture + WhatsApp review depend on dark telephony [A1]
- Payroll RTI/FPS filing dark (prepared, never submitted) [A5]
- /api/v1/staff behind FEATURE_PUBLIC_API_JOBS [A5]
- rota calendar push dark [A5]

## Permission / authz notes (Part 2 matrix + Part 7)
- /inbox* : nav=owner/admin but page only requireOrgContext (staff could URL-nav to customer comms; RLS treats inbound_enquiries member-readable) — confirm policy [A1]
- /staff/rota/generate|conflicts: only requireOrgContext, not page-admin-gated (read-only; linked from admin UI only) [A5]
- Pay visibility: staff_compensation RLS self-or-admin; NI in staff_secrets admin-only; payroll org-pinned in-statement [A5]

## Memory/doc corrections
- STALE: "payroll estimates only / no employer NI+pension" — now modelled (migs 20261142/20261155); margins no longer understated [A5]
- Doc inconsistency: rota generate page says solver ignores skills/certs; staff detail says it prefers required quals [A5]

## Side-effects inventory (for Part 5 result column)
- Leave: createLeaveRequest emails owners/admins; reviewLeaveRequest emails requester (+ in-app notif) [A5]

## [A11] 11-hq-customers-billing-ops.md — RECEIVED
Dangerous HQ controls (all with safeguards): impersonation (reason+confirm+httpOnly+per-load revalidate+email-match+24h cap+audit+broadcast); org lifecycle Suspend/Cancel/Activate/Approve/Reject (confirm+audit+customer email, reversible); Stripe checkout £1000 setup/£500 sub (live Stripe, hosted-confirm, audited); billing Mark-failed/Refund(irreversible)/Void (confirm+audit); Resend invite (real email); AI budget ceiling/limit (clamp+audit, no provider activation); analytics CSV/PDF export (estate egress, HQ-gated, no confirm).
Dark/partial: Stripe billing automation dark (manual/operator invoices); finance board narrative + analytics "AI COO insights" = deterministic placeholders (honestly labelled "LLM later"); ai-costs tiers dark (measurement-only).
Gate: HQ pages via layout requireHqPage(); all mutating actions re-check isSuperAdminEmail (defence-in-depth). No orphaned routes/UI-less actions in-domain.
ai_cost_window EXECUTE revoked from anon/authenticated (mig 20261235:124-125) — HQ service-role only. [confirms #902 security]

## [A9] 09-hq-core.md — RECEIVED
Super-admin gate = ENV allowlist CREWFLOW_SUPERADMIN_EMAILS (server/auth/hq.ts:33 requireHqPage→notFound; requireHqApi→404; superadmin.ts:17). Unset ⇒ everyone 404s. Layout app/admin/layout.tsx:46; most children re-gate; all mutations re-check.
DARK: FEATURE_HQ_AUTONOMOUS_APPLY + CREWFLOW_EXECUTOR_APPLY + CREWFLOW_HQ_APPLY_ON_APPROVAL + CREWFLOW_EXECUTOR_SHADOW (all unset, need literal "on"; lib/env.ts:377-384; pinned by __tests__/security/autonomous-apply-dark.test.ts). HQ Approve/Decide/Advance only record state — never execute.
AI dark/deterministic: CEO briefings deterministic cron; Decision AI-debate deterministic (generative dark); Exec-assistant narrative DARK (no governor key); Saga decomposition governed+budgeted; Alerts AI-COO deterministic.
Highest-blast LIVE control: Alerts "Mark resolved" (confirm, reversible, double-audited). Notifications "Requeue" = only real outbound email (no confirm).
hq-cadence dark-by-default (double-run risk if enabled w/o retiring legacy cron).
Orphaned actions (no UI button, POST-reachable, allowlist-gated): updateNoteAction (notes/actions.ts:769), assignAlert (alerts/actions.ts:1266).
Inline re-gate inconsistency: overview/tasks/command-centre/ceo/notifications/notes/alerts rely on layout gate only; /admin/overview uses bare requireUser() at :1389.
No orphaned routes (flatHqNav asserts every nav entry is a live page).

## [A10] 10-hq-growth-ai-employees.md — RECEIVED
Governor single seam invokeWithGovernor (lib/ai/governor.ts:901) + closed AI_FEATURES registry; 5 TIER_MODEL tiers armed in code (registry.ts:173) but gated by vendor creds + channel/DB/build flags + CEO holds. Autonomous apply triple-locked (FEATURE_HQ_AUTONOMOUS_APPLY off; executor.ts:376; autonomous-apply.ts:289 deterministic-reversible-only). NO AI employee acts autonomously on prod.
Live vs dark: Sales AI live-CRM(gen dark); Research/Qualification/CTO governed draft-only; Outreach DRAFT-ONLY no send path; Marketing/Product/Design/Docs/Ops/QA/CustSuccess/Support/SalesOrchestrator read-only deterministic boards (narrative dark); AI Boardroom FRAMEWORK ONLY; Shared Memory LIVE (embedding armed); AI Receptionist config+human-review live, voice+outbound transport DARK never auto-sends; Executor Shadow read-only (apply/execute never called).
CORRECTION: phone_numbers table EXISTS (mig 20261098000000); provisionPhoneNumber inserts (ai-receptionist/actions.ts:275). Voice dark = provider/flag, not schema.
Dangerous: /admin/demos promote = creates real auth user+org+invite+Resend email, super-admin gate only, NO confirm, weak reversibility. /admin/memory purge = irreversible hard-delete, no confirm modal.
Dark roster runners w/ NO UI (cron/pipeline only): hq-*-exec-runner.ts (CFO/COO/HR/legal/security/devops...).
All actions re-gate inline + recordAdminActivity audit. No orphaned routes.

## [A6] 06-money-finance.md — RECEIVED
Authz: Money routes admin-gated via segment layout.tsx (invoices/payments/expenses/cis/reports) or per-page requireManagementRole (cash/finances-list/tax/insights) EXCEPT /finances/new + POST /api/finances = member-open by design (staff log costs); /finances has no layout.tsx deliberately (route.ts:93-98).
6 DARK financial integrations (all gated): invoice/CIS email (no RESEND_API_KEY→503); HMRC MTD triply-gated (FEATURE_HMRC_CONNECT+creds+vendor-recognition); accounting push (FEATURE_ACCOUNTING_CONNECT, CSV works); portal payments (NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS, no Money-nav UI); open-banking (FEATURE_BANKING_CONNECT, API-only); governed AI (expense OCR expense.receipt_extraction, insights narrative, question box).
Void flow DB-trigger authoritative (tg_invoices_void_guard, mig 20261219); payment recording atomic allocate_payment RPC + 10s fail-closed dedupe; payment.recorded automation ships enabled:false.
Hard-to-discover: /reports/ageing + /reports/retention (cards only, not in REPORTS registry → no subscribe/PDF); /expenses/budgets (link only).
portal_uploads payment-proof reader on admin client (RLS-enabled/no-policies; org_id+kind sole isolation; flagged never-remove).
app/payment/* = onboarding setup-fee Stripe Checkout, not tenant Money. No orphaned/dead actions.

## [A3] 03-projects-jobs.md — RECEIVED
Counts: 15 routes + 7 API; /jobs/[id] workspace = Overview + 8 tabs (Commercial/Billing/Valuations/Drawings/Timeline/Certificate/Warranties/Variations); ~70 features, ~120+ buttons, ~45 actions.
KEY CORRECTION: jobs SELECT RLS is ORG-WIDE (org_id in current_org_ids(), 20260515150000_jobs:97-99) — staff see/open EVERY job, not just assigned. Assigned-only lives on /me. Role gating here = tabs/tiles, not job visibility. [Part 2 matrix]
Money boundary defence-in-depth: Commercial/Billing/Valuations + profit/margin tiles + private-doc reads hidden for staff AND server fail-closed requireManagementRole before read; cost entry stays member-open. Accounting boundary tested: budget/programme/progress/variation-accept write plans only, never finances (one money engine).
FLAGGED OFF: /api/v1/jobs(+/[id]) behind FEATURE_PUBLIC_API_JOBS (full GET/POST/PATCH, scoped, org-pinned). Calendar connector push DARK/no-op until flag.
Warranties deliberately send nothing (shown-not-sent, honest gap).
Hard-to-discover (no tab): /jobs/[id]/variations/new, /timeline, EOT-pack PDF; whole Site Hub is overview-panel-only.
Blueprints richest sub-surface (pdf.js viewer, note/snag/task pins, threaded comments+photos, redline, A/B compare, PWA offline) — overlaps A4 Drawings; dedupe in Part 5.
Next15.5 deep-swap discipline: every /jobs/[id]/* write uses redirectTo+<StateForm>, never redirect().
Side-effects: checklist-assign notif; job.completed automation (create+edit); billing/valuation invoice gen; admin audit; dark calendar push. No orphaned/dead controls.

## [A2] 02-sales-and-portal.md — RECEIVED
Counts: 28 pages (13 Sales + /q/[token] + 19 customer-portal), ~45 actions/APIs, ~120 buttons.
AUTHZ GAP: /reviews is the ONLY Sales surface with NO server-side role gate — no layout.tsx, actions use requireOrgContext() not requireManagementRole; staff can reach it + send review emails by URL. Every other Sales route has requireManagementContext() layout guard. [Part 2 + Part 7]
DARK: Portal "Pay now" Stripe (two-switch NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS + STRIPE_CONNECT_SECRET_KEY, portal-stripe.ts:50-66 "NEVER today" + per-org connected-account check; bank-transfer+proof-upload only live path); AI Quote Writer (vendor-cred gated, honest "Off", event-driven only); lead AI summary; portal chat AI auto-reply.
Dark-safe (live, no-op w/o RESEND): quote email, statement email, review email.
Cross-domain side-effect: quote acceptance (owner + public token) auto-creates AND emails an invoice [feeds Money].
Dead-end: report "decisions we need from you" display-only, no response control, yet Overview nudges it (reports/[id]/page.tsx:95); customers reply only via Messages.
Portal reads strip cost_*/jobs.notes/staff email by construction (RLS-bypass portal, security-test-pinned) — strong PII discipline.
Minor loud-read exception: customers list degrades to empty not fail-loud (customers/page.tsx:112).
Hard-to-discover: "Save as template" only from quote detail (not /price-book); quotes customer-filter + quote pre-fill only cross-linked.
Not in customer nav (intentional): /api/v1/leads, /api/demo, chat/poll (no page UI). No orphaned/dead controls.

## [A4] 04-site-and-safety.md — RECEIVED
Counts: 13 nav children → 25 routes, ~21k LOC.
MAJOR (recurring theme): NO server-side role enforcement in whole domain — /health-safety, /permits, /site-reports, /documents, /compliance, /weather all use requireOrgContext() not requireManagementContext(). Admin-only = nav discoverability + RLS + per-mutation owner/admin re-checks on destructive only. Staff URL-nav not redirected.
Zero AI in domain — "auto-generated RAMS" = deterministic template catalogue lib/health-safety/rams-templates.ts (grep-confirmed no governor/flag/dark call across all 12 groups).
Weather DARK by missing vendor credential (OPEN_METEO_API_KEY/MET_OFFICE_API_KEY), NOT a FEATURE_* flag; available=false every env, refuses to fake forecast. Diary weather-suggest + delay weather-district share gate.
Not-in-nav: /health-safety/worker-links; 5 quality sub-pages (/quality/ncrs*, /quality/templates*); blueprint markup/compare/pins under /jobs/[id]/blueprints/*.
Immutability via DB triggers + RPC-allocated refs + append-only sign-offs (status-transition-trigger based; content_hash SHA-256 only on signature-PNG + worker tokens, NOT H&S table rows).
Side-effects: site-report publish-to-portal → scoped customer email (best-effort); quality witness invite sends NO email (manual); no SMS anywhere. Signatures service-role to private bucket, magic-byte sniff, org-path recheck, 60s signed URL.
8 PDF/CSV API routes no nav entry (in-page buttons only), active-org pinned, draft→409, private/no-store.
Completeness divergence: /compliance uses hard .limit(500) not F-1 fetchAllRows. No-op: permits ?filter= lands unfiltered.

## CROSS-CUTTING THEME (Part 7): page-gate vs nav-gate mismatch
Many "admin" nav items are NOT page-role-gated server-side — they rely on nav hiding + RLS + per-mutation re-checks. Confirmed in: /inbox* [A1], /reviews [A2], /staff/rota/generate|conflicts [A5], entire Site & Safety domain [A4]. CONTRAST: Money domain IS page-gated via layout.tsx/requireManagementRole [A6]; Jobs money-tabs fail-closed [A3]. → Part 2 matrix must distinguish "nav-hidden" from "server-enforced"; Part 7 lists this as the top systemic finding (defence = RLS + mutation re-checks; reads of non-RLS-restricted data via URL are the exposure).

## [A7] 07-operations.md — RECEIVED
Counts: 44 routes / 8 nav entries (Assets 11, Fleet 7, Stock 12, Materials 3, Sites 3, Suppliers 7, PO 4, Overview 1). ~31 LIVE, ~12 impl-not-verified, 1 partial (/assets/scan camera), 3 flagged-off.
Banned revalidatePath+useActionState hang pattern ABSENT everywhere (FormState.redirectTo→window.location.assign used).
MEMBER-OPEN mutations (likely unintended / asymmetric): inspection-template lifecycle publish/archive zero role checks (assets/template-actions.ts); recordSupplierBill (ONLY finances-posting path in domain) member-open while CIS/payments admin-gated. [Part 7 + product decision]
Completeness: /assets list limit(1000) no F-1 (sibling /assets/calibration paginates). [joins /compliance limit(500) from A4]
Stock write-path guards verified at DB/RPC: admin-adjustment 42501 gate, conserving transfer legs, transfer-leg-correction refusal, draft-GRN refusal, txn-marker gate, advisory-lock negative-stock refusal; stocktake via record_stock_adjustment inherits guards.
Stock valuation D1 doctrine comment inconsistency (/stock/valuation says D1 DECIDED weighted-avg + renders money; siblings say D1 undecided/no value; behaviour consistent non-posting).
Dark: FEATURE_MERCHANTS (PO EDI, PO-detail only), FEATURE_TELEMATICS_CONNECT (NO UI entry, reads empty telematics_readings), FEATURE_MAINTENANCE_REMINDERS (send engine dark; schedule UI/data live).
Orphaned code: deleteFuelLog server action no UI caller; createFuelLog return_to=fuel/driver_id/notes never populated.
UX smells: Fleet "Log a fill"→register not fuel form; fleet compliance shows admin-only write forms to members (fail at RLS); deleteSupplier not isAdmin-hidden; PO-new palette gates admin but page allows any member; PO create 2-step non-atomic (orphan-header risk).
Discoverability: staff no sidebar (ADMIN_ROLES) but most routes only requireOrgContext (URL/QR reachable) — reinforces page-gate theme. Many sub-routes header/link-only (assets holdings/inspections/calibration/scan/templates, stock valuation/replenishment/vans/stocktake, suppliers cis/payments/performance/compare, PO matching).

## [A8] 08-settings-onboarding-account.md — RECEIVED — ALL 11 IN
Counts: 30 surfaces, ~95 controls.
FLAGS prod reality — ON: FEATURE_ENTERPRISE_SSO (per-org off → SCIM/SSO 401 not 404), FEATURE_MFA_ENFORCEMENT (inert, no UI/no org opted in), NEXT_PUBLIC_FEATURE_OUTBOUND_WEBHOOKS, VAPID push, Stripe SaaS checkout (approval-gated, no flag), Resend email.
OFF/dark: FEATURE_PUBLIC_API_JOBS, FEATURE_MARKETPLACE, FEATURE_GDPR_ERASURE, FEATURE_RETENTION_PURGE, SELF_SERVE_BILLING, CALENDAR_CONNECT, ACCOUNTING_CONNECT, HMRC_CONNECT, BANKING_CONNECT, MERCHANTS, TELEMATICS_CONNECT, PORTAL_PAYMENTS, MICROSOFT_SSO, ACCOUNT_LINKING, VOICE_INBOUND. Automations: no flag (per-rule enabled; delay/ai_decision/webhook nodes forced draft).
PLACEHOLDER/gaps: Settings "Members" read-only (NO invite/remove UI — staff invites ONLY via Imports flow!); /settings/security no password-change + no session-mgmt UI; MFA_ENFORCEMENT on but no self-serve control (needs raw organizations.require_mfa write); webhook secret rotation = delete+recreate (loses history); both Marketplace routes notFound() while dark; HMRC no disconnect (prepare/HOLD not file).
Signup never creates org (org+owner+seed at /onboarding/company); createOrg→/onboarding/setup but pending orgs fail orgHasActiveAccess→/access-pending. imports.ocr = single governed-AI call site (dark). Two-switch (flag AND creds, refuse-before-fetch) consistent across all dark paths.
