# CrewFlow — First Customer Readiness Audit

**Question:** *If a real 5–30-person UK construction company paid for CrewFlow tomorrow, could we confidently onboard them and have them run their business through it for 30 days?*

**Prepared:** 2026-08-25 · **Baseline audited:** `main` = production = `8784cd0b` · **Method:** independent, evidence-based, read-only. Trust nothing from marketing/memory; the repo, schema, tests and provider state are the source of truth. A route returning 200 ≠ usable; a dark feature ≠ live; a passing test ≠ operable by a builder.

---

## 0. Headline verdict

**YELLOW-GREEN — safe for a hand-held, high-touch design-partner customer #1 — BUT gated on resolving one live operational incident and verifying two config items first.**

The *product engineering* is materially stronger than expected: the money engine, job/commercial spine, site-&-safety, people/HR, operations (stock/PO/3-way-matching), onboarding wizard, import engine, and mobile field experience are genuinely built and largely correct, with excellent multi-tenant discipline and no P0 financial-calculation or cross-tenant defects. What holds it back from GREEN is a small, enumerable set of gaps plus a sales-led (not self-serve) commercial funnel.

**However, at audit time the production service is DOWN** (see P0-A). That must be resolved before anything else.

---

## 1. Phase 0 — verified current truth

| Check | Result |
|---|---|
| `main` SHA | `8784cd0b6b9dbcb0837f84c446e10466ea35fe66` ✓ matches baseline |
| PR #848 merged | ✓ MERGED 2026-08-24 01:41 UTC (merge commit = `8784cd0b`) |
| Production SHA | `8784cd0` ✓ matches main |
| **Production health** | ❌ **`ok:false, status:degraded, db:degraded`** (sustained across polls) |
| **Production DB** | ❌ **UNREACHABLE** — `jzntbskdqdopzwdqwvkp.supabase.co` returns **NXDOMAIN** on Cloudflare + Google DNS; `db.<ref>` also NXDOMAIN; `supabase db query --linked` times out (worked 2 days ago). |
| Migration parity | 378 files at baseline (could not re-confirm applied-count live — DB unreachable; last confirmed 378/378 tip `20261218` on 2026-08-24) |
| Dark-provider state | email `true` (Resend, live), sms `false`, whatsapp `false`, missed-call-textback `false`, weather `false` — **no dark provider activated** ✓ |
| Wave-A crons (`alerts-poll`, `hq-decision-autopropose`) | Could not verify live (DB down). Code fix present at baseline. Last observed runs (2026-08-23 03:0x) failed on pre-fix code; first post-fix natural run pending. → **Pending natural scheduled verification** |

### P0-A — PRODUCTION IS CURRENTLY DOWN (live operational incident)
The production Supabase project host does not resolve (NXDOMAIN) on multiple public resolvers, and the Vercel edge health probe independently reports `db:degraded`. For Supabase, a vanished project hostname almost always means **the project is paused, suspended, or deleted** (billing lapse, manual pause, or provider action). A real customer would be **fully down** right now.
- **This is only actionable by the account owner** (Supabase dashboard / billing) — not fixable in code, and out of scope to touch.
- **Action:** check the Supabase dashboard for project `jzntbskdqdopzwdqwvkp` — is it paused/suspended and is billing current? Restore/unpause before any onboarding.
- It also blocks live re-verification of RLS behaviour and cron_runs in this audit (those items are code-verified below and flagged pending-live-reverify).

---

## 2. Capability inventory (by product IA)

**Legend:** LIVE · DARK (built, activation = config/creds) · PARTIAL · BROKEN · NOT-BUILT · EXTERNAL-MANUAL

### HOME / dashboard — LIVE
Dashboard (parallel-wave data load), daily briefing ("what needs my attention today"), setup checklist, onboarding wizard. Notification centre + web-push (push dark: VAPID unset).

### SALES
- Leads/pipeline/scoring/convert — **LIVE** (AI lead-summary dark; deterministic fallback live)
- Customers (list/CRUD/360/contacts/portal token/statement) — **LIVE**
- Quotes (builder, approval, PDF, e-sign acceptance portal `/q/[token]`, variations+EoT, version history, templates) — **LIVE**
- Price book — **LIVE** (no import)
- AI quote-writer — **DARK** (governor null)
- Reviews — **PARTIAL / oversold** (no automated customer send, no review-collection, generic non-deep-linked URLs; UI claims cron sends to customer — it only notifies the operator)

### PROJECTS
- Jobs (list/create/from-template/workspace) — **LIVE**
- Programme/Gantt/baseline/critical-path, checklist, diary, photos (+offline capture), drawings/blueprints (markup/versioning/offline), documents (private/staff split) — **LIVE**
- Valuations/applications-for-payment, commercial/margin (admin-gated), staged billing, retention, completion certificates+PDF, delays/EoT+pack — **LIVE**
- Variations — **LIVE**
- Crew assignment — **PARTIAL** (single `assigned_to`; no crew table; jobs row has no title/site-FK/value)
- Calendar, templates — **LIVE**

### SITE & SAFETY — LIVE (strong)
- RAMS (create/template/lifecycle/PDF), permits-to-work (11 types/lifecycle/PDF), toolbox talks (deliver/snapshot/PDF), inductions, ITP inspections, snags, NCRs, muster/site-compliance, completion certificates — **LIVE**
- **External worker sign-off portal** (`/worker-portal/[token]`, no login, per-doc acknowledge) — **LIVE**
- Diary weather auto-fill — **DARK** (weather provider); witness notification — **EXTERNAL-MANUAL**; structured external-attendee capture — **PARTIAL**
- **Incidents / accidents / RIDDOR — NOT-BUILT** (no table anywhere) — statutory gap for construction

### PEOPLE — LIVE (strong)
- Staff record (contacts, role, private pay, private emergency contact, admin-only NI/DOB, certs+expiry, holiday balance, documents) — **LIVE**
- Invite/roles, rota (+deterministic generator, conflict check), job assignment, timesheets, **clock-in/out (GPS)**, leave, worker self-service `/me` — **LIVE**
- Payroll calc (PAYE/NI/employer-NI/pension/student-loan, dated rates) + payslip PDF + CSV — **LIVE (estimates)**
- **RTI/FPS HMRC filing — DARK** (prepare-and-hold only)

### MONEY / COSTS — LIVE (most rigorous area; no calc errors)
- Invoices (create/PDF/send/reminders), payments (record/allocate, partial), overdue authority, aged debtors/creditors, cash position (receivables-based) — **LIVE**
- Costs/finances, expenses (receipt→draft→approve; OCR dark), expense budgets — **LIVE**
- POs, goods-receipt (GRN), bill recording, **3-way matching**, committed spend — **LIVE**
- Job costing/profitability (labour + employer on-costs + stock COGS, no double-count) — **LIVE**
- VAT 9-box (cash/standard/FRS/reverse-charge, all correct), CIS deduction+statements (export-only), corp-tax (marginal relief correct), tax dashboard — **LIVE (estimates; prepare-not-file)**
- Bank reconciliation — **LIVE (manual CSV)**; bank feed (open-banking) — **DARK**
- Accounting export CSV (sales-side only) — **LIVE**; Xero/QB/Sage API push — **DARK**
- Online invoice "Pay now" (Stripe Connect) — **DARK** (manual payment-proofs instead)
- **Credit notes / refunds — NOT-BUILT**
- HMRC MTD VAT / CIS300 / RTI submission — **DARK / EXTERNAL-MANUAL**

### OPERATIONS — LIVE (strong)
- Assets (register/calibration/custody/depreciation/inspections/maintenance/QR scan/templates) — **LIVE**
- Fleet (vehicle CRUD, MOT/insurance/tax/service compliance, fuel logs) — **LIVE**; GPS/telematics — **DARK**
- Stock (movement ledger: issue/transfer/adjust/correct/receipt, weighted-avg valuation, stocktake, van stock, replenishment) — **LIVE**
- Materials (requests→PO) — **LIVE**
- Suppliers (CRUD/compare/performance/payments w/ dup-detection) — **LIVE**; CIS HMRC verification — **EXTERNAL-MANUAL**; merchant catalogue/punchout — **DARK**
- Marketplace — **DARK** (404s)

### INBOX / COMMUNICATION
- Enquiries, conversations (manual + email out), review queue, outbound audit — **LIVE (manual)**
- Outbound email (Resend) — **LIVE**; outbound SMS/WhatsApp — **DARK (queues)**
- Inbound WhatsApp / voice / email / missed-call textback — **DARK**
- AI receptionist drafting — **DARK** (governor null); human-in-the-loop plumbing live

### AUTOMATION / AI
- Deterministic automation engine (catalogue rules, cron schedules, custom no-code rules) — **LIVE**
- Lead scoring, rota generation, schedule-integrity, company-health/insights (deterministic) — **LIVE**
- **All generative AI** (quote-writer, receptionist, narratives, embeddings, OCR, transcription, vision) — **DARK** (governor `TIER_MODEL` all-null; activation = bind a model + key)
- Voice/receptionist — **DARK**

### ADMIN / SETTINGS
- Org setup, users/roles (owner/admin/staff), branding, tax defaults, MFA enrol (enforcement dark), API keys — **LIVE**
- Billing/subscription (self-serve Stripe) — **DARK** (mailto)
- Imports (Migration OS: CSV/Excel/PDF-OCR/ZIP, sandbox, rollback) — **LIVE**
- Audit trail — **LIVE**; data deletion/GDPR export — **LIVE** (erasure legal-gated)
- HQ/super-admin (separate email-allowlisted surface; impersonation super-admin-only, re-validated) — **LIVE**

**Counts (≈110 meaningful capabilities classified; granularity is a judgment call):**
- **LIVE ≈ 65** — the operational core (sales, jobs, safety-docs, people/HR, money/costs, operations, onboarding, imports, HQ) is genuinely built with real data flow.
- **DARK ≈ 28** — all generative AI (governor null), SMS/WhatsApp/voice/inbound channels, weather, telematics, merchant ordering, marketplace, Stripe payments + self-serve billing, accounting OAuth push, open-banking, HMRC MTD/CIS300/RTI, Microsoft SSO, public API, web-push, Sentry.
- **PARTIAL ≈ 7** — Reviews, internal-staff safety discovery, expired-cert gating, structured external-attendee capture, CIS HMRC verification (external-manual), accounting CSV (sales-only), AI lead-summary (deterministic fallback live).
- **BROKEN = 0** — no broken capability found in any domain.
- **NOT-BUILT ≈ 10** — incidents/accidents/RIDDOR, credit-notes/refunds, quote discount, quote duplication, crew assignment, review-collection, invoice-void/job-cancel states, timesheet-entry editor, form-draft autosave, opening balances.

---

## 3. Customer-journey verdicts (Oak & Stone Construction Ltd, 18 staff, VAT+CIS)

- **Day-0 purchase/signup:** MANUAL-BUT-ACCEPTABLE for #1. Sales-led (book-demo → HQ approve → trial). No live payments (Stripe dark → offline invoicing). Self-signup dead-ends at `/access-pending` unless email pre-matched. No persisted terms acceptance.
- **Onboarding (Day-1):** STRONG. Guided 12-step wizard (live-recomputed), pre-seeded sample data, real VAT/CIS/tax settings, TTFV ~5–10 min. Import engine strong (OCR + rollback), but price-book/assets/opening-balances/safety-docs not importable.
- **Sales/quote (Week-1):** Largely can replace the quote spreadsheet — pricing, per-line VAT, approval, PDF, online e-sign acceptance → auto job+invoice. Gaps: no discount, no duplication, conversion drops site/scope/value.
- **Job management:** Largely can replace job spreadsheet + reduce WhatsApp — real cost roll-up, variations, valuations, retention, diary, photos, drawings, portal. Gap: no crew (single assignee) → "who's on site" stays in WhatsApp.
- **Site & Safety:** STRONG — RAMS/permits/toolbox/worker-sign-off all live incl. external no-login worker portal. Gap: no incident/RIDDOR module.
- **People:** STRONG — can retire the HR/staff spreadsheet. Payroll = estimates, RTI filing dark.
- **Money:** STRONG — owner can answer "did this job make money?" and every month-end question; calculations correct. Gaps: no credit-notes, accounting CSV sales-only, no live bank feed, prepare-not-file HMRC.
- **Month-end:** Answerable across the board via reports + daily briefing.
- **Mobile field:** STRONG — distinct mobile-first field UX, offline write+photo outbox, on-phone sign-off. Gap: no at-a-glance site-emergency card.
- **Security/permissions:** Compensation + cross-tenant PASS. **Gap: Money area not server-side role-enforced** (staff can read financials + create invoices/expenses by URL/API).
- **Data migration:** Concierge-viable; several entities manual-only.
- **Supportability:** MIXED. HQ console is substantial (org/customer lookup, health, best-in-class audited impersonation with 24h cap + kill switch). BUT a recurring class of everyday corrections — void an issued invoice, cancel a job, fix a wrong timesheet — has no in-product path and lands on **direct Supabase edits**. Feature flags are global-only (no per-org toggle); no global user-by-email search.
- **Observability:** MODERATE→WEAK. Honest health endpoint (live DB probe + outbound-readiness), complete `cron_runs` telemetry (45/45), email-queue stats. BUT **Sentry is integrated yet DARK (no DSN) → zero error capture in prod**, and **no uptime monitor/paging is wired** → an outage is discovered by a customer phoning, not an alert. (P0-A is the living proof.) Logging is console→Vercel only.
- **Failure/recovery:** DECENT for the common cases (self-serve password reset, PRG-guarded back button, offline write queue for core field ops, quote versions + accepted-quote immutability, audited supplier-payment void). Weak spots: no void/cancel for issued invoices or jobs, no timesheet-entry editor, hard customer/job delete with no restore, no form-draft autosave (refresh mid-form loses input).
- **Email/notifications:** Sufficient for #1 (Resend live + in-app centre). Verify Supabase Auth SMTP (login/reset path bypasses Resend).

---

## 4. Blocker model

### P0 — sale blockers
- **P0-A — Production is down (Supabase project unreachable / NXDOMAIN).** Operational, owner-actionable (dashboard/billing). WORKAROUND: none until restored. *Not a code defect.*

### P1 — onboarding/adoption, security, safety-legal, or supportability blockers
*Grouped by theme. None individually stops a hand-held sale; collectively they define the First-Customer-Release scope.*

**Security / integrity**
1. **Money area not authorization-enforced** — a `staff` account can read revenue/VAT/invoice-list/quotes/cost-log by direct URL/API and *create* invoices/expenses (`/reports`, `/api/reports/export`, `/invoices`, `/quotes`, `/finances`, `/expenses`, Cmd+K). In-org over-exposure (not cross-tenant, not a pay leak). Fix: one central `requireOrgRole(ADMIN_ROLES)` on Money surfaces. WORKAROUND: **yes** — provision only owner/office accounts; withhold staff logins until fixed. **Top code fix.**

**Operational readiness (WE can't run/support it reliably)**
2. **Sentry integrated but DARK (no DSN)** → zero error capture in production. WORKAROUND: no.
3. **No uptime monitor / paging wired** → outages found by customers phoning, not alerts (P0-A is the proof). WORKAROUND: no.
4. **Routine corrections require direct Supabase edits** — issued invoices can't be voided/credit-noted, jobs have no `cancelled` state, timesheet entries have no editor. Everyday support requests land on DB surgery. WORKAROUND: no (DB access).
5. **Verify Supabase Auth SMTP** — login magic-link + password reset use Supabase Auth's own SMTP, not Resend; if not a production sender, logins fail silently at scale. WORKAROUND: verify/config before onboarding.

**Safety / legal (construction-specific)**
6. **No incidents/accidents/RIDDOR module** (NOT-BUILT) — nowhere to log an injury/near-miss; UK-statutory. WORKAROUND: yes (paper/external), but a real gap.
7. **Expired certifications warn but never block** — rota "prefers, never excludes"; an expired CSCS doesn't block scheduling/site-sign-on/RAMS-signing, and the worker never sees their own expiry (admin-only briefing). WORKAROUND: partial (admin vigilance).
8. **Internal staff can't discover RAMS/permits to sign** — nav hides them from `staff`; `/me` shows no docs-to-sign (sign-off works only via direct/worker-portal links). WORKAROUND: yes (issue worker-portal links to employees too).

**Sales/job adoption friction**
9. **Quote→job conversion drops site/scope/value** — new job is a near-empty shell. WORKAROUND: PM re-enters details.
10. **No quote discount** (negative prices blocked). WORKAROUND: fudge unit prices.
11. **No quote duplication** (explicitly stubbed). WORKAROUND: templates + price book.
12. **Single-assignee jobs, no crew** — "who's on site today" stays in WhatsApp. WORKAROUND: rota (costing unaffected).

**Finance / migration / commercial**
13. **Payroll RTI/HMRC filing dark + figures are estimates.** WORKAROUND: export CSV/payslips, file via existing bureau/Basic PAYE Tools.
14. **Import gaps** (price book, vehicles/assets, opening balances, safety docs — not importable). WORKAROUND: manual entry during concierge onboarding.
15. **No live payment collection** (Stripe dark → offline invoicing). ACCEPTABLE for #1; becomes a blocker by ~customer 5–10.

### P2 — important (documented workaround)
Reviews oversold (misleading UI copy); no duplicate-customer guard; CIS cost not job-linked; corp-tax estimate omits payroll wages (over-provisions); accounting CSV sales-side only; perf waterfalls (job workspace, dashboard tail, `/me`); no field site-emergency card; no discrete timesheet approval; subcontractors no dedicated entity; single job-photo-after-save flow.

### P3 — polish
Credit-notes/refunds not built; Employment Allowance not applied (over-provisions NI); cash position receivables-only; photo captions/per-job timeline; inbound-receptionist data-carry defect (masked while voice dark); send-API approval gate UI-only; VAT-registered inferred from number.

---

## 5. Wave-B reconsideration — does Customer #1 need it?
- **Stripe/billing:** SOON (needed ~customer 5–10; manual for #1)
- **Twilio SMS / WhatsApp / missed-call / voice receptionist:** NO (email + in-app sufficient; enhancements only)
- **Accounting OAuth (Xero/QB):** SOON (CSV export bridges #1; accountants will want sync)
- **HMRC MTD/RTI/CIS300 filing:** NO for engineering now (external recognition + legal gated; prepare-and-export works) — but a real expectation to set
- **Open-banking bank feed:** NO (manual CSV reconcile works)
- **Telematics/GPS:** NO
- **SSO/SCIM:** NO (5–30 staff)
- **Public API:** NO
- **Marketplace:** NO
- **AI (bind a model tier):** NO strictly, but highest-leverage optional enhancement (lights up quote-writer/receptionist/insights under a spend ceiling)

**Keep dark for #1:** SMS, WhatsApp, voice, telematics, marketplace, public API, SSO/SCIM, open-banking, HMRC live filing.

---

## 6. Recommended programmes

### FIRST CUSTOMER RELEASE (smallest safe set — P0 + the necessary P1s)
*Estimate: ~1–2 focused engineering weeks + operational config. All small/well-scoped; no schema-heavy work except the invoice-void state.*
1. **Resolve P0-A** — restore the Supabase project (operational, owner; dashboard/billing).
2. **Central `requireOrgRole(ADMIN_ROLES)` on Money surfaces** (P1-1) — closes the financial over-exposure; the one genuine security fix. ~1–2 days.
3. **Turn on error tracking + uptime monitoring** (P1-2/3) — set the Sentry DSN (SDK already integrated) and wire the BetterStack `/api/health` monitor. Config, not build. So WE find the next outage before the customer does.
4. **Verify/configure Supabase Auth SMTP** (P1-5) — config verification before onboarding.
5. **Minimum support-correction tooling** (P1-4) — at least an issued-invoice **void** state and a job **cancel** state (avoids DB surgery for the two most common corrections). Timesheet editor can follow. ~2–4 days.
6. **Quote→job conversion carries site/scope/value** (P1-9) — modest; removes the worst adoption friction.
7. Documented concierge workarounds for the rest (no-discount, no-duplication, no-crew, payroll-estimates, import gaps, no-RIDDOR, cert-expiry-vigilance, employee sign-off via worker-portal links) — in the playbook (§7).

### FIRST 5 CUSTOMERS (recurring pain)
Quote discount + duplication; crew assignment; incidents/RIDDOR module; import for price-book/assets/opening-balances; duplicate-customer guard; Reviews honesty fix; accounting CSV breadth; perf waterfall cleanup.

### SCALE (post repeatable sales)
Self-serve Stripe billing + trial→paid + dunning; accounting OAuth sync; open-banking feed; credit-notes/refunds; HMRC live filing (recognition); optional AI activation; SMS/WhatsApp/voice.

---

## 7. Manual onboarding playbook (high-touch, acceptable for #1)
- **Day -3:** collect customer's spreadsheets (customers, staff, suppliers, active jobs, price list, invoices outstanding). Confirm Supabase project healthy + Auth SMTP configured.
- **Day -2:** CrewFlow ops imports customers/staff-invites/suppliers/jobs/outstanding-invoices via Migration OS; hand-enter price book + assets/vehicles (no import). Set org VAT/CIS/tax defaults.
- **Day -1:** create + configure owner account (HQ approve demo → trial/active), branding, bank details, quote terms. Provision **owner + office accounts only** (withhold staff logins until P1-1 fixed).
- **Day 0:** 60-min owner/admin onboarding (quote→job→invoice loop, commercial, reports, daily briefing).
- **Day 1:** 15-min site-manager onboarding (jobs, diary, photos, RAMS, worker-portal links).
- **Week 1:** daily check-in; watch first quote-send + invoice-send actually deliver (Resend).
- **Week 2+:** weekly check-in. Escalation: ops → engineering for anything needing DB access.
- **Fallback:** offline invoicing for the £1,000+£500; paper incident log; existing payroll bureau for RTI.

---

## 8. Go / No-Go
**YELLOW-GREEN** (safe for a high-touch design-partner) **once P0-A is resolved and P1-1/P1-2 are addressed/verified.** Until the production DB is restored, effective status is **RED (service down)** — not because the product is unsafe, but because it is currently unavailable.

- **Single biggest risk to Customer #1:** the production database being unavailable/unstable (P0-A now; and Supabase project/billing/SMTP hygiene generally) — a builder mid-job with no access loses trust instantly.
- **Single highest-value thing to build/fix next:** the central Money-area authorization guard (P1-1) — it's a genuine confidentiality/integrity gap, small to fix, and removes the one thing that blocks handing out staff logins.
