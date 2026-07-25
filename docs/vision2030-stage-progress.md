# Vision 2030 — customer-platform programme progress

> Tracks the **Master Execution Directive**: finish the remaining Core
> Construction Platform (Stage One) + the majority of Stage Two AI employees.
> Separate from `docs/roadmap.md`, which tracks the HQ AI-boardroom / Sales-AI
> programme. Updated after every milestone.
>
> **Last updated:** 2026-07-21 · **RC3 CUT OVER TO PRODUCTION 2026-07-20 —
> the full Stage-One platform is LIVE at crewflow.uk.** Reconciled against the
> repository by the Programme E audit (see `docs/stage-one-reconciliation.md`).
> Post-cutover commercial fast-follows (#398–#401) are **built + CI-green but
> UNMERGED** — not in production. Asset Management is complete at the
> data/domain/action tier (`docs/asset-management.md`); it has **no
> authenticated E2E** (login-harness gated).

## Standing reality (read first)
- **Production is LIVE.** RC3 — the whole platform (Directive #018 foundation +
  Site Mgmt + Assets + Commercial + CX) — was merged to `main` (`295d810`) and
  deployed on **2026-07-20** (`94eeea8` "reopen production after RC3 cutover";
  crewflow.uk serves 200; Vercel prod Ready). **`main` = 170 migrations, tip
  `20261007`.** RC3 superseded the stale RC2 #375. Pre-cutover RC3 artifacts
  (`RELEASE-MANIFEST-RC3.md`, `CTO-RELEASE-REPORT-RC3.md`,
  `PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md`, `CTO-BASELINE-VERIFICATION-RC3.md`)
  are **superseded records** — their "DO NOT MERGE/DEPLOY" language is historical.
- **Prod is one migration AHEAD of `main`.** The `20261008` impersonation
  quote/invoice-numbering fix was applied out-of-band during QA, so prod has 171
  migrations (latest `20261008`) while `main` stops at `20261007`. That fix lives
  on unmerged PR #398 — merging #398 realigns `main` with prod. (Prod's current
  behaviour is fail-closed stricter, so this is a workflow gap, not a security
  regression.)
- **Unmerged after RC3, NOT in prod:** #398 (types regen + `20261008`), #399
  (supplier bills, `20261009`), #400 (payment allocation, `20261010`), #401
  (commercial lifecycle / Programme D, no migration), plus Programme E's own
  reconciliation fixes (`20261011` PO org-integrity, `20261012` retention
  concurrency). "CI-green on a branch" ≠ "shipped to prod".
- **Known LIVE defect (fixed only on unmerged #401):** the job page derives
  "outstanding" from invoice *status*, so a partly-paid invoice reads as fully
  collected (£0 outstanding). Programme D fixes it from the payment ledger;
  until #401 merges the defect is in production.
- Every vertical here is **additive + dark-safe + reversible** unless flagged.
  The one irreversible migration is `20260812` (LR5.4B); it has a pre-snapshot.

## Stage One — remaining Core Platform

| Domain | Status | Notes |
|---|---|---|
| **1. Blueprint Centre** | ◻ not started | Canvas/PDF epic (markups, comparison, measurements, mobile viewer) — needs a **new client rendering dependency** + its own multi-milestone plan. Sequence after the additive Site-Mgmt cluster. |
| **2. Customer Portal (remainder)** | ◑ largely shipped | In prod (RC3). Portal completion #390 — shell coherence (7 tabs incl. Reports + Documents on one `PortalShell`), an **action centre** (overdue/due payments + quote decisions with precise £ + deep-links), a **document library** (quote/invoice/report PDFs; excludes arbitrary attachments = no leak). Single auth authority (`loadCustomerByPortalToken`), uniform org_id+customer_id query scoping (security-audited). **Correction (Programme E):** report-decision surfacing in the action centre is NOT shipped (`page.tsx` passes `reports: []`; the branch carries no £) — do not describe it as done. Warranties, completion certs, maintenance reminders, online pay, customer upload — pending. |
| **3. Variation Management** | ✅ **materially complete** | Variation model/creation/lifecycle/register pre-existed (`20260520180000`). Added: **job commercial position** #391 (original preserved, revised value DERIVED from approved variations, pending shown separately) + **accepted-quote immutability** #392 (DB triggers freeze an accepted quote's amounts & line items; "raise a variation" is now the *only* scope-change path). Shared `lib/money`. Doc generation via the existing quote PDF. |
| **4. Site Management** | ◑ largely shipped | Snagging #367 · Daily Diary #368 · Toolbox Talks #369 · Site Reports #370–#372 (immutable, PDF, portal). Progress-photo galleries + weather intelligence (external API, gated) remain. |
| **5. Financial Operations** | ◑ largely shipped | **In prod (RC3):** construction retention #393 (`jobs.retention_percent` + append-only `retention_releases`; held DERIVED, DB-enforced no-over-release/immutability/org-integrity) · purchase orders #394 · committed vs actual on the job P&L #395. Expenses/finances/tax/profitability pre-existed. **Built + CI-green, UNMERGED (not in prod):** supplier bills #399 (extends `finances`, no fork) · payment allocation #400 (`payments` parent over `invoice_payments`, concurrency-safe guard — the "1↔1" limit is still LIVE until merged) · commercial lifecycle #401 (fixes the status-based-outstanding defect). **Programme E fixes (unmerged):** PO cross-tenant org-integrity guard `20261011`, retention concurrency lock `20261012`. **CIS = HMRC correctness → explicit product decision, excluded.** |
| **6. Asset Management** | ✅ **core complete (M1–M5 + integration); polish + auth-E2E pending** | In prod (RC3). Register #373 · custody #374 · QR #376–#379 · inspections #380–#385 (immutable records, safety-blocking custody, versioned templates, idempotent scheduling, audited overrides + reinspection lineage) · maintenance #386–#388 (state machine, costs privacy, service scheduler, RTS loop) · integration (job-linked assets, holdings, unified history). DB-enforced invariants + real-Postgres proofs throughout. **Honest scope:** the data/domain/action/UI-wiring tier is complete; **no authenticated E2E exists** (all asset E2E specs are auth-boundary stubs — login-harness gated), and documented deferrals remain (full-asset edit form, per-item photo binding, drawn signatures, dashboards/exports, capability model — see `docs/asset-management.md`). |
| **7. Customer Experience** | ◑ ongoing | Premium-feel polish shipped across PRs #364–#366 (onboarding, empty states, loading, copy, breadcrumbs, autofocus). Ranked backlog in `docs/cx-acceleration.md`. |

**Commercial programme A–E complete** (all built + CI-green). In prod via RC3:
A portal completion, B variations (value + accepted-quote immutability), C
retention + POs + committed costs. Built but **unmerged**: supplier bills #399,
payment allocation #400, commercial lifecycle #401 (Programme D), Programme E
reconciliation. **Next dependency-safe verticals (no CEO decision / no external
creds):** merge the unmerged commercial stack (#398→#399→#400→#401→E) to land the
outstanding-cash fix + supplier bills + allocation in prod → commercial
fast-follows (customer-portal commercial projection, retention release
due-dates/reminders, outstanding rollups on jobs-list + dashboard). Then the
**Blueprint Centre** epic (its own multi-milestone plan; needs a new client
rendering dependency) and the gated items (CIS, warranties, weather API).

## Stage Two — AI employees

| Capability | Status | Gate |
|---|---|---|
| **Execution kernel** (#012–#018: Task Engine, RunContext, AI-SDK envelope, Capability Registry, shadow + controlled-live executor) | ✅ built, **merged in RC3 — running dark/shadow-only in prod** (foundation #269–#274 folded into the 170 migrations) | live but shadow; controlled-live gated on product decision |
| **WhatsApp Employee** | ◑ inbound foundation merged to directive (#359); draft-first engine + approved-outbound built dark (#360/#361, unmerged) | **autonomy = product decision**; media/voice = external creds |
| **AI Quote Writer / Scheduler / Business Coach / Job Manager / Insights / Knowledge Engine / Automation** | ◻ framework only | **external creds** (LLM keys) + product scoping |
| **AI Voice / phone** | ◻ not started | **external infrastructure** (telephony, transcription) |

**Honest read:** Stage Two's *substrate* is built and dark. The *headline
behaviours* — autonomous conversations, image/voice/multilingual understanding,
phone AI — are gated on (a) a product decision that reverses the standing
draft-first / human-gated / outbound-OFF model, and (b) external credentials +
infrastructure not present in the environment. These are explicit stop conditions
in the master directive; they are surfaced, not silently skipped or faked-dark.

## Milestone changelog
> Status legend: **PROD** = merged + live · **UNMERGED** = built + CI-green on a branch, not in prod.
| Date | Milestone | PR / branch | Status · Gates |
|---|---|---|---|
| 2026-07-21 | **Programme E** → repository-grounded Stage One reconciliation (+ PO org-integrity `20261011`, retention concurrency `20261012`) | `feat/programme-e-reconciliation` | UNMERGED · unit/integration/security green |
| 2026-07-21 | Commercial D → **unified commercial lifecycle** (cash-first; fixes ledger-truth outstanding) | #401 | UNMERGED · 21 unit · 3 integration · 3 security |
| 2026-07-21 | Financial → **payment allocation** (one receipt → many invoices; concurrency-safe) | #400 | UNMERGED · 14 unit · 5 integration/concurrency |
| 2026-07-21 | Financial → **supplier bills** (committed → actual) | #399 | UNMERGED · 6 unit · 4 integration |
| 2026-07-20 | **RC3 CUT OVER TO PRODUCTION** (full Stage-One platform live) | #397 `295d810`→`94eeea8` | **PROD** · deployed crewflow.uk |
| 2026-07-20 | first-customer-readiness → types regen + impersonation numbering fix `20261008` | #398 | UNMERGED (`20261008` applied to prod out-of-band) |
| 2026-07-20 | Commercial C → **committed costs (POs) on the job P&L** | #395 | PROD (via RC3) · 8/8 green |
| 2026-07-20 | Commercial C → **purchase orders** (procurement / committed spend) | #394 | 8/8 green (`purchase-orders.test.ts` 5) |
| 2026-07-20 | Commercial C → **construction retention** (contract holdback) | #393 | 8/8 green (`retention.test.ts` 8) |
| 2026-07-20 | Commercial B → **accepted-quote immutability** (freeze amounts & scope) | #392 | 8/8 green (`accepted-quote-immutability.test.ts` 9) |
| 2026-07-20 | Commercial B → **job commercial position** (revised value) | #391 | 8/8 green |
| 2026-07-20 | Commercial A → **portal completion** (shell · action centre · doc library) | #390 | 8/8 green |
| 2026-07-18 | Site Management → **Snagging** (defect tracking) | #367 | 8/8 green (run 29636079568) |
| 2026-07-18 | CX Acceleration (empty states, quote-flow, copy, breadcrumbs) | #366 | 8/8 green |
| 2026-07-18 | First Customer Experience polish | #365 | green |
| 2026-07-18 | First Impression Experience (onboarding + sample data) | #364 | green |
