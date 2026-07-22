# Vision 2030 — customer-platform programme progress

> Tracks the **Master Execution Directive**: finish the remaining Core
> Construction Platform (Stage One) + the majority of Stage Two AI employees.
> Separate from `docs/roadmap.md`, which tracks the HQ AI-boardroom / Sales-AI
> programme. Updated after every milestone.
>
> **Last updated:** 2026-07-20 · **Asset Management COMPLETE (M1–M5 +
> integration): PRs #373–#374, #376–#388 — 16 CI-green PRs, migrations
> `20260924`→`20261003`, all unmerged per protocol.** Register → custody →
> QR platform → inspections (templates, scheduling, safety-blocking,
> overrides/lineage) → maintenance (cases, service scheduling, the connected
> repair→re-inspection→return-to-service loop) → cross-domain integration
> (job-linked assets, holdings, unified history). Full detail + test evidence:
> `docs/asset-management.md`.

## Standing reality (read first)
- **Nothing is in production yet.** The accumulated work is **396 commits / 70
  new migrations ahead of `main`** (170 total).
- **RC3 is the current release candidate** (`release/rc3-full-platform`, PR #397
  → `main`, **DO NOT MERGE**), produced by the Release-Recovery & CTO
  Consolidation directive. It consolidates the whole platform (Directive #018
  foundation + Site Mgmt + Assets + Commercial + CX) into one CI-green branch and
  **supersedes the stale RC2 #375** (which stopped at #374). See
  `docs/RELEASE-MANIFEST-RC3.md` + `docs/PRODUCTION-DEPLOYMENT-RUNBOOK-RC3.md`.
- Every vertical here is **additive + dark-safe + reversible** unless flagged.
  The one irreversible migration is `20260812` (LR5.4B); it has a pre-snapshot.

## Stage One — remaining Core Platform

| Domain | Status | Notes |
|---|---|---|
| **1. Blueprint Centre** | ◻ not started | Canvas/PDF epic (markups, comparison, measurements, mobile viewer) — needs a **new client rendering dependency** + its own multi-milestone plan. Sequence after the additive Site-Mgmt cluster. |
| **2. Customer Portal (remainder)** | ◑ largely shipped | Portal completion #390 — shell coherence (Reports + Documents tabs on one `PortalShell`), an **action centre** (overdue/due payments, quote decisions, report decisions with precise £ + deep-links), a **document library** (quote/invoice/report PDFs; deliberately excludes arbitrary attachments = no leak). Single auth authority (`loadCustomerByPortalToken`) preserved. Warranties, completion certs, maintenance reminders, online pay, customer upload — pending. |
| **3. Variation Management** | ✅ **materially complete** | Variation model/creation/lifecycle/register pre-existed (`20260520180000`). Added: **job commercial position** #391 (original preserved, revised value DERIVED from approved variations, pending shown separately) + **accepted-quote immutability** #392 (DB triggers freeze an accepted quote's amounts & line items; "raise a variation" is now the *only* scope-change path). Shared `lib/money`. Doc generation via the existing quote PDF. |
| **4. Site Management** | ◑ largely shipped | Snagging #367 · Daily Diary #368 · Toolbox Talks #369 · Site Reports #370–#372 (immutable, PDF, portal). Progress-photo galleries + weather intelligence (external API, gated) remain. |
| **5. Financial Operations** | ◑ largely shipped | Expenses/finances/tax/profitability pre-existed. Added: **construction retention** #393 (`jobs.retention_percent` + append-only `retention_releases`; held DERIVED, DB-enforced no-over-release/immutability/org-integrity; commercial holdback, NOT CIS) · **purchase orders** #394 (per-org PO-NNNN, status lifecycle, committed spend kept separate from `finances`) · **committed vs actual on the job P&L** #395. Pending: supplier bills (extend the `finances`/`expense_drafts` cost flow — do NOT fork), **payment allocation** (invoice_payments is 1↔1; needs a `payment_allocations` join + a retargeted status-sync trigger — flagged concurrency-sensitive). **CIS = HMRC correctness → explicit product decision, excluded.** |
| **6. Asset Management** | ✅ **complete (M1–M5 + integration)** | Register #373 · custody #374 · QR #376–#379 · inspections #380–#385 (immutable records, safety-blocking custody, versioned templates, idempotent scheduling, audited overrides + explicit reinspection lineage, org-wide attention) · maintenance #386–#388 (state machine, costs privacy, service scheduler, connected RTS loop) · integration (job-linked assets, holdings, unified history). DB-enforced invariants + real-Postgres proofs throughout; authenticated lifecycle E2E gated on the login harness (tracked). |
| **7. Customer Experience** | ◑ ongoing | Premium-feel polish shipped across PRs #364–#366 (onboarding, empty states, loading, copy, breadcrumbs, autofocus). Ranked backlog in `docs/cx-acceleration.md`. |

**Dependency-safe next verticals (no CEO decision / no external creds):** supplier
bills (extend the existing expense→finances flow) → committed-cost rollups / finance
dashboard → payment allocation (invoice_payments 1↔1 → allocations join; concurrency
proof required) → unified commercial lifecycle timeline (Programme D). Then Blueprint
Centre (its own plan) and the gated items (CIS, warranties, weather API).

## Stage Two — AI employees

| Capability | Status | Gate |
|---|---|---|
| **Execution kernel** (#012–#018: Task Engine, RunContext, AI-SDK envelope, Capability Registry, shadow + controlled-live executor) | ✅ built, **dark**, unmerged (PRs #269–#274 etc.) | ships with the directive release |
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
| Date | Milestone | PR | Gates |
|---|---|---|---|
| 2026-07-22 | Phase 2 WOW → **Blueprint Centre foundation** (versioned drawing register; canvas/pins = m2) | `feat/blueprint-centre` | unit 11 · integration 5 · security 6 (unmerged) |
| 2026-07-20 | Commercial C → **committed costs (POs) on the job P&L** | #395 | 8/8 green |
| 2026-07-20 | Commercial C → **purchase orders** (procurement / committed spend) | #394 | 8/8 green (`purchase-orders.test.ts` 5) |
| 2026-07-20 | Commercial C → **construction retention** (contract holdback) | #393 | 8/8 green (`retention.test.ts` 8) |
| 2026-07-20 | Commercial B → **accepted-quote immutability** (freeze amounts & scope) | #392 | 8/8 green (`accepted-quote-immutability.test.ts` 9) |
| 2026-07-20 | Commercial B → **job commercial position** (revised value) | #391 | 8/8 green |
| 2026-07-20 | Commercial A → **portal completion** (shell · action centre · doc library) | #390 | 8/8 green |
| 2026-07-18 | Site Management → **Snagging** (defect tracking) | #367 | 8/8 green (run 29636079568) |
| 2026-07-18 | CX Acceleration (empty states, quote-flow, copy, breadcrumbs) | #366 | 8/8 green |
| 2026-07-18 | First Customer Experience polish | #365 | green |
| 2026-07-18 | First Impression Experience (onboarding + sample data) | #364 | green |
