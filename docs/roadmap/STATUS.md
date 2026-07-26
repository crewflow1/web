# CrewFlow — Status at a glance (post-`20261037`)

**Baseline:** prod `main` = `ed748b5` · migration tip `20261037` · providers dark except email ·
PITR healthy. Full detail + evidence: [MASTER-ROADMAP-POST-20261037.md](./MASTER-ROADMAP-POST-20261037.md) (canonical).
Last reconciled 2026-07-26 (26 domain reviews). **Do not treat any older roadmap doc as current.**

## ✅ LIVE (in production today)
Leads · customers · quotes + e-sign acceptance · auto job+invoice · variations · invoices
(PDF/send/remind) · payments + multi-invoice allocation · construction retention + release
scheduling · purchase orders · supplier bills · job profitability · **jobs + calendar + rota**
· clock-in→payroll→payslip/CSV · **RAMS · permits · toolbox talks · operative sign-off · H&S
PDFs** · snags · diary · site reports · completion certificates · **Blueprint Centre (viewer/
pins/markup/compare/offline/PWA)** · assets (QR/inspections/maintenance) · customer portal ·
dashboard/reports/VAT summary · compliance register · transactional email · onboarding + sample
data · impersonation · **evidence integrity (SHA-256 + write-once + cross-tenant binding)**.

## 🟡 PARTIAL / needs work
Job profitability (draft invoices inflate it) · commercial cash (retention not netted) ·
invoices (quote-only, no deposit/interim) · expenses OCR (drops job_id) · timesheets
(read-only) · CrewFlow billing (admin-only, no self-serve) · logo (URL-paste) · job status
(no state machine) · calendar/rota (not in sidebar; rota half-built).

## ⚫ DARK (built, provider/flag-gated) · 🚫 MISSING
DARK: SMS · WhatsApp inbound · missed-call text-back · AI insights/Q&A/receptionist/drafts/
memory · AI-employees (shadow) · observability (Sentry — no DSN).
MISSING: online invoice payment · self-serve billing · trial-expiry gate · GDPR/account
deletion · PO send-to-supplier · subcontractor sign-off · CIS · applications-for-payment ·
day-rate · NI entry UI · lead→customer convert · WhatsApp outbound (`#360-362` unmerged) ·
job-photo evidence-grade · geolocated clock-in (dead).

## ▶️ NEXT (build order)
1. **H0-SWEEP** (days) — merge `#121` (live credential-leak defect); compliance-404; draft-invoice profit fix; NI entry; `types.ts` regen + CI drift gate; env drift; drop dead deps; throttle dark crons.
2. **H1-TRUST** (M) — DB `is_org_admin` gate on commercial writes + `requireManager()`; cert `job_id` bind; job-photo evidence-grade; shared-device offline re-check; audit RAMS/permit retire.
3. **H1-OBSERVE** (S) — Sentry DSN + `/api/health` dependency probe + infra alerting + Resend bounce webhook.
4. **H1-LEGAL** (M) — GDPR org-teardown storage sweep + deletion routines.
5. **H2-CASH** (L) — standalone/deposit/interim invoicing + **online invoice payment** + retention-netting.

## 🔵 LATER (post-launch / scale)
H2-MONEY (self-serve billing) · **H2-CIS + reverse-charge VAT** (differentiation moat) ·
H2-FIELD (guest sign-off, geoloc clock-in, PO-send, nav surfacing) · H3-AI staged activation ·
H3-COMMS (SMS/WhatsApp) · Xero export · applications-for-payment · price book · WIP/CVR ·
programme/Gantt · O&M pack.

## 🛑 STOP BUILDING
AI-employee autonomous execution · new AI/HQ infra · full critical-path Gantt · QS valuation
certification · BIM/clash · inventory/stock · fleet telematics · native app · second comms
engine · event-spine expansion (0 consumers).

## ⚖️ DECISIONS REQUIRED (CEO)
1. RAMS withdraw/supersede → admin-only? *(rec: yes)*
2. Permit close/cancel → admin / responsible-person / member? *(rec: cancel+close admin-or-RP)*
3. GDPR erasure → build teardown sweep? *(rec: yes, legal-hold exception for issued H&S evidence)*
4. Completion cert → bind snapshot to `job_id`? *(rec: yes)*
5. Derive `permit_status_at_issue` / RAMS `reference` server-side? *(rec: yes)*
6. Monetization → self-serve paid signup + trial gate? *(rec: yes for scale)*
7. Compliance lane → own CIS+reverse-charge, or integrate Xero? *(rec: own CIS)*
