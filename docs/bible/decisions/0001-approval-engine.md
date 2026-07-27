# ADR 0001 — The Approval Engine

> **Status:** Accepted · **Date:** 2026-06-25 · **Directive:** CEO Directive 010,
> Phase 2 (Approval Workflow) · **Supersedes:** none · **Superseded by:** none
>
> This is the first Architecture Decision Record under the rule in
> [`../README.md`](../README.md) ("The rule: document before you build"). It is
> recorded in the **same PR** as the code it describes, and it covers a **major**
> architectural decision: the shared approval substrate that *every* future AI
> employee inherits.

---

## Context

CrewFlow is building a workforce of permissioned, audited AI employees. The
first conversion employee (Outreach AI, Directive 010) must never act on a
customer-facing, money-moving, or record-changing decision without a human
having approved it. The CEO's constraint is explicit and architectural, not
procedural:

> "No autonomous customer communication until the platform has earned that
> trust — enforced through architecture, not convention."

Phase 1 (PR #186) was a reuse audit: it concluded the existing tables were
sufficient to *seed* an Outreach employee, and it made no new architectural
decision (hence it shipped no ADR). Phase 2 is different. There is no existing
primitive that gates a proposed action behind a reviewable, auditable, immutable
human decision. The reuse audit confirmed this gap: the Event Spine
([Volume XI](../substrate/volume-11-event-bus.md)) records what *happened*, but
nothing decides what is *allowed to* happen and holds it pending judgement.

The decision must be **shared infrastructure, not Outreach-specific code**. The
CEO named the inheritors: Sales, Customer Success, Finance, Business Coach, and
Voice AI all gate actions behind the same engine. So the question this ADR
answers is: *what is the one approval substrate the whole workforce inherits, and
how is its security boundary made unbypassable?*

## Decision

Build a generic, deterministic **Approval Engine** in four mirrored layers, with
the **database as the single enforcer**.

1. **A pure state machine** ([`lib/approvals/state.ts`](../../../lib/approvals/state.ts)).
   Five states partitioned into *active* (`pending`, `escalated`) and *terminal*
   (`approved`, `rejected`, `expired`), and six actions (`request`, `edit`,
   `escalate`, `approve`, `reject`, `expire`). The transition table is total and
   deterministic: every (action, state) pair has a stable yes/no answer. The six
   actions map 1:1 onto the **six reserved `approval.*` verbs** the event
   registry already froze — the engine mints no new vocabulary. This module is a
   **mirror, not the enforcer**: it has no I/O, so the reviewer UI and the service
   can import it to decide which buttons to show and to fail fast with a clean
   error *before* the database does.

2. **A generic table + two triggers** as the enforcer
   ([`supabase/migrations/20260730000000_hq_approvals.sql`](../../../supabase/migrations/20260730000000_hq_approvals.sql)).
   `public.hq_approvals` is RLS-locked (HQ-only; no policies, so only the
   service-role admin client reaches it) and *generic* — `subject_type` /
   `subject_id` let any employee gate any subject. A `BEFORE` trigger enforces the
   state machine in SQL: born `pending`; terminal rows are frozen
   (`restrict_violation`); write-once columns (proposed payload, employee,
   correlation) cannot change; illegal transitions (including **de-escalation**)
   are rejected; `approve`/`reject` require a reviewer; `reject` requires a
   reason. An `AFTER` trigger (SECURITY DEFINER, `search_path=''`) emits the
   canonical `approval.*` event into the append-only spine **in the same
   transaction**, so the audit record and the state change are atomic.

3. **A thin, HQ-gated service**
   ([`server/services/hq-approvals.ts`](../../../server/services/hq-approvals.ts)).
   `request` is open to employees; every *decision* (`approve`/`reject`/`edit`/
   `escalate`/`recover`) passes a reviewer-permission gate first and records admin
   activity on success. The service is a convenience and a fast-fail layer — it is
   **not** the security boundary. The boundary is the trigger.

4. **The append-only spine** as the immutable audit trail. Every transition emits
   exactly one `approval.*` event with the honest actor (`ai_employee` for the
   request, `human` for decisions, `system` for expiry). `edit` records a revision
   **without moving state** and chains causation, so an edit-then-approve in one
   update is reconstructable as `edited → granted`.

**Recovery is not a transition.** A terminal row is immutable. Recovering a
rejected or expired proposal is a *fresh* `request` that carries `supersedes_id`
back to the old row — the history is never rewritten, only appended to.

## Alternatives weighed

- **A `status` column instead of a state machine.** Rejected. A column records
  *where* a row is but not *which moves are legal*; the path from proposal to
  decision would be ad hoc and unreconstructable. An enumerated machine makes the
  legal moves a named, total, deterministic map — and makes "no de-escalation"
  and "terminal is frozen" *provable*, not conventional.

- **Enforcement in the application layer.** Rejected as the *boundary*. App-layer
  checks are bypassable (a second caller, a future service, a migration script).
  The CEO required architecture, not convention, so the **database trigger** is
  the enforcer and the TypeScript is the mirror. The security suite
  ([`__tests__/security/approvals-invariants.test.ts`](../../../__tests__/security/approvals-invariants.test.ts))
  pins that the two never diverge; the integration suite proves the trigger
  actually refuses illegal moves against real Postgres.

- **An Outreach-specific `outreach_approvals` table.** Rejected as duplication.
  The directive is explicit that this is shared infrastructure. A `subject_type`/
  `subject_id` pair makes one table serve every employee, so the next employee
  inherits the engine instead of cloning it.

- **Mutable recovery (un-rejecting a row / soft-delete).** Rejected. Mutating a
  terminal row destroys the immutability of the decision record. Supersede-by-new-
  request keeps the audit trail append-only and the old decision permanent.

## Consequences

**What the workforce inherits.** One engine: a deterministic, auditable, RLS-
locked approval substrate. A new employee gates an action by writing a `pending`
row with its `subject_type`; it inherits the queue, the reviewer permissions,
editing, rejection-with-reason, escalation, expiry, recovery, and the immutable
spine trail for free. No employee re-implements any of it.

**Security boundary.** Decisions are reachable only through the HQ admin client
behind the reviewer gate; the table is RLS-locked with no policies; the trigger
refuses every illegal or terminal mutation regardless of caller. The boundary
cannot be bypassed from the application layer because the application layer is not
the boundary.

**What this explicitly does NOT do.** Per the directive, Phase 2 builds *only*
the approval infrastructure. It does **not** send anything, does **not** generate
outreach, and does **not** automate any decision. The engine holds proposals for
humans; it never acts.

**Validation bar.** The engine ships behind the full six-gate suite — typecheck,
lint, unit (the state machine, pure and exhaustive), security (the source-of-
truth invariants), integration (the lifecycle against real Postgres), and e2e —
consistent with Directive 004.

**Follow-ups (not in this PR, to avoid scope creep).** The reviewer **UI** (the
review queue and decision controls that consume `legalActions`/`isTerminal`); the
**expiry scheduler** that drives `expireDueApprovals`; and the roadmap/Bible-
volume reconciliation that records the Approval Engine in Volume XII. Each is its
own reviewable change.
