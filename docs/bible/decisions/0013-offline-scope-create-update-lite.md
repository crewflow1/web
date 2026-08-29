# ADR 0013 — Offline scope: create/update-lite, not "the entire app offline"

- **Status:** Accepted (records a decision already shipped across the Blueprint
  Centre and PWA waves; written down per the 2026-08-29 master reconciliation's
  documentation actions)
- **Date:** 2026-08-30

## Context

Early roadmap language promised "the entire app offline". What actually
shipped — deliberately, wave by wave — is a narrower, reasoned scope:

- **PWA offline shell** (#411): install + an offline-capable shell with an
  honest offline indicator; navigation to cached surfaces keeps working.
- **Offline READ for site-critical references** (#410): blueprints and their
  pins/markup are readable on site with no signal (`blueprint-offline.spec.ts`).
- **Offline CREATE for site capture** (site diary / site reports): writes queue
  locally and replay through the SAME shared write core as the online form
  (`offline-diary-queue.spec.ts`), so a replayed report is indistinguishable
  from an online one — including its allocated report number.

## Decision

Offline scope is **read-what-a-site-needs + queue-what-a-site-captures**
(create/update-lite). Full-app offline — offline money, offline scheduling
mutations, offline approvals, cross-device conflict resolution — is **out of
scope by decision**, not by omission.

## Rationale

1. **The site is the offline place.** Signal loss happens on site; what a
   crew needs there is references (blueprints, RAMS, job details) and capture
   (diary, reports, photos). Money, approvals and scheduling are office
   workflows on connected devices.
2. **Conflict surface.** Queued creates are append-only and conflict-free by
   construction. Offline UPDATE of shared records (quotes, invoices,
   schedules) requires a conflict-resolution model whose failure modes
   (silently losing a colleague's edit, double-billing on replay) are worse
   than the offline gap it closes — especially for financial records where
   the write-once/immutability doctrine applies.
3. **Honesty over breadth.** A page that renders stale money data offline
   without saying so is a lie; the shipped scope renders cached references
   with the offline state visible, and refuses what it cannot do safely.

## Consequences

- Roadmap atoms reading "entire app offline" are classified **G (superseded
  by this decision)** in the master reconciliation, not D (missing).
- Extending offline to a new surface means extending the QUEUE-REPLAY model
  (shared write core, idempotent replay), never ad-hoc local mutation.
- Revisiting full-app offline is a product decision that must answer the
  conflict-resolution question first.
