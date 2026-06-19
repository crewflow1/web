# CrewFlow Operating System — The Engineering Bible

**CEO Directive #008 · The definitive engineering specification · Planning artifact (no implementation)**

> **One philosophy governs everything in this document:**
> **Every piece of information inside CrewFlow should exist *once*, be *observable everywhere*, and be *actionable by AI*.**

> **One rule decides every architecture call:**
> **"If CrewFlow had one million companies using it, would we still build it this way?" If no — redesign it.**

---

## 🔒 Architecture Freeze — CrewFlow Architecture **v1.0**

> **As of CEO Directive #003.5 ("Lock the Foundation"), this Bible is the single, frozen source of architectural truth for CrewFlow.** Twenty-one chapters across six volumes describe the entire operating system. The architecture is now **locked at v1.0**; implementation builds *from* it, never *around* it.

**The three freeze rules — binding on every engineer and every future directive:**

1. **No feature is built without referencing its chapter(s).** Every implementation PR names the Bible chapter(s) it realises. If a feature has no chapter, it has no architecture — and it is not built until one exists.
2. **No engineer invents architecture outside the Bible.** The Bible is the design, not a suggestion. A deviation is not silent — it becomes an ADR in [Ch.20 §20.3](20-glossary-conventions-decision-log.md), or it does not happen.
3. **Every future directive updates the Bible *first*, then implementation follows.** A directive that changes behaviour first changes the owning chapter (with an ADR, and a consistency sweep if it touches the canon 03/04/14); only then does code change to match.

> **Architecture always comes before code.**

The freeze is *enforced* by the governance rules in [Change control & governance](#change-control--governance) below, *operationalised* by the six companion documents (next section), and *recorded* by the [CEO Gate report](../CEO-GATE.md). It is lifted only by an explicit version bump (v1.1 additive, v2.0 structural), and a bump is itself an ADR. The chapters are **drafted and frozen**; what remains is not more architecture — it is the seven CEO decisions in [Ch.20 §20.4.A](20-glossary-conventions-decision-log.md) and the gated, preview-first implementation in [Ch.19](19-rollout-plan.md).

### Companion governance documents (Directive #003.5)

These six documents sit beside the Bible (in [`../`](..)) and translate the frozen architecture into an executable programme. They are *derived from* the Bible — every number in them is traceable to a chapter — and they do not themselves define architecture.

| Document | Purpose |
|---|---|
| [`CEO-REVIEW-PACK.md`](../CEO-REVIEW-PACK.md) | The executive overview — every chapter scored for status, dependencies, build order, complexity, and business/customer/AI impact. |
| [`BUILD-DEPENDENCY-GRAPH.md`](../BUILD-DEPENDENCY-GRAPH.md) | For every feature: what must exist first, what depends on it, whether it touches billing / AI / permissions / DB / mobile. Nothing is built out of sequence. |
| [`PRIORITISATION-MATRIX.md`](../PRIORITISATION-MATRIX.md) | Every feature ranked by demand, revenue, time saved, cost, differentiation, AI leverage, and adoption → the optimal implementation order. |
| [`PHASE-7-MASTER-PLAN.md`](../PHASE-7-MASTER-PLAN.md) | The week-by-week roadmap: objectives, deliverables, milestones, testing, rollback, definition of done, risks, and success metrics per week. |
| [`IMPLEMENTATION-RULES.md`](../IMPLEMENTATION-RULES.md) | The non-negotiable Definition of Done — no feature is "complete" without the full quality bar (tests, monitoring, audit, docs, security, performance, accessibility). |
| [`CEO-GATE.md`](../CEO-GATE.md) | The final gate report answering the three questions and, if all are *yes*, declaring the freeze and authorising implementation. |

---

## Status & ground rules

| | |
|---|---|
| **Architecture version** | **v1.0 — FROZEN** (CEO Directive #003.5). The structure is complete and locked; changes are versioned ADRs, not edits-in-place. |
| **Document status** | Frozen specification — drafted in full (21/21 chapters). No production code is written from it until the CEO approves the blueprint **and** the Release Candidate (PR #171) is in production and stable. |
| **Release Candidate** | **Frozen.** Nothing enters PR #171 except release-quality QA bug fixes. No feature work, no refactoring, no cleanup. |
| **This document** | Architecture only. It describes *what* to build and *why*, in enough detail that a team of 100 senior engineers could build CrewFlow from it alone. It contains illustrative DDL, API signatures, and pseudocode — none of it is production code. |
| **Branch** | Authored on `directive-008/architecture-blueprint`. The RC branch (`feature/design-system-foundation`) is never touched by this work. |
| **Authority** | Once approved, this becomes the foundation of CrewFlow for the next decade. Every feature must reference the relevant chapter *before* a line of production code is written. |

---

## How this document is organized

The Bible is a set of **volumes**; each volume is a set of **chapters**; each chapter is one system, specified to a fixed template. Read the volumes in order the first time; thereafter treat it as a reference.

| Volume | Theme | Chapters |
|---|---|---|
| **0 — Overview** | The approved executive blueprint (the 30,000-ft view) | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| **I — Foundations** | Philosophy, architecture, the canonical data model, the event spine | 01–04 |
| **II — Platform systems** | Services/APIs, real-time, search, timeline, memory, observability | 05–06, 10–12, 15 |
| **III — The Workforce** | The AI employee framework + the dossier for each of the 12 employees | 07–08 |
| **IV — Control plane** | Mission Control, approvals & oversight, permissions/RBAC | 09, 13–14 |
| **V — Cross-cutting** | Security, scalability, testing, rollout | 16–19 |
| **VI — Reference** | Glossary, conventions, decision log, open questions | 20 |

### Master table of contents

| # | Chapter | Purpose (one line) | Status |
|---|---|---|---|
| 00 | **Index** (this file) | Map, conventions, templates | ✅ drafted |
| 01 | **Philosophy & Principles** | The thesis, the operating principles, the decision framework | ✅ drafted |
| 02 | **System Architecture** | The planes, the kernel model, the end-to-end data flow, technology choices | ✅ drafted |
| 03 | **Data Model** | Every table — existing and new — with DDL, indexes, RLS, retention | ✅ drafted |
| 04 | **Event Spine & Taxonomy** | The one event log, the canonical verb registry, delivery semantics | ✅ drafted |
| 05 | **Services & APIs** | The service layer, server actions, route handlers, contracts, versioning | ✅ drafted |
| 06 | **Real-time Infrastructure** | Supabase Realtime, server-authorized broadcast, presence, the island model | ✅ drafted |
| 07 | **AI Employee Framework** | The runtime, the lifecycle FSM, the tool registry, cost/budget | ✅ drafted |
| 08 | **AI Employee Roster** | A full dossier for each of the 12 employees | ✅ drafted |
| 09 | **Mission Control** | The OS homepage — live, connected, the centre of CrewFlow | ✅ drafted |
| 10 | **Global Search** | Cross-entity search + the ⌘K command palette | ✅ drafted |
| 11 | **Event Timeline** | The global + per-entity feed projected from the spine | ✅ drafted |
| 12 | **Memory Graph** | Episodic/semantic/procedural memory, pgvector, typed edges | ✅ drafted |
| 13 | **Approvals & Human Oversight** | The approval workflow, policy engine, the inbox | ✅ drafted |
| 14 | **Permissions & RBAC** | Capabilities, roles, the single `authorize()` chokepoint | ✅ drafted |
| 15 | **Observability, Metrics & Audit** | Tracing, the metric registry, the immutable audit log | ✅ drafted |
| 16 | **Security** | Trust boundaries, AI-specific defenses, data protection | ✅ drafted |
| 17 | **Scalability** | Partitioning, load-levelling, LLM cost control, graduation triggers | ✅ drafted |
| 18 | **Testing Strategy** | The test pyramid, RLS tests, event-contract tests, AI evals | ✅ drafted |
| 19 | **Rollout Plan** | The eight phases, flags, backout, success criteria | ✅ drafted |
| 20 | **Glossary, Conventions & Decision Log** | Shared vocabulary, ADRs, open questions | ✅ drafted |

---

## The chapter template (mandatory)

Every system chapter (05–17) **must** contain these sections, in this order. If a section is genuinely not applicable, it says so and why — it is never silently omitted. This uniformity is what lets a reader land anywhere in the Bible and know where to look.

1. **Purpose** — what this system is and the problem it solves, in plain language.
2. **Goals** — the measurable objectives; explicit non-goals.
3. **Architecture** — components, responsibilities, diagrams, data flow.
4. **Database design** — tables touched/owned, with reference to [Ch.03]; new columns; access pattern.
5. **APIs** — service functions, server actions, route handlers; signatures; contracts; error shapes; versioning.
6. **UI behaviour** — what the operator sees and does; states (loading/empty/error/live); keyboard; accessibility; the live model.
7. **Permissions** — required capabilities [Ch.14]; who (human/AI) may do what; default policy.
8. **Failure handling** — what happens when each dependency fails; retries; idempotency; degradation; dead-lettering.
9. **Edge cases** — the awkward inputs and races, enumerated and resolved.
10. **Performance** — budgets (TTFB, query time, p95); indexing; caching; the one-million-companies analysis.
11. **Security** — trust boundaries [Ch.16]; injection/abuse vectors; data exposure; secrets.
12. **Testing** — what is tested and how (unit/integration/RLS/contract/eval); fixtures; CI gates.
13. **Monitoring** — the events emitted [Ch.04]; metrics [Ch.15]; alerts; golden signals; SLOs.
14. **Future expansion** — what we deliberately deferred and the seam left for it.

---

## The AI Employee dossier template (mandatory for every employee in Ch.08)

An AI employee is specified like a real hire. Every employee in the roster has all of:

| Field | Meaning |
|---|---|
| **Identity** | Slug, display name, avatar/accent, department, one-line mandate |
| **Role** | The job, in the org, in one paragraph |
| **Manager** | Which employee/human it reports to; who it manages (the org chart edge) |
| **Responsibilities** | The concrete duties it owns |
| **Permissions** | The capabilities it holds [Ch.14] |
| **Memory** | What it remembers; what it reads from / writes to the graph [Ch.12] |
| **KPIs** | How its performance is measured [Ch.15] |
| **Costs** | Token/$ budget model; expected unit costs |
| **Performance reviews** | The periodic evaluation: cadence, rubric, who reviews |
| **Escalation rules** | When and to whom it escalates; what it never decides alone |
| **Working hours** | Schedule/triggers; when it's active vs idle |
| **Budget** | Hard spend ceiling; circuit-breaker behaviour |
| **Tool access** | The exact tools in its registry, each with required capability |
| **Decision limits** | The thresholds it may act within autonomously |
| **Approval requirements** | What requires a human (and which human) before execution [Ch.13] |
| **Audit history** | What is recorded for every action [Ch.15] |

---

## Conventions

- **Naming.** HQ (super-admin) tables are prefixed `hq_` or `admin_` or `ai_employee_`. Tenant tables are unprefixed. New event-sourced tables use `hq_`. Verbs are `domain.action` (snake within segments), e.g. `invoice.payment_failed`. Capabilities are `domain.action`, e.g. `billing.refund`.
- **RLS notation.** Each table declares one of: **`RLS:tenant`** (org-scoped policies via `current_org_ids()`), **`RLS:hq`** (RLS enabled, **zero policies** — service-role only; the dominant HQ posture), or **`RLS:public`** (rare; read-only reference data).
- **DDL & code are illustrative.** SQL/TypeScript blocks communicate intent and shape. They are not the production migration/source; the real artifacts are produced during implementation, reviewed, and gated exactly as Directive 007 shipped.
- **Status legend.** ✅ drafted · ⏳ planned · 🔬 needs a decision (see Ch.20 open questions) · ♻️ reuses an existing asset (named inline).
- **Reuse callouts.** Where the design builds on something that already exists in the codebase, it is marked ♻️ with the file/table so reviewers can see we are extending, not reinventing.
- **The one-million test.** Every Performance and Scalability section answers the Golden Rule explicitly.

---

## Reading guides

- **CEO / approver:** read Volume 0 ([`ARCHITECTURE.md`](../ARCHITECTURE.md)), then Ch.01 (philosophy), Ch.09 (Mission Control), Ch.08 (the workforce), and Ch.19 (rollout). The open-questions log (Ch.20) is where your decisions are needed.
- **A new engineer:** read Volume I end-to-end (01→04). You cannot build any chapter without the data model (Ch.03) and the event taxonomy (Ch.04) — they are the shared language.
- **A system owner:** your chapter is self-contained against the template, but its Database/Permissions/Monitoring sections point back to the canon chapters (03/14/15). Honour those; do not fork the vocabulary.

---

## Change control & governance

The Bible is versioned in git alongside the code. Material changes are proposed as edits to the relevant chapter with a one-line entry appended to the **Decision Log** in Ch.20 (an ADR: context → decision → consequences). The canon chapters (03 Data Model, 04 Event Taxonomy, 14 Permissions) are the highest-stakes: a change there ripples everywhere, so each requires an explicit ADR and a consistency sweep of dependent chapters. **One source, forever** — applied to the specification itself.

Under the **Architecture Freeze** (above), change control is not advisory — it is the mechanism that keeps v1.0 coherent. The rules:

**1. Architecture before code (the prime rule).** No production code is written for a behaviour the Bible does not yet describe. The order is always *chapter → ADR → review → implementation*, never the reverse. A pull request that introduces behaviour absent from the Bible is incomplete by definition, regardless of how good the code is.

**2. Every implementation PR cites its chapter(s).** The PR description names the chapter(s) it realises (e.g. "implements Ch.04 §2 outbox + Ch.03 §03.1 `hq_events`"). This is the freeze made checkable: a reviewer can hold the diff against the spec. A PR that cites no chapter is asked *"which chapter is this?"* before review proceeds — and if the honest answer is "none", work stops until the chapter exists.

**3. A change is a Bible edit *first*.** When a directive or a discovery requires the architecture to change, the **first** artifact produced is the chapter edit + ADR — not the code. Implementation then conforms to the amended chapter. This guarantees the Bible never lags reality; the specification is always the most current description of the system, because nothing ships ahead of it.

**4. Deviations are ADRs, not surprises.** If implementation reveals the design is wrong, that is *expected and welcome* — but it is surfaced as a proposed chapter edit + ADR (context → decision → consequences), reviewed like any change, and the canon-sweep runs if it touches 03/04/14. An undocumented deviation discovered in code review is a defect to be reconciled, not a fait accompli.

**5. Versioning the freeze.** v1.0 is the frozen baseline. Additive, backward-compatible refinements accumulate as ADRs and roll up to **v1.1, v1.2, …**; a structural change that invalidates a frozen decision is a **v2.0** event requiring explicit CEO endorsement. The version lives in the [Status & ground rules](#status--ground-rules) table; every bump names the ADR that caused it. The freeze is *durable*, not *eternal* — it changes deliberately, in the open, one recorded decision at a time.

> **The test for any future change:** *Did the Bible change before the code did?* If yes, the freeze is intact. If no, the change is out of order — stop, write the chapter, then build.
