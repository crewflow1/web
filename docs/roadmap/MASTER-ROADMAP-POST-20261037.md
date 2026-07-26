# CrewFlow — Master Roadmap (post-`20261037`)

> **CANONICAL SOURCE OF TRUTH.** Supersedes every earlier roadmap/stage-progress/programme
> tracker. Established 2026-07-26 by an evidence-based reconciliation (26 domain reviews:
> 25 specialist agents + 1 self-review) grounded in the repository + production, NOT in
> memory or PR descriptions. If any older doc disagrees with this one, **this wins.**
> Older trackers are marked stale and linked here.

## 0. Verified baseline (facts, not memory)

| Fact | Value | How verified |
|---|---|---|
| Production `main` SHA | **`ed748b5`** | `git rev-parse origin/main` |
| Production migration tip | **`20261037`** | `supabase migration list --linked` |
| Live app SHA | `ed748b5` | `crewflow.uk/api/health` |
| Migrations in repo | 201 (baseline + 200 dated, monotonic, no dup timestamps) | migration dir |
| Distinct tables | ~153 | `create table` scan |
| Routes | 190 `page.tsx`, 74 `route.ts` API | filesystem |
| Tests | 531 unit/integration + 29 Playwright e2e | filesystem |
| Providers | email **LIVE**; SMS/WhatsApp/missed-call/LLM/telephony **DARK** | `/api/health` + env |
| PITR | healthy (WAL-G + PITR, ~7-day window) | release verification |
| Working tree | clean | `git status` |

**Open PRs (10, genuinely unmerged):** `#398` types-regen (main); `#360/#361/#362` WhatsApp
outbound stack (based on `directive/018`, not main); `#113` telephony/Vapi (main); `#128`
org_id perf indexes (main); `#136` address-first search (main); `#137` company-logo upload
(main); `#148` launch-checklist probe (main); `#121` imports customer-vs-staff fix (main).

**Everything `#399`–`#423` is MERGED & LIVE** (release train `#421` folded in commercial
`#399`–`404` + Blueprint tip `#411` + H&S tip `#420`; then `#422` toolbox, `#423` storage).

## 1. What CrewFlow is (one paragraph)

A genuinely broad, mostly-**LIVE** all-in-one operating system for 5–50-employee UK
construction/trades firms. The commercial spine (lead → quote → e-sign accept → auto
job+invoice → payment → multi-invoice allocation → construction retention → PO → supplier
bill → job profitability) is live. A first-class **H&S evidence suite** (RAMS, permits-to-work,
toolbox talks, version-anchored acknowledgements, evidence PDFs, revisioning) is live and
deeply hardened. **Blueprint Centre** (pdf.js viewer, pins, markup, revision compare, offline
IndexedDB, PWA shell) is live. Site ops (snags, diary, site reports, completion certificates),
assets (QR, inspections, maintenance), workforce (clock-in → payroll), a customer portal, and
dashboard/reports/tax are live. Sitting behind env flags is a **large DARK AI + communications
+ receptionist + HQ infrastructure** — implemented, one API key / provider credential from
activation. **Differentiators:** the depth of the all-in-one, H&S-as-a-product, and a
**tamper-evident evidence-integrity layer** (SHA-256 content hashing + write-once immutability
+ cross-tenant path binding) no trades competitor offers.

## 2. Capability inventory (evidence-based)

Status key: **LIVE** · **DARK** (built, provider/flag-gated) · **PARTIAL** · **SCAFFOLDED**
(schema/stub only) · **MISSING**.

### Commercial
| Capability | Status | Evidence / limitation |
|---|---|---|
| Leads + kanban pipeline (7 stages) | LIVE | `lib/leads`, `app/(app)/leads`; status free-text (no CHECK) |
| Lead→customer conversion | MISSING | no convert action; only `/quotes/new?lead_id` path |
| Customers (CRUD, paginated search, multi-site addresses) | LIVE | `lib/customers`, `customer_job_addresses` |
| Customer contacts (multiple) | MISSING | flat single-contact model, no `customer_contacts` |
| Quotes (CRUD, approval, PDF, send) | LIVE | `lib/quotes`; send RESEND-gated |
| Quote acceptance + e-sign (public `/q/[token]`) | LIVE | typed-name only (no drawn sig / signer-email verify) |
| Auto job + draft invoice on accept | LIVE | idempotent, DB-unique |
| Accepted-quote immutability | LIVE | migs 20261004/07 |
| Variations | LIVE | `variation_orders`; single VAT, no distinct auth gate |
| Invoices (PDF, send, remind, overdue) | LIVE | crons; RESEND-gated |
| **Standalone / deposit / interim invoicing** | **MISSING** | invoice creation structurally 1:1 with accepted quote (DB already permits `quote_id NULL`) — **core UK cash-flow gap** |
| Payments + allocate one receipt→many invoices | LIVE | `payments`+`invoice_payments`, `allocate_payment` RPC, concurrency guard |
| **Online invoice payment (customer pays)** | **MISSING** | bank transfer + manual match only; Stripe is subscription-billing |
| In-app payment reversal/void/refund | MISSING | needs admin DB delete |
| Purchase orders (CRUD, status, line items) | LIVE | `lib/purchase-orders`, mig 20261006 |
| **PO send-to-supplier (PDF/email)** | **MISSING** | "sent" is self-attestation; PO never leaves the system |
| Supplier bills (committed→actual) | LIVE | `recordSupplierBill`→finances, mig 20261009 |
| Expenses + receipt OCR (Claude Haiku) | PARTIAL | approval drops `job_id` → OCR'd cost skips job P&L |
| Construction retention (held/released ledger) | LIVE | `lib/retentions`, migs 20261005/12/13 |
| Retention release scheduling (JCT moieties) | LIVE | due-back dates, FIFO waterfall |
| Commercial cash truth (ledger not status) | LIVE | `lib/commercial/cash.ts` — but **does not net retention** from outstanding/overdue |
| Job profitability | PARTIAL | **draft invoices inflate revenue/margin** (`profitability/compute.ts`) |

### Jobs / field / workforce
| Capability | Status | Evidence / limitation |
|---|---|---|
| Jobs (CRUD, rich detail hub, customer link) | LIVE | `lib/jobs`, `app/(app)/jobs/[id]` |
| Job status lifecycle | PARTIAL | free-choice enum, **no state machine** (completed can revert) |
| Calendar (week, drag-drop reschedule) | LIVE | `app/(app)/jobs/calendar`; **not in sidebar**; scheduling logic untested |
| Rota (weekly staff×day, overlap conflict) | LIVE | `app/(app)/staff/rota`; not in sidebar; month view scaffolded-dead; no drag-drop |
| Job map / geolocation | PARTIAL | deep-links only; no geocoding/embedded map |
| Clock-in/out (mobile `/me`) | LIVE | `time_entries`, single-open guard |
| Geolocated clock-in | SCAFFOLDED | `gps_lat/lng` columns read but **zero client capture** (dead) |
| Timesheet manual entry/correction | PARTIAL | admin view read-only; missed clock-out only blocks payroll |
| Hours → payroll → payslip PDF → CSV | LIVE | PAYE+NI 2025-26 estimator, HMRC CSV |
| NI-number entry | MISSING | write helper `upsertStaffNiNumber` built+tested, **zero callers** → blank NI on payslips/CSV |
| Day-rate / CIS deductions | MISSING | hourly + PAYE only |
| Trades / skills / certs (CSCS) | MISSING | no columns; can't resource-match |
| Holiday balance / pay impact | PARTIAL | `leave_requests` exist; no entitlement/costing |

### H&S / evidence / documents
| Capability | Status | Evidence / limitation |
|---|---|---|
| RAMS (CRUD, lifecycle, hazards, PDF, revisioning) | LIVE | migs 20261018–23/34; deeply hardened |
| Permits-to-work (+conditions, expiry, PDF) | LIVE | mig 20261019 |
| Operative sign-off / acknowledgement gate | LIVE | `safety_acknowledgements`, version-anchored, append-only |
| **Subcontractor/guest sign-off** | **MISSING** | acks require `auth.uid()`+membership → covers employees only |
| RAMS template / hazard library | MISSING | every RAMS typed from scratch |
| Structured method statement | PARTIAL | free-text prose only |
| Toolbox talks (lifecycle, acks, PDF, provenance) | LIVE | migs 20261025–30/37 |
| Compliance register + expiry reminders | LIVE (reminder link broken) | `action_url` 404s (`compliance-docs.ts:141`) |
| Site reports (immutable snapshot + PDF + portal) | LIVE | migs 20260922/23 |
| Completion certificates (issue + portal + PDF) | LIVE | mig 20261014; `job_id` not bound to snapshot |
| Snags / daily diary | LIVE | internal only |
| Job photos | PARTIAL | `jobs.photos` bare `text[]` — **no hash/immutability, member-deletable** (not evidence-grade) |
| Universal attachments + content-hash + write-once | LIVE | migs 20261031–37; hash on tenant_attachments + blueprints only |
| Cross-tenant storage path binding | LIVE | mig 20261031/36 (fixed a real prod cross-tenant read) |

### Blueprint Centre
Register/versioning, magic-byte upload, pdf.js viewer (zoom/pan, no pinch-zoom), pins, markup,
revision compare (visual blend), offline IndexedDB read, PWA offline shell — **all LIVE** (migs
20261015–17). Gap: **shared-device offline residual** (public `/offline` shell re-lists cached
bytes with no session re-check; purge only on explicit sign-out).

### Customer portal
Token auth+expiry, overview/action-centre, quote view+accept, invoice view, reports/certs/docs
library, payment-proof upload, two-way messaging — **LIVE**. Gaps: **no online payment**;
portal link **never auto-emailed**; no outbound alert on reply/payment; 4/5 upload kinds
scaffolded.

### Platform
| Capability | Status | Evidence / limitation |
|---|---|---|
| Auth (passwordless magic-link + Google OAuth) | LIVE | `getUser()` gate, invite-role from server metadata |
| RLS / tenant isolation | LIVE (strong) | `current_org_ids()` single authority; 157 RLS tables |
| Object-level (role) authz on commercial writes | **PARTIAL — app-only** | RLS is member-level; **staff JWT can direct-PostgREST write quotes/finances/payments** |
| Impersonation | LIVE | super-admin, 24h, audited (grant can outlive banner if cookie lost) |
| Onboarding (guided, sample data) | LIVE | 12-step checklist |
| **Self-serve paid signup** | **MISSING** | founder must onboard every org; Stripe checkout admin-only |
| **Trial-expiry enforcement** | **MISSING** | `orgHasActiveAccess` returns true regardless of `trial_ends_at` |
| CrewFlow subscription billing (Stripe backend) | PARTIAL | pipeline exists, admin-initiated only |
| Company logo upload | PARTIAL | URL-paste only; upload PR #137 unmerged |
| Dashboard / reports / VAT / tax | LIVE | VAT = internal summary, not MTD filing |
| Job profitability report surface | MISSING | compute complete, no report/export page |
| Notifications (in-app + email) | LIVE | **no push**; email delivery RESEND-gated |
| Audit log | LIVE | `activity_log` + `admin_activity_log`; **RAMS/permit retire transitions unlogged** |
| Observability (Sentry, health probe, alerting) | **DARK / MISSING** | Sentry wired but no DSN; `/api/health` `ok:true` hardcoded; no infra alerting |
| Email bounce/complaint handling (live path) | MISSING | suppression exists only in dark engine → deliverability risk |
| **GDPR / org-teardown / account deletion** | **MISSING** | no erasure routine; storage bytes orphan on org delete |

### AI / communications (all DARK unless noted)
Email transactional path **LIVE** (quote/invoice send+remind, follow-ups, review requests).
SMS (Twilio), WhatsApp inbound (`#359` in prod but flag-off), missed-call text-back — **DARK,
built**. WhatsApp outbound — **MISSING** (`#360-362` unmerged). AI insights/Q&A/summaries,
receptionist reasoning, lead-qualification, research, memory, drafts, approvals, AI-employees —
**DARK or HQ-only**; deterministic fallbacks run live. **No tenant generative drafting** reachable.
AI-employee executor is **shadow-only** (records, never applies).

## 3. Old-roadmap reconciliation (corrections)

| Old claim (memory/docs) | Reality | Action |
|---|---|---|
| "~20 post-RC3 PRs unmerged (commercial/blueprint/H&S)" | **All merged** via `#421`/`#422`/`#423` | corrected here |
| Blueprint programme "COMPLETE & unmerged #405-411" | **Live in prod** (migs ≤ tip) | corrected |
| H&S epic "M2-M6 pending" | **M1-M6 all merged & live** | corrected |
| Release train `#421` "NOT MERGED — awaiting CEO auth" | **Merged** (73ba21f) | corrected |
| `vision2030-stage-progress.md` stage percentages | stale vs live | doc marked stale → this file |
| `docs/roadmap.md`, `stage-one-reconciliation.md` | pre-date recent waves | marked stale → this file |
| Storage-byte immutability / RAMS integrity "follow-ups" | **Shipped** (`#423`) | done |

Features **in code but absent from old roadmap:** receipt OCR (Claude Haiku), asset
QR/inspections/maintenance, event spine, HQ AI-employee shadow framework, calendar + rota
(both live but unlisted/buried).

## 4. End-to-end construction workflow — weakest links

Lead✅ → qualify (manual; AI is HQ-only) → **site visit❌ (no structured survey)** → quote✅ →
accept✅ → job✅ → **programme⚠️ (calendar only, no activities/critical path)** → labour✅ (rota,
no skills) → RAMS✅ → permits✅ → drawings✅ → procure✅ (**PO can't be sent**) → execute✅ →
timesheets✅ (**no correction; geoloc dead**) → variations✅ → **valuations/applications-for-
payment❌** → invoice⚠️ (**quote-only; no deposit/interim**) → **payment⚠️ (no online pay; retention
not netted)** → retention✅ → completion✅ → certificate✅ → docs✅ → closeout⚠️ (**no O&M pack**) →
reporting✅ (**profit not a report**).
**Weakest links:** flexible invoicing + online payment; applications-for-payment; CIS +
subcontractors; PO-send; programme; site-survey.

## 5. Security / legal debt register

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| S-1 | App-only manager gate → staff JWT direct-PostgREST writes to quotes/finances/payments/site_reports | **P1** | Add `is_org_admin()` to UPDATE `with check` on commercial/financial tables + `requireManager()` helper |
| S-2 | Service-role is sole isolation for 109 call sites + 80 policy-less tables (convention, not mechanical) | P2 | Typed org-scoped admin wrapper OR CI invariant requiring explicit `orgId` filter |
| S-3 | GDPR/org-teardown storage erasure absent; bytes orphan on org delete; no account/customer/employee deletion | **P1 (legal)** | Service-role bucket-sweep teardown + deletion routines (tension with 6-yr H&S retention) |
| S-4 | CSV import mis-detects customers as staff → data loss + **emails customers a staff magic-link** | **P1 (live)** | Merge `#121` (regression-tested) |
| S-5 | Impersonation grant can outlive banner (cookie lost before Exit → ≤24h silent cross-tenant write) | P2 | End grant server-side by admin id, not cookie-only |
| S-6 | RAMS withdraw/supersede + permit close/cancel member-level (app+DB); retire transitions unaudited | P2 (policy) | CEO decision §12; add audit rows regardless |
| S-7 | Completion cert `issueCertificate(jobId,certId)` doesn't bind `cert.job_id===jobId` | P2 | `.eq("job_id", jobId)` + reject mismatch |
| S-8 | `permit_status_at_issue` (linked) + RAMS `reference` still caller-settable on direct issue | P3 | Derive in SQL trigger |
| S-9 | Job photos not evidence-grade (`text[]`, member-deletable) | P2 | Route via `tenant_attachments` (hash + write-once) |
| S-10 | Shared-device offline residual (`/offline` no session re-check) | P2 | Session re-validate + expire cached bytes |
| S-11 | Email deliverability: no bounce/complaint suppression on live send path | P2 | Resend webhook → suppression list |

## 6. Product-policy decisions requiring CEO input

1. **RAMS withdraw/supersede** — admin-only or member-level? *Rec: admin-only* (retiring a legal record). 
2. **Permit close/cancel/suspend** — member / admin / responsible-person? *Rec: cancel+close admin-or-responsible-person; activate/suspend member.*
3. **GDPR erasure** — build org-teardown storage sweep? (tension with H&S 6-yr immutability). *Rec: yes, with a legal-hold exception for issued H&S evidence.*
4. **Completion certificate** — bind snapshot to `job_id`? *Rec: yes.*
5. **`permit_status_at_issue` / RAMS `reference`** — server-derive or accept documented P3? *Rec: derive.*
6. **Monetization** — self-serve paid signup + trial-expiry gate, or stay founder-led? *Rec: build self-serve for scale; founder-led is fine for first design partners.*
7. **Compliance lane** — own UK tax (CIS + reverse-charge VAT) natively, or integrate Xero/QuickBooks? *Rec: own CIS (differentiation moat); consider Xero export later.*

## 7. Cost posture

Fixed floor ~**$145/mo** (Supabase Pro ~$25 + **PITR ~$100 — keep, it's the safety** + Vercel
~$20). Everything else scales from ~zero while idle/dark (LLM/SMS/WhatsApp = $0 dark; realtime
unused; storage near-empty). **Avoidable idle waste:** ~5,600 no-op Vercel cron invocations/day
from every-minute dark crons (`spine-drain`, `spine-backfill`, `task-reaper`, `memory-embed`)
serving dark subsystems — throttle to 10–15 min until those features light up (marginal $≈0
today but keeps the DB awake 24/7). **Runaway risks (post-launch):** blueprint/evidence egress
(50 MB files via CDN-bypassing signed URLs), uncached PDF endpoints, and dark→live cron cadence
becoming per-tick LLM spend the moment a key is added.

## 8. Market / competitor gaps (only material ones)

Strong vs field: all-in-one depth, H&S-as-a-product, evidence-integrity moat, assets.
Missing table-stakes: **CIS + domestic reverse-charge VAT** (every UK competitor offloads to
Xero — owning it is a *moat*), accounting sync (Xero/QBO/Sage), field time→payroll costing (have
clock-in, gap is costing), quote **price book**, review-request automation. **The single biggest
differentiation opportunity:** own UK construction tax compliance (CIS + reverse-charge) natively
on the existing PO→bill→payment→retention→payroll spine + the tamper-evident evidence layer.

## 9. STOP-BUILDING list (protect the launch)

- **AI-employee autonomous execution** beyond shadow — keep locked until paying customers ask.
- **New AI/HQ infrastructure** — the dark surface is already large; don't extend it.
- **Full programme/Gantt with critical-path & resource-levelling** — a week calendar is enough pre-launch.
- **QS-grade valuation certification (Payapps-scale), BIM/IFC clash, inventory/stock, fleet telematics, tender portals, blueprint takeoff-estimating** — enterprise bloat a 5–50 firm won't pay for.
- **Native mobile app** — PWA suffices; don't fork platforms.
- **Second email/comms engine** — converge on the live `lib/email` path; don't wire the dark `hq-comms` duplicate for tenants.
- **Speculative event-spine expansion** — 0 consumers today; don't build more onto it.

## 10. Launch-readiness verdict

**Could we onboard the first paying construction company tomorrow?** *Founder-led: yes, with
known risks. Self-serve: no.* The product is usable end-to-end for a founder-onboarded design
partner. Blockers below.

**TRUE launch blockers (concrete):**
1. **Live import defect `#121`** — corrupts the primary onboarding path (customer data loss + emails customers a staff sign-in link). *Merge-ready.*
2. **Observability blindness** — Sentry dark, `/api/health` can't detect an outage, no infra alerting. Can't safely operate a paid SaaS you can't see fail.
3. **Object-level authz bypass (S-1)** — a multi-seat paying org exposes staff→commercial-table direct writes.
4. **Self-serve monetization + trial-expiry** — *blocker for self-serve SaaS launch only; not for founder-led design partners* (manual Stripe works today).
5. **GDPR erasure path (S-3)** — legal exposure; becomes urgent as customer count rises.

**Knowingly-accepted risks if launching founder-led now:** manual billing; no online customer
payment (bank transfer); email has no bounce suppression; retention shows as outstanding.

**Onboarding requiring founder intervention today:** Stripe checkout, trial grant/approval,
logo upload, CSV import safety (until `#121`).

## 11. New master roadmap — four horizons

Grouped into coherent programmes (not 50 tickets). Effort: S ≤ ~3 days, M ~1 wk, L ~2–3 wks.

### HORIZON 0 — decisions + high-leverage fixes (days)
- **H0-DECISIONS** — CEO answers §6 (RAMS/permit authz, GDPR approach, cert binding, monetization lane, compliance lane). *Blocks H1 scoping.*
- **H0-SWEEP (Quality & Live-Defect sweep, S):** merge `#121`; fix compliance `action_url` 404; exclude draft invoices from profitability; wire NI-number entry field; regenerate `types.ts` @ 20261037 + add CI drift gate; reconcile 9 unschema'd env vars; drop dead deps (`openai`, `inngest`); throttle dark crons. DB impact: none. Blast radius: low. DoD: all live defects closed, CI green, types drift-gated.

### HORIZON 1 — launch blockers
- **H1-TRUST (Security & object-level authz, M):** DB `is_org_admin()` gate on commercial/financial UPDATE tables + `requireManager()` helper (S-1); typed org-scoped admin wrapper or CI invariant (S-2); impersonation end-by-id (S-5); cert `job_id` bind (S-7); job-photo evidence-grade (S-9); shared-device offline re-check (S-10); audit rows on RAMS/permit retire (S-6). *Preserves intentional member-level RAMS/permit policy.*
- **H1-OBSERVE (Observability go-live, S):** set `SENTRY_DSN` (CEO/ops) + add to launch-checklist as required; real dependency probe in `/api/health`; infra alerting on cron failure/error spike; Resend bounce/complaint webhook → suppression (S-11).
- **H1-LEGAL (GDPR teardown & deletion, M):** service-role storage bucket-sweep on org delete; account/customer/employee deletion routines with legal-hold exception for issued H&S evidence (S-3). *Gated on H0 decision 3.*

### HORIZON 2 — highest-value pre-launch
- **H2-CASH (Get-paid completion, L):** decouple invoice from 1:1 quote → standalone/deposit/interim invoices; **online invoice payment** (Stripe payment-intent + webhook auto-reconcile into `invoice_payments`); net retention out of outstanding/overdue; auto-email the portal link. *The "get paid faster / know every £" core.*
- **H2-MONEY (Self-serve billing, M):** customer-facing Stripe checkout + trial-expiry gate + billing portal (backend exists). *Gated on H0 decision 6.*
- **H2-CIS (UK tax compliance moat, L):** subcontractor entity + CIS deductions (20/30/0%) on supplier bills/POs + deduction statements + CIS300 + domestic reverse-charge VAT on invoices. *The biggest differentiation; gated on H0 decision 7.*
- **H2-FIELD (Field adoption, M):** guest/subcontractor tokenised sign-off; geolocated clock-in (client capture); surface calendar+rota in nav + finish rota month view; broaden a11y axe coverage beyond H&S/toolbox; PO send-to-supplier (PDF+email).

### HORIZON 3 — post-launch / scale
- **H3-AI (staged activation, provider-gated):** one LLM key → read-only insights/Q&A → receptionist draft-first → tenant generative drafting (quote/invoice-reminder/job-summary via existing `lib/drafts` seam). Keep executor shadow until asked.
- **H3-COMMS:** SMS/WhatsApp/missed-call activation (providers) + WhatsApp outbound `#360-362`.
- **H3-ACCOUNTING:** Xero/QBO export (if not owning tax fully).
- **H3-CONSTRUCTION:** applications-for-payment/valuations, quote price book, WIP/CVR, programme, O&M handover pack, review-request automation.

## 12. Next build wave (ranked) + exact next milestone

**Wave (next 3–5 milestones, in order):**
1. **H0-SWEEP** — closes live defects (incl. the `#121` credential-leak) + cheap quality debt; days; lowest risk. *Do first — highest certainty, unblocks confidence.*
2. **H1-TRUST + H1-OBSERVE** — the two operability/security blockers for any paid launch; mostly additive/defense-in-depth. *Outranks features: you cannot safely run a paid SaaS blind or with an object-authz hole.*
3. **H1-LEGAL** — GDPR erasure; legal must-have before scaling. *After H0 decision 3.*
4. **H2-CASH** — flexible invoicing + online payment; the top customer-value lever. *First "new feature" wave.*
5. **H2-CIS** — the differentiation moat; larger, sequenced after launch-critical work.

**→ NEXT MILESTONE TO BUILD: `H0-SWEEP` immediately, then `H1-TRUST`.** They are the shortest,
safest, highest-certainty path to a defensible founder-led launch. `H2-CASH`/`H2-CIS` have a
higher ceiling but larger blast radius and are not blockers for a first design partner. The
paste-ready directive for the combined **W1 = H0-SWEEP + H1-TRUST + H1-OBSERVE (Launch Hardening
& Trust)** is in the CTO report accompanying this doc.

## 13. Risks / assumptions
- Prod env var contents inferred from `/api/health` + code gating, not read directly (no secret access). "Email live, others dark" is confirmed by the health payload; RESEND/SENTRY/LLM presence should be confirmed against the real Vercel env before H1-OBSERVE.
- Effort sizes are engineering estimates, not commitments.
- The mobile/field-UX + a11y domain was self-reviewed (the specialist agent was killed by the monthly spend limit); findings corroborate the H&S/blueprint/workforce agents.
- Phase 15 adversarial review was performed by the lead (self-review), not fresh agents (spend limit). No agent output was fabricated.

---
*Reconciliation method: 25 specialist domain agents + 1 self-review, grounded in repo `ed748b5`
+ production, 2026-07-26. This document is the canonical roadmap; keep it updated as waves ship.*
