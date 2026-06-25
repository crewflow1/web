# CrewFlow Governance — The Architecture Freeze

> **Status:** Governance **record**. This file names the platform contracts that
> are **architectural foundations** — the shared substrate every AI employee
> inherits — and freezes the rule that **changing any of them requires an explicit
> ADR _and_ an architectural review**, in the same PR as the change. Issued under
> CEO Directive **#011** (*Governance, Numbering & Scope Reconciliation*; Master
> Roadmap **D-01**).
>
> The freeze governs **how these contracts may change**, not whether they are
> finished. Several are only partially built or still reserved; the status column
> records that honestly. Freezing an unfinished contract means its *eventual* shape
> is load-bearing enough that it may not be altered casually — not that it already
> exists in full.

---

## 1. Why a freeze, and why now

CrewFlow's design rests on a single promise: **employee #42 inherits exactly the
same architecture as employee #3.** That promise only holds if the substrate every
employee stands on is stable. A change to the Event Spine, the SDK envelope, or the
`RunContext` is not a local edit — it silently re-shapes every employee that has
ever run or will ever run.

So these contracts are placed under a **freeze**: they remain changeable, but only
through a deliberate, reviewed, recorded path. The freeze is the mechanism that
keeps "shared substrate" from quietly forking into per-employee special cases.

This record does **not** itself change any contract. It enumerates them, records
their current build status truthfully, and binds the change-control rule.

---

## 2. The rule (what "frozen" means)

A contract in §4 is **frozen** in the following sense:

1. **No frozen contract changes without an ADR.** The change is recorded in
   `docs/bible/decisions/NNNN-*.md` (numbering per [`numbering.md`](./numbering.md)
   §5), in the **same PR** as the code/schema change — never after the fact.
2. **No frozen contract changes without an architectural review.** A human reviewer
   with substrate authority signs off that the change preserves the inheritance
   promise (or knowingly, explicitly breaks it with a migration plan).
3. **The ADR states the blast radius.** Because these contracts are inherited, the
   ADR must name *which employees and which historical rows* are affected, and how
   (migrate / alias / freeze).
4. **Extend before replace.** A frozen contract is widened by addition (new optional
   fields, new verbs appended to the registry) in preference to redefinition. A
   breaking redefinition is the exception that most needs the ADR + review.

Anything **not** in §4 is ordinary application code and changes through the normal
PR process — no ADR required.

---

## 3. How to read the status column

| Tag | Meaning |
|---|---|
| **Established** | Built and load-bearing in running code today. Evidence cited. |
| **Partial** | Real code exists but only covers part of the contract's intended surface. |
| **Reserved** | Specified in the Bible, **not yet built** in code. Frozen so its eventual shape is designed once, deliberately — not improvised. |

The freeze applies to **all three** tags. A Reserved contract is frozen precisely so
the *first* implementation goes through ADR + review rather than landing ad hoc.

---

## 4. The frozen contracts (the CEO-named ten)

| # | Contract | Status | Where it lives today |
|---|---|---|---|
| 1 | **Event Spine** | **Established** | Append-only `hq_events` with `hq_emit_event` AFTER-trigger enforcer (`supabase/migrations/20260720000000_hq_event_spine_core.sql` + producers/consumers/backfill); frozen verb registry `lib/events/registry.ts` |
| 2 | **Shared Memory** | **Established** *(prod migration gated)* | `supabase/migrations/20260713000000_hq_shared_memory.sql` + write/recall/embeddings/lifecycle/forget migrations; SDK facet `server/sdk/memory.ts`. Canonical Directive **#009**. |
| 3 | **AI SDK** | **Partial** | Only the **Memory facet** is built (`server/sdk/memory.ts` — `createMemory` / `BoundMemory`). The full per-employee SDK envelope is not yet written. Owned by the AI SDK directive (D-04 / **#014**). |
| 4 | **RunContext** | **Reserved** *(embryonic)* | Referenced **only as intent** in `server/sdk/memory.ts` comments ("the future RunContext … can drain them into the output envelope"). No implementation. Designed under D-04 / **#014** alongside the SDK. |
| 5 | **Task Engine** *(generic)* | **Reserved** *(spec only)* | Bible `substrate/volume-12-task-engine.md`. No generic `hq_tasks` engine in code yet; today's task-like flows are per-feature, not the shared engine. |
| 6 | **Approval Engine** | **Established** | `supabase/migrations/20260730000000_hq_approvals.sql`; `server/services/hq-approvals.ts`; **ADR 0001**. Shipped under **#010**. |
| 7 | **Communication Layer** | **Established** *(PR pending merge)* | `supabase/migrations/20260801000000_hq_communications.sql`; `server/services/hq-comms.ts`; **ADR 0003**. **#010** Phase 4. |
| 8 | **Capability Registry** | **Reserved** *(spec only)* | Bible (`substrate/`, `workforce/`). No capability-registry table or resolver in code; employee scopes are enforced ad hoc today. |
| 9 | **Boardroom interfaces** | **Partial** *(read-only)* | Admin read surfaces only: `app/admin/*`, `server/services/ai-employee-stats.ts`, `lib/ai-employees/*`. No write/decision interface; the Boardroom observes, it does not yet act. |
| 10 | **Shared Communication Protocol** | **Reserved** *(spec only)* | Bible `substrate/volume-09-communication-protocol.md`. No **agent-to-agent** messaging in code — distinct from the (built) Communication Layer, which is outbound delivery to humans, not inter-employee messaging. |

> **Sibling note — Draft Generation (ADR 0002).** The shipped engine trio of
> **#010** is Approval (ADR 0001) · Draft (ADR 0002) · Communication (ADR 0003).
> Draft Generation (`supabase/migrations/20260731000000_hq_drafts.sql`,
> `server/services/hq-drafts.ts`) is **Established** and is governed by this freeze
> as a member of the same engine family, even though it is not one of the ten
> separately named contracts.

---

## 5. Two distinctions the freeze must not blur

- **Communication Layer ≠ Shared Communication Protocol.** #7 is the built,
  gated, audited substrate that delivers messages **outward to humans** (email and
  the like). #10 is the **not-yet-built** protocol by which employees message **each
  other**. They share a word, not a contract. Freezing both keeps the future
  inter-employee protocol from being improvised on top of the human-delivery layer.
- **AI SDK ≠ Shared Memory.** The Memory facet is the **only** part of the SDK that
  exists. "The SDK is built" would be an overclaim; "the SDK's memory facet is built"
  is the truth. The freeze covers the whole envelope so the rest is designed to match
  the facet, not the other way round.

---

## 6. Relationship to the rest of governance

- **Numbering:** directive/ADR/volume numbers are governed by
  [`numbering.md`](./numbering.md). ADRs referenced here (0001–0003) live in
  [`../decisions/`](../decisions/); the next free ADR number is **0004**.
- **Runtime identity:** the `actor_id` an employee stamps onto Event Spine rows is a
  separate frozen concern recorded in [`runtime-identity.md`](./runtime-identity.md);
  its canonical decision is deferred to D-04 / **#014**.
- **What "done" looks like:** the bar for declaring these contracts *complete* (not
  merely frozen) is set by the **CrewFlow Version 1.0 Constitution**
  ([`../../crewflow-v1.0-constitution.md`](../../crewflow-v1.0-constitution.md)).

---

*Documentation only. No contract, schema, migration, or service was changed by this
record. It binds a change-control rule for future edits. Adopted under CEO Directive
#011 (Master Roadmap D-01).*
