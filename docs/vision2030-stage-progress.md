# Vision 2030 — customer-platform programme progress

> Tracks the **Master Execution Directive**: finish the remaining Core
> Construction Platform (Stage One) + the majority of Stage Two AI employees.
> Separate from `docs/roadmap.md`, which tracks the HQ AI-boardroom / Sales-AI
> programme. Updated after every milestone.
>
> **Last updated:** 2026-07-18 · Site Management → **Snagging** shipped (PR #367,
> all 8 CI gates green, unmerged per protocol). Next vertical in build: **Daily
> Diary**.

## Standing reality (read first)
- **Nothing is in production yet.** The directive branch is ~21 PRs / 151
  migrations ahead of `main`; the CEO merges in batches by explicit
  authorisation. A release checkpoint (validation PR #363 exists) is the way
  Stage One value starts landing.
- Every vertical here is **additive + dark-safe + reversible** unless flagged.

## Stage One — remaining Core Platform

| Domain | Status | Notes |
|---|---|---|
| **1. Blueprint Centre** | ◻ not started | Canvas/PDF epic (markups, comparison, measurements, mobile viewer) — needs a **new client rendering dependency** + its own multi-milestone plan. Sequence after the additive Site-Mgmt cluster. |
| **2. Customer Portal (remainder)** | ◐ partial | Portal exists (payments, uploads, proofs). Warranties, completion certs, maintenance reminders, richer timeline/feed, blueprint/AI updates — pending. |
| **3. Variation Management** | ◐ partial | Some variation surface exists. Invoice amendments, approvals, profitability/financial impact, portal integration, doc generation — pending. |
| **4. Site Management** | ◑ **in progress** | **Snagging ✅ shipped (PR #367).** Daily Diary — **in build**. Toolbox Talks / RAMS, Site Reports, progress photos, H&S, inspections, site issues — pending. Weather intelligence needs an external API (gated). |
| **5. Financial Operations** | ◐ partial | Expenses/finances/tax exist. CIS, purchase orders, retention tracking, supplier reconciliation, payment scheduling, finance dashboard — pending. CIS = HMRC correctness; may need a product decision. |
| **6. Asset Management** | ◻ not started | Fleet/vehicles/equipment, QR codes, inspections, maintenance, servicing, allocation. Clean additive cluster (like Site Mgmt). |
| **7. Customer Experience** | ◑ ongoing | Premium-feel polish shipped across PRs #364–#366 (onboarding, empty states, loading, copy, breadcrumbs, autofocus). Ranked backlog in `docs/cx-acceleration.md`. |

**Dependency-safe next verticals (no CEO decision / no external creds):** Daily
Diary → Toolbox Talks/RAMS → Site Reports (finish Site Mgmt) → Asset Management →
Purchase Orders. Then Blueprint Centre (with its own plan) and the gated items.

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
| 2026-07-18 | Site Management → **Snagging** (defect tracking) | #367 | 8/8 green (run 29636079568) |
| 2026-07-18 | CX Acceleration (empty states, quote-flow, copy, breadcrumbs) | #366 | 8/8 green |
| 2026-07-18 | First Customer Experience polish | #365 | green |
| 2026-07-18 | First Impression Experience (onboarding + sample data) | #364 | green |
