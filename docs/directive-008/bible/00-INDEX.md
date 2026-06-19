# CrewFlow Operating System — The Engineering Bible

**CEO Directive #008 · The definitive engineering specification · Planning artifact (no implementation)**

> **One philosophy governs everything in this document:**
> **Every piece of information inside CrewFlow should exist *once*, be *observable everywhere*, and be *actionable by AI*.**

> **One rule decides every architecture call:**
> **"If CrewFlow had one million companies using it, would we still build it this way?" If no — redesign it.**

---

## Status & ground rules

| | |
|---|---|
| **Document status** | Living specification — under construction. No production code is written from it until the CEO approves the blueprint **and** the Release Candidate (PR #171) is in production and stable. |
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
| 05 | **Services & APIs** | The service layer, server actions, route handlers, contracts, versioning | ⏳ planned |
| 06 | **Real-time Infrastructure** | Supabase Realtime, server-authorized broadcast, presence, the island model | ⏳ planned |
| 07 | **AI Employee Framework** | The runtime, the lifecycle FSM, the tool registry, cost/budget | ⏳ planned |
| 08 | **AI Employee Roster** | A full dossier for each of the 12 employees | ⏳ planned |
| 09 | **Mission Control** | The OS homepage — live, connected, the centre of CrewFlow | ⏳ planned |
| 10 | **Global Search** | Cross-entity search + the ⌘K command palette | ⏳ planned |
| 11 | **Event Timeline** | The global + per-entity feed projected from the spine | ⏳ planned |
| 12 | **Memory Graph** | Episodic/semantic/procedural memory, pgvector, typed edges | ⏳ planned |
| 13 | **Approvals & Human Oversight** | The approval workflow, policy engine, the inbox | ⏳ planned |
| 14 | **Permissions & RBAC** | Capabilities, roles, the single `authorize()` chokepoint | ⏳ planned |
| 15 | **Observability, Metrics & Audit** | Tracing, the metric registry, the immutable audit log | ⏳ planned |
| 16 | **Security** | Trust boundaries, AI-specific defenses, data protection | ⏳ planned |
| 17 | **Scalability** | Partitioning, load-levelling, LLM cost control, graduation triggers | ⏳ planned |
| 18 | **Testing Strategy** | The test pyramid, RLS tests, event-contract tests, AI evals | ⏳ planned |
| 19 | **Rollout Plan** | The eight phases, flags, backout, success criteria | ⏳ planned |
| 20 | **Glossary, Conventions & Decision Log** | Shared vocabulary, ADRs, open questions | ⏳ planned |

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

## Change control

The Bible is versioned in git alongside the code. Material changes are proposed as edits to the relevant chapter with a one-line entry appended to the **Decision Log** in Ch.20 (an ADR: context → decision → consequences). The canon chapters (03 Data Model, 04 Event Taxonomy, 14 Permissions) are the highest-stakes: a change there ripples everywhere, so each requires an explicit ADR and a consistency sweep of dependent chapters. **One source, forever** — applied to the specification itself.
