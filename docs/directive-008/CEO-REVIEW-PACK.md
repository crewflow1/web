# CrewFlow OS — CEO Review Pack

**CEO Directive #003.5 ("Lock the Foundation") · Part 2 of 7 · The executive overview**

> This is the one-document read of the entire Engineering Bible. Every chapter is scored for what it costs, what it unlocks, and where it sits in the build. It is **derived from** the [Bible](bible/00-INDEX.md) — every number here traces to a chapter — and it defines no architecture of its own. Read it top-to-bottom for the portfolio picture; jump to a chapter card for the detail.

---

## How to read this pack

The Bible is **21 chapters across six volumes (~7,000 lines)**, all drafted and frozen at v1.0. This pack turns that into a portfolio an executive can weigh: it answers *what is each piece worth, what does it cost, and in what order does it get built.*

It has four parts:

1. **The scoreboard** — one row per chapter, scored on six axes (build effort, engineering complexity, and four impact dimensions). The scannable view.
2. **Portfolio rollups** — the headline totals: total build effort, the split by rollout phase, and the split by volume. The "how big is this" answer.
3. **The chapter cards** — one card per chapter with the prose fields the scoreboard can't hold: purpose, dependencies, integrations, the revenue lever, the competitive edge, the AI impact, and *why* each score is what it is.
4. **The headline read** — three paragraphs on what the portfolio says, for the CEO.

### Scoring methodology — and an honesty note

Every numeric score below is an **informed estimate, defensible from the cited chapter — not a measured fact.** No feature has been built yet, so build times and complexity are judgements grounded in (a) each chapter's surface area and stated design, and (b) the *real* shipping cadence of Directive 007 (the design-system programme that actually shipped this quarter — gated, preview-first, typecheck+build green). They are honest planning numbers, not promises. Where a chapter is pure architecture or reference with no separate build, it is marked **"— (reference)"** and its effort is folded into the chapters it governs.

The four impact axes are scored **1–10**, anchored so the scores mean something relative to each other:

| Axis | What a high score means | What a low score means |
|---|---|---|
| **Engineering complexity** | Hard to build *correctly* — concurrency, partitioning, security-critical, novel | A well-understood CRUD/projection with a clear pattern |
| **Business impact** | CrewFlow-as-a-business depends on it to operate or scale | Useful, but the business runs without it |
| **Customer value** | Reaches CrewFlow's end customers (faster support, fewer incidents, more trust) | Internal-only leverage; customers feel it only indirectly |
| **AI leverage** | Directly enables or amplifies the AI workforce — without it, AI employees can't work | Helpful to AI, but not load-bearing for it |

**One framing the scores depend on:** CrewFlow's OS is an **internal operating system + an AI workforce**, not a customer-facing feature pack. So "customer value" is mostly delivered *indirectly* — through operational excellence (faster, cheaper, more reliable ops that customers feel as better service), and through the customer-touching AI employees (Support, Documentation). And "revenue impact" is **dominantly cost-avoidance and retention**, not new ARR: the workforce does work humans would otherwise be hired to do, and the reliability ring protects the revenue already booked. I score these honestly rather than inflating them — a pack that overstates customer/revenue impact would be worse than useless for prioritisation.

### The rollout phases (the "implementation order" column)

The build order is **Chapter 19's eight rollout phases**, gated behind the Release Candidate (PR #171) reaching production and proving stable. Each chapter's "phase" column says when its code lands:

```
GATE (PR #171 prod & stable)
 → P0 Foundations (spine · verbs · authorize() · flags)
 → P1 Observability & audit
 → P2 Read-only projections (Timeline · Search · Mission Control)
 → P3 Real-time (islands; Mission Control goes live)
 → P4 Memory graph (knowledge, not action)
 → P5 AI runtime DRAFT-ONLY (12 onboarded locked; Research AI folds in)
 → P6 Approvals & oversight
 → P7 Graduated execution (one capability at a time, CEO-gated)
 → P8 Steady state & graduation triggers
```

> **A naming note to avoid confusion.** The CEO roadmap calls the *whole* implementation effort **"Phase 7"** (the company's seventh macro-phase). Chapter 19 calls the *internal* rollout steps **"rollout phases 0–8."** Throughout this pack and the companion docs, **"the Phase 7 programme"** = the overall build; **"rollout Phase N"** = one of Ch.19's eight steps. The [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) sequences the programme week by week.

---

## 1. The scoreboard

One row per chapter. Build effort is in **engineer-weeks** (assume 1–2 senior engineers at the Directive 007 cadence; includes the chapter's tests and monitoring, excludes soak time). Impact axes are 1–10 (see methodology). Status is uniform — **every chapter is ✅ drafted & frozen at v1.0** — so it is stated once here rather than repeated per row.

| # | Chapter | Volume | Rollout phase | Build (eng-wks) | Eng cx | Biz | Cust | AI leverage |
|---|---|---|---|---|---|---|---|---|
| 01 | Philosophy & Principles | I | governs all | — (reference) | — | 9 | 4 | 9 |
| 02 | System Architecture | I | governs all | — (reference) | — | 9 | 4 | 8 |
| 03 | **Data Model** *(canon)* | I | **P0** (core; tables land per phase) | 3–4 | 8 | 10 | 6 | 8 |
| 04 | **Event Spine & Taxonomy** *(canon)* | I | **P0** | 3–4 | 9 | 10 | 6 | 9 |
| 05 | Services & APIs | II | P0 scaffold; grows per phase | 2–3 | 6 | 8 | 6 | 7 |
| 06 | Real-time Infrastructure | II | **P3** | 2–3 | 7 | 7 | 6 | 6 |
| 07 | AI Employee Framework | III | **P5** | 4–6 | 9 | 9 | 7 | 10 |
| 08 | AI Employee Roster (×12) | III | P5 onboard → **P7** graduate | 3–5 | 6 | 9 | 8 | 10 |
| 09 | **Mission Control** | IV | **P2** read-only → **P3** live | 3–4 | 6 | 10 | 5 | 7 |
| 10 | Global Search | II | **P2** | 2 | 5 | 7 | 6 | 6 |
| 11 | Event Timeline | II | **P2** | 2–3 | 5 | 8 | 6 | 7 |
| 12 | Memory Graph | II | **P4** | 3–4 | 8 | 7 | 5 | 9 |
| 13 | Approvals & Oversight | IV | **P6** | 2–3 | 7 | 9 | 7 | 9 |
| 14 | **Permissions & RBAC** *(canon)* | IV | **P0** | 3–4 | 8 | 10 | 6 | 9 |
| 15 | Observability, Metrics & Audit | II | **P1** | 3–4 | 7 | 9 | 5 | 8 |
| 16 | Security | V | P0 + every phase (gates) | 2–3 + reviews | 8 | 10 | 8 | 8 |
| 17 | Scalability | V | **P8** (triggers armed) | 1–2 | 6 | 6 | 5 | 5 |
| 18 | Testing Strategy | V | P0 + every phase (CI gate) | 2–3 + CI | 7 | 9 | 7 | 8 |
| 19 | Rollout Plan | V | the meta-plan | — (reference) | — | 9 | 5 | 6 |
| 20 | Glossary & Decision Log | VI | reference | — (reference) | — | 6 | 3 | 5 |

**Reading the scoreboard in one glance:** the **canon trio (03/04/14)** and **Mission Control (09)** carry the highest *business* scores (10) — they are the load-bearing wall and the front door. The **AI framework + roster (07/08)** are the only 10s on *AI leverage* — they are the point of the whole exercise. **Security (16)** is the lone 10 on *business* that is also high (8) on *customer value* — protecting the platform is protecting the customer. The lowest-complexity, fastest wins are **Search (10)** and **Timeline (11)** — pure projections, shipped early in P2 for visible value at low risk.

---

## 2. Portfolio rollups

### Total build effort

| | |
|---|---|
| **Buildable chapters** | 16 of 21 (the other 5 — 01, 02, 19, 20, and the cross-cutting share of 16/18 — are reference/governance whose effort folds into the chapters they govern). |
| **Sum of primary build estimates** | **≈ 48 engineer-weeks** of focused build (midpoints of the ranges above). |
| **What that excludes** | Soak windows between phases (reliability-over-speed holds), the one-time CI-Postgres harness ([OQ-16](bible/20-glossary-conventions-decision-log.md) — the single most important pre-flight gap), per-phase security reviews, and the RC-to-production precondition. These turn ~48 eng-weeks of *build* into a longer *calendar* programme. |
| **Calendar mapping** | With 1–2 senior engineers, gated soak windows, and the per-phase contract, this maps to the **~18-week programme** sequenced in the [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md). Build effort and calendar time differ *by design* — the gates are the safety. |

> **Honesty on the estimate:** ±40%. This is a planning figure grounded in chapter surface area and the 007 cadence, not a bid. The estimate's *job* is to make the portfolio comparable and the sequence fundable — not to commit a delivery date. Ch.19 is explicit: the schedule is **evidence-gated, never a calendar promise.**

### Effort by rollout phase

| Phase | Chapters landing here | Build (eng-wks) | Character |
|---|---|---|---|
| **P0 Foundations** | 03 (core), 04, 14, 05 (scaffold) | ~12 | Highest-stakes, highest-complexity. The wall everything stands on. |
| **P1 Observability** | 15 | ~3–4 | "You cannot roll out what you cannot see." Ships before anything consequential. |
| **P2 Read-only projections** | 10, 11, 09 (read-only) | ~6–8 | Fastest visible value, lowest risk — all pure reads. |
| **P3 Real-time** | 06, 09 (live) | ~3–4 | The "it's alive" moment. Security-reviewed (the broadcast boundary). |
| **P4 Memory** | 12 | ~3–4 | Knowledge before action; the AI's recall. |
| **P5 AI draft-only** | 07, 08 (onboard) | ~7–9 | The workforce becomes real — but cannot yet act. |
| **P6 Approvals** | 13 | ~2–3 | The human-in-the-loop ring; drafts can route to people. |
| **P7 Graduated execution** | 08 (graduate), per-capability | ~2–3 + watch | The payoff. One capability, one employee, CEO-gated. |
| **P8 Steady state** | 17 (triggers armed) | ~1–2 | Scaling exits armed as monitors; the Bible becomes the reference. |

The shape is deliberate: **front-loaded complexity (P0), early visible value (P2), and the narrowest, most-gated work last (P7).** Risk falls as the programme progresses, not rises.

### Effort & weight by volume

| Volume | Theme | Chapters | Build (eng-wks) | Why it matters |
|---|---|---|---|---|
| **I — Foundations** | Philosophy, architecture, data model, event spine | 01–04 | ~7–8 | The shared language. Nothing is built without 03 + 04. |
| **II — Platform** | Services, real-time, search, timeline, memory, observability | 05, 06, 10, 11, 12, 15 | ~15–18 | The systems the workforce and operators live in. |
| **III — Workforce** | The AI framework + 12-employee roster | 07, 08 | ~7–11 | The reason CrewFlow is an *OS*, not a dashboard. |
| **IV — Control plane** | Mission Control, approvals, permissions | 09, 13, 14 | ~8–11 | Where the human stays in command. |
| **V — Cross-cutting** | Security, scalability, testing, rollout | 16–19 | ~5–8 + gates | The reliability and safety ring around everything. |
| **VI — Reference** | Glossary, conventions, decision log | 20 | — | The dictionary. Holds the canon honest. |

---

## 3. The chapter cards

One card per chapter, grouped by the rollout phase in which its code lands. Each card carries the fields the scoreboard can't: **purpose, status, key dependencies, integrations, the revenue lever, the competitive edge, the AI impact, and the rationale behind the scores.** Dependencies are summarised here and treated exhaustively in the [Build Dependency Graph](BUILD-DEPENDENCY-GRAPH.md).

### Governs everything (no separate build)

#### Ch.01 — Philosophy & Principles · *reference*
- **Purpose:** the thesis ("AI employees, not assistants"), the operating principles (P1–P9), and the decision framework. The *why* behind every other chapter.
- **Status:** ✅ drafted & frozen. **Depends on:** nothing (it is the root). **Integrations:** none.
- **Revenue lever:** indirect but total — it is the reason the workforce exists, which is the reason for the cost-avoidance the whole programme delivers.
- **Competitive edge:** the "one source, observable everywhere, actionable by AI" philosophy is the moat — competitors bolt AI onto a dashboard; CrewFlow builds the dashboard *for* the AI.
- **AI impact (9):** defines the AI-employee model the roster realises.
- **Scores:** business 9 (governs all), customer 4 (indirect), AI 9. No build — it is the constitution, not a feature.

#### Ch.02 — System Architecture · *reference*
- **Purpose:** the planes (tenant vs HQ), the kernel model, end-to-end data flow, technology choices. The 10,000-ft structural map.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.01. **Integrations:** names the whole stack (Next.js 15, React 19, Supabase, Vercel).
- **Revenue lever:** indirect — sound structure is what lets the business scale without a rewrite (the one-million test).
- **Competitive edge:** the plane separation (tenant data never relaxed for HQ convenience) is a security and trust differentiator.
- **AI impact (8):** the deterministic-infra ↔ AI-execution boundary it draws is what makes AI safe to add.
- **Scores:** business 9, customer 4, AI 8. No separate build — realised by the chapters it frames.

### Rollout Phase 0 — Foundations

#### Ch.03 — Data Model · *canon · P0 core*
- **Purpose:** every table — existing and new — with DDL, indexes, RLS posture, retention. The single catalogue; **no chapter invents a table outside it.**
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (the spine it models). **Integrations:** Supabase Postgres (partitioning, RLS, pg_cron for partition creation), pgvector (Ch.12's column).
- **Revenue lever:** foundational — a clean, additive, forward-only schema is what lets every later feature ship without a destructive migration (no downtime, no data loss → no revenue interruption).
- **Competitive edge:** RLS-everywhere + append-only spine is a data-integrity story enterprise buyers ask for.
- **AI impact (8):** the spine and memory tables are the AI's senses and memory.
- **Scores:** complexity 8 (partitioning, RLS, retention done right), business 10 (the foundation), customer 6 (data integrity reaches them as trust), AI 8. **Build 3–4 wks** for the P0 core (spine, capabilities, settings); later tables land *with* their phases.

#### Ch.04 — Event Spine & Taxonomy · *canon · P0*
- **Purpose:** the one append-only `hq_events` log, the canonical verb registry (a generated TS union), delivery semantics (transactional outbox + offset-based idempotent consumers).
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.03 (the tables). **Integrations:** Postgres (identity PK total-order, partitioning), pg_notify + pg_cron drainer.
- **Revenue lever:** the spine is what makes *everything observable* — which is what makes the AI workforce auditable, which is what makes it safe to deploy against real customer money. No spine → no trustworthy AI → no cost-avoidance.
- **Competitive edge:** event-sourced truth means CrewFlow can answer "what happened and why" for any action, human or AI — a forensic capability most SaaS cannot offer.
- **AI impact (9):** the spine is the AI's shared perception; every employee perceives by reading it and records by writing to it.
- **Scores:** complexity 9 (outbox correctness, idempotency, partition health), business 10, customer 6, AI 9. **Build 3–4 wks.** *The single most important architectural decision (ADR-001).*

#### Ch.14 — Permissions & RBAC · *canon · P0*
- **Purpose:** the single `authorize(principal, capability, ctx)` chokepoint; capabilities → roles → principals; humans and AIs as uniform principals; fail-closed; the additive `super_admin` seed that makes day-one a zero-regression event.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (`permission.*` verbs), Ch.03 (the four tables). **Integrations:** Supabase Auth (`HqActor`), the existing `requireHq()` guard it layers inside.
- **Revenue lever:** this is the gate that makes AI execution *safe enough to turn on* — the difference between an AI that can help and an AI you'd dare give a refund capability. Without it, the workforce never graduates past draft, and the cost-avoidance never lands.
- **Competitive edge:** uniform human/AI authority + dual-control on dangerous powers is an enterprise-grade governance story competitors retrofit badly.
- **AI impact (9):** every AI side-effect spends a capability here; it is the line between "assistant" and "employee you can trust."
- **Scores:** complexity 8 (fail-closed correctness, zero-regression seed, cache busting), business 10, customer 6, AI 9. **Build 3–4 wks.**

#### Ch.05 — Services & APIs · *P0 scaffold; grows per phase*
- **Purpose:** the service layer, server actions, route handlers, contracts, versioning, error shapes. How code talks to the data model and the spine.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.03, Ch.04, Ch.14. **Integrations:** Next.js server actions/route handlers, the existing `notification_email_queue` (the AI-email seam, [OQ-6](bible/20-glossary-conventions-decision-log.md)).
- **Revenue lever:** indirect — a consistent service contract is what keeps later features cheap to add (velocity → faster cost-avoidance).
- **Competitive edge:** modest — this is good engineering hygiene, not a customer-visible differentiator.
- **AI impact (7):** every AI tool ultimately calls a service function; the `q<T>()` typing shim and one-source contracts keep them safe.
- **Scores:** complexity 6, business 8, customer 6, AI 7. **Build 2–3 wks** for the P0 scaffold; the surface grows additively as each phase adds its services.

### Rollout Phase 1 — Observability

#### Ch.15 — Observability, Metrics & Audit · *P1*
- **Purpose:** tracing by `correlation_id` over the spine, the metric registry (one formula per metric), the immutable audit log. **Ships before anything consequential** — you cannot roll out what you cannot see.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (the spine to observe), Ch.03 (`hq_metrics`, `hq_runs`/`hq_spans`). **Integrations:** Sentry (existing error tracking), the existing `admin_activity_log`, `cron_runs`/`withCronTelemetry` generalised. Future: OpenTelemetry export ([OQ-21](bible/20-glossary-conventions-decision-log.md)).
- **Revenue lever:** protective — observability is what catches a cost runaway or an AI error *before* it becomes a month-end bill or a customer incident. It protects booked revenue and the AI cost budget.
- **Competitive edge:** per-AI-employee cost/latency/error visibility is something most "AI features" simply don't have — CrewFlow can prove its AI is economical and correct.
- **AI impact (8):** every AI run's cost, tokens, latency, and error are recorded here from the first run (P9: measure → bound → predict).
- **Scores:** complexity 7, business 9, customer 5 (felt as reliability), AI 8. **Build 3–4 wks.**

### Rollout Phase 2 — Read-only projections

#### Ch.11 — Event Timeline · *P2*
- **Purpose:** the global, per-entity, and per-employee activity feed projected from the spine; the idempotent backfill of existing history.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (spine), Ch.15 (so it's observable as it comes up). **Integrations:** Postgres (the projection + backfill).
- **Revenue lever:** modest-but-real — "see everything that happened to this company in one place" reduces support-investigation time (support cost), and is the substrate Mission Control reads.
- **Competitive edge:** a unified, replayable activity stream across every domain is rare; most products silo activity per feature.
- **AI impact (7):** the timeline is how an operator audits what the AI did — the trust surface for the whole workforce.
- **Scores:** complexity 5 (pure projection), business 8, customer 6, AI 7. **Build 2–3 wks.** *Fast, low-risk, high-visibility — an ideal early win.*

#### Ch.10 — Global Search · *P2*
- **Purpose:** cross-entity search + the ⌘K command palette (find mode first; action verbs come later).
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.03 (`hq_search_index`), Ch.04. **Integrations:** Postgres FTS + pg_trgm; future Typesense/Meilisearch behind `searchHq()` at the Ch.17 latency trigger.
- **Revenue lever:** efficiency — operators find anything instantly (less time per task → more companies per operator → lower cost-to-serve).
- **Competitive edge:** a single ⌘K across every entity is a polish signal; modest as a moat.
- **AI impact (6):** the same index AIs query to ground their work; the command palette is where human and AI actions converge.
- **Scores:** complexity 5, business 7, customer 6, AI 6. **Build ~2 wks.** *The single lowest-complexity chapter — a clean, contained projection.*

#### Ch.09 — Mission Control · *P2 read-only → P3 live*
- **Purpose:** the OS homepage (`/admin`) — composed by a tile-provider registry, answering *what happened / is happening / will happen* without navigation. **The chapter the CEO emphasised most.**
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.11 (timeline slice), Ch.15 (metric rollups), Ch.14 (tiles render by capability), then Ch.06 (to go live), Ch.13 (the approvals zone). **Integrations:** Supabase Realtime (in P3), the existing `/admin` surface and `requireHqPage()`.
- **Revenue lever:** the leverage multiplier — it is *where* an operator runs more of the business per head, and *where* the AI workforce's output becomes visible and actionable. Its value is the sum of what it surfaces.
- **Competitive edge:** a live, connected operating surface ("everything connects, everything is live") is the product's signature — the difference between "a SaaS with an admin panel" and "an operating system."
- **AI impact (7):** the registry makes every AI system appear on the home by *registration, not surgery*; the approvals zone is where humans command the AI.
- **Scores:** complexity 6 (the registry + islands, not the tiles), business 10 (the front door), customer 5 (internal surface, felt indirectly), AI 7. **Build 3–4 wks** across P2 (read-only) and P3 (live).

### Rollout Phase 3 — Real-time

#### Ch.06 — Real-time Infrastructure · *P3*
- **Purpose:** liveness via server-authorised Broadcast (never `postgres_changes`); the broadcaster that reads the spine, authorises for the HQ audience, and shapes a safe delta; the reusable island model; ephemeral presence.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (spine), Ch.02/Ch.16 (the trust boundary). **Integrations:** **Supabase Realtime** (present but entirely unused today — this lights it up).
- **Revenue lever:** retention-flavoured — "it's alive" is the experience that makes the OS feel modern and worth its price; indirect but real for perceived product quality.
- **Competitive edge:** *server-authorised* real-time (clients subscribe, never publish; `hq_events` never JWT-exposed) is both a UX and a security differentiator — most real-time SaaS leaks its tables to do this.
- **AI impact (6):** AI actions appear live to the watching operator — the workforce's activity becomes visible in real time.
- **Scores:** complexity 7 (reconnect, resync, the security boundary), business 7, customer 6, AI 6. **Build 2–3 wks.** *Carries an explicit security review (the broadcast boundary, risk R4).*

### Rollout Phase 4 — Memory

#### Ch.12 — Memory Graph · *P4*
- **Purpose:** episodic/semantic/procedural memory; pgvector for similarity; typed, scored `hq_memory_edges` for graph recall; hybrid (FTS + vector + graph) retrieval. **Knowledge before action.**
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.04 (`memory.*` verbs), Ch.03 (the memory tables — the most-built foundation, ♻️ the 26KB `hq-memory.ts`). **Integrations:** **pgvector** (the `vector` extension + HNSW index), an embedding provider ([OQ-11](bible/20-glossary-conventions-decision-log.md)).
- **Revenue lever:** quality multiplier — memory is what stops the workforce repeating work and mistakes; a remembering AI is a *cheaper, better* AI (fewer tokens re-deriving context, fewer errors → more cost-avoidance per employee).
- **Competitive edge:** a real episodic/semantic/procedural memory graph with provenance is well beyond "chat history" — it is institutional memory the company keeps even as humans turn over.
- **AI impact (9):** this *is* the AI's recall; without it employees are amnesiac. Sequenced before the runtime so they have memory before they plan.
- **Scores:** complexity 8 (vector indexing, hybrid fusion weights, lazy backfill), business 7, customer 5, AI 9. **Build 3–4 wks.**

### Rollout Phase 5 — AI runtime (draft-only)

#### Ch.07 — AI Employee Framework · *P5*
- **Purpose:** the uniform runtime — the lifecycle FSM (perceive → plan → gate → act → record → reflect), the typed tool registry (every tool carries a `required_capability`), cost/budget governors with circuit breakers. **Config, not code:** `defineEmployee()` over six dimensions.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.14 (the gate), Ch.04 (verbs), Ch.12 (recall), Ch.15 (cost observed from run one). **Integrations:** an **LLM provider** (♻️ the proven `research-llm.ts` pattern), the existing `hq-research.ts` executor that folds in.
- **Revenue lever:** **the core lever.** This is the engine that lets one configuration become twelve workers. Every hour of work it absorbs is an hour not hired. The entire cost-avoidance thesis runs through this chapter.
- **Competitive edge:** one SDK, twelve employees, least-privilege-by-default (`locked()`) — a workforce that onboards by configuration is a structural advantage over bespoke-agent competitors who maintain N codebases.
- **AI impact (10):** it *is* the AI. The only 10 alongside its roster.
- **Scores:** complexity 9 (the FSM, the gate integration, budget circuit-breakers, the safe `act` boundary), business 9, customer 7 (the customer-touching employees run on it), AI 10. **Build 4–6 wks** — the single largest chapter, generalised from the one proven executor.

#### Ch.08 — AI Employee Roster (×12) · *P5 onboard → P7 graduate*
- **Purpose:** a full hiring dossier for each of the 12 employees — identity, role, manager, responsibilities, permissions, memory, KPIs, costs, reviews, escalation, hours, budget, tools, decision limits, approvals, audit.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.07 (the runtime they run on), Ch.14 (their capabilities), Ch.13 (their approval routing). **Integrations:** per-employee tool registries (email, docs, search, billing-read, etc.).
- **Revenue lever:** **the cost-avoidance, itemised.** Each dossier is a job CrewFlow doesn't hire for at full cost — the roster ceiling (~$52/day across all twelve) is the headline: a twelve-person back office for the price of a coffee round. The customer-facing employees (Support, Documentation) also protect retention.
- **Competitive edge:** a *named, role-scoped, budgeted, reviewed* AI org chart — not "an AI assistant" — is a category-defining story.
- **AI impact (10):** the roster is the workforce; everything else exists to make it work.
- **Scores:** complexity 6 (configuration over the framework, not new infra), business 9, customer 8 (Support/Docs reach customers directly), AI 10. **Build 3–5 wks** to onboard all twelve `locked()` in P5; graduation is per-employee in P7.

### Rollout Phase 6 — Approvals

#### Ch.13 — Approvals & Human Oversight · *P6*
- **Purpose:** the policy engine (`auto` / `require_human` / `dual_control` by employee × capability × risk × amount), the live approvals inbox (a projection), `projected_effect` (decide on plain language, not raw payload), SLA timers and escalation.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.14 (the `needs_approval` decision branch + `approval.*` verbs), Ch.03 (the inbox), Ch.03 real-time so it streams live. **Integrations:** Mission Control (the inbox is a primary zone), the audit log (every decision recorded).
- **Revenue lever:** **the safety that unlocks the revenue.** Approvals are what let dangerous-but-valuable AI actions exist at all — without the inbox, every consequential capability stays off forever. It also prevents the single costly AI mistake (an erroneous refund, a wrong email) that would otherwise force the whole programme to retreat.
- **Competitive edge:** dual-control (two distinct humans, AI never an approver) on dangerous powers is the governance guarantee enterprise and regulated customers require.
- **AI impact (9):** it is the bridge from draft-only to trusted execution — the workforce can only graduate (P7) because this exists.
- **Scores:** complexity 7 (CAS single-decision, policy routing, expiry-no-side-effect), business 9, customer 7, AI 9. **Build 2–3 wks.**

### Rollout Phase 7 — Graduated execution

*(No new chapter — this phase **activates** Ch.07/08/13/14. It is the per-employee, per-capability graduation, CEO-gated, lowest-risk first. Effort is the per-capability watch-and-grant cycle, ~2–3 wks of programme time plus continuous evals. See the [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md).)*

### Rollout Phase 8 — Steady state

#### Ch.17 — Scalability · *P8*
- **Purpose:** partitioning, queue load-levelling, LLM cost control, and the **named graduation triggers** — the exact observable thresholds at which deliberately-simple choices (Postgres queue, cron drainer, single region) upgrade to heavier ones.
- **Status:** ✅ drafted & frozen. **Depends on:** all prior phases (steady state presupposes a running OS). **Integrations:** the future-facing set behind service boundaries — pgmq, a broker, Typesense/Meilisearch, a dedicated vector store — *none adopted now, each armed as a monitor.*
- **Revenue lever:** protective and deferred — it ensures the cost-avoidance doesn't reverse into a scaling crisis at 100× load (the one-million test made operational). It spends nothing until a measured trigger demands it.
- **Competitive edge:** "scaling as a pre-decided, monitored event, never a panic" is operational maturity most startups lack.
- **AI impact (5):** keeps the AI's substrate (spine, memory, queues) fast as volume grows, but doesn't itself add AI capability.
- **Scores:** complexity 6, business 6, customer 5, AI 5. **Build 1–2 wks** to arm the monitors; the graduations themselves are triggered later, by measurement.

### Cross-cutting (P0 + every phase)

#### Ch.16 — Security · *gates every phase*
- **Purpose:** the five trust boundaries, AI-specific defences (the gate checks the *grant*, not the *wish* — injection cannot escalate), the service-role key as the crown jewel (`import "server-only"`), data protection.
- **Status:** ✅ drafted & frozen. **Depends on:** Ch.14 (the gate), Ch.02 (the boundaries), Ch.03 (`RLS:hq`). **Integrations:** Vercel env (secrets today), a future secrets manager ([OQ-22](bible/20-glossary-conventions-decision-log.md)); a CI guard against `NEXT_PUBLIC_` secret leaks ([OQ-20](bible/20-glossary-conventions-decision-log.md)).
- **Revenue lever:** **existential protection.** A breach of the HQ plane (service-role key, tenant data) is a company-ending event; security is the lever that keeps *all* booked revenue from evaporating. Pure downside protection, maximal value.
- **Competitive edge:** RLS-everywhere, server-only secrets, prompt-injection-resistant-by-construction (no AI holds a permission) is a security posture that wins enterprise deals.
- **AI impact (8):** the AI-specific section is what makes an autonomous workforce safe to operate against real money and customer data.
- **Scores:** complexity 8, business 10, customer 8 (data protection is direct customer value), AI 8. **Build 2–3 wks** of dedicated hardening + a **security review gating every consequential phase** (notably P3 and P7).

#### Ch.18 — Testing Strategy · *gates every phase*
- **Purpose:** the test pyramid, RLS tests, event-contract tests, AI evals + prompt-injection red-teaming, and the CI gates.
- **Status:** ✅ drafted & frozen. **Depends on:** every chapter (it tests them all). **Integrations:** the CI runner + **a real Postgres in CI** ([OQ-16](bible/20-glossary-conventions-decision-log.md) — *"the single most important gap"*; RLS/integration tests cannot truly gate until resolved).
- **Revenue lever:** protective and enabling — tests are what let the programme ship *fast and gated* without regression; they protect booked revenue and the velocity that delivers the cost-avoidance.
- **Competitive edge:** AI evals + injection red-teaming as a standing gate means CrewFlow can *prove* its AI is safe and correct, not just claim it.
- **AI impact (8):** AI evals are how the workforce earns each capability graduation (P7) — no green evals, no grant.
- **Scores:** complexity 7, business 9, customer 7, AI 8. **Build 2–3 wks** + the one-time CI-Postgres harness (pre-flight priority).

### Reference

#### Ch.19 — Rollout Plan · *the meta-plan · reference*
- **Purpose:** the gate + eight phases + the mechanics (flags in `hq_settings`, additive migrations, backout hierarchy, the risk register) that make each phase safe.
- **Status:** ✅ drafted & frozen. **Depends on:** every chapter (it sequences them). **Integrations:** `hq_settings` (the flag switchboard).
- **Revenue lever:** indirect but decisive — the rollout *is* the mechanism by which all the other revenue levers reach production without taking the live product down.
- **Competitive edge:** "install an AI OS under a live product with zero downtime, every phase flag-reversible" is an operational feat.
- **AI impact (6):** sequences AI execution to be the last, narrowest, most-gated phase.
- **Scores:** business 9, customer 5, AI 6. No separate build — it *is* the build plan, executed by the [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md).

#### Ch.20 — Glossary, Conventions & Decision Log · *reference*
- **Purpose:** the shared vocabulary, the authoring/engineering conventions, the 14 ADRs, and the 23 open questions (the CEO's decision surface, §20.4.A).
- **Status:** ✅ drafted & frozen. **Depends on:** all chapters (it indexes them). **Integrations:** none.
- **Revenue lever:** indirect — it is what keeps the one-source rule true over time (preventing the vocabulary drift that rots event systems and costs rework).
- **Competitive edge:** an ADR-backed, self-governing specification is institutional memory most teams never write down.
- **AI impact (5):** the canonical verb/capability definitions the AI's type system enforces live here.
- **Scores:** business 6, customer 3, AI 5. No build.

---

## 4. The headline read (for the CEO)

**This is a ~48-engineer-week build, front-loaded with the highest-stakes work and back-loaded with the highest-reward work — exactly the shape a safe programme should have.** The complexity and business-criticality concentrate in **rollout Phase 0** (the canon trio 03/04/14 — the event spine, the permission gate, the data model). That is the wall everything else stands on, and it is also the zero-regression event: it ships behind flags and changes *nothing* on the day it lands. After P0, the programme gets *easier and more visible*, not harder: Phase 2's read-only projections (Timeline, Search, Mission Control) are the lowest-complexity, highest-visibility chapters in the whole Bible, and they ship early. Risk falls as the programme runs.

**The reward is concentrated in the workforce (Ch.07/08) — the only two chapters that score 10 on AI leverage — and it is unlocked, not rushed.** The framework and roster are where the cost-avoidance thesis lives: one SDK becomes twelve budgeted, role-scoped employees for a roster ceiling around **$52/day**. But they ship **draft-only** in Phase 5 and cannot act until the safety ring (memory in P4, approvals in P6, the permission gate from P0) is fully in place. Execution (Phase 7) is the narrowest, last, most-gated step — one employee, one capability, CEO-approved, watched live. The pack's clearest message: **the architecture spends its complexity early to earn its autonomy late.**

**On the honest limits of these numbers:** customer value and direct ARR are *deliberately* modest scores across most chapters, because this is an internal operating system and an AI workforce — its dominant financial lever is **cost-avoidance and retention**, not new top-line. The customer feels it indirectly (faster support, fewer incidents, more trust from a genuinely secure platform) and directly only through the customer-touching employees. The estimate carries a ±40% band and excludes the soak windows, the security reviews, and the one true pre-flight gap — **a real Postgres in CI ([OQ-16](bible/20-glossary-conventions-decision-log.md))** — without which the irreversible-property tests cannot gate. None of that changes the verdict the [CEO Gate](CEO-GATE.md) reaches: the architecture is complete, the sequence is sound, and the programme is fundable and safe to begin **once the Release Candidate is in production and the seven §20.4.A decisions are made.** This pack is the map; the [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) is the week-by-week route.

---

*Derived entirely from the frozen Bible (v1.0). Every score is an informed, chapter-traceable estimate — not a measured fact or a delivery commitment. Companion documents: [Build Dependency Graph](BUILD-DEPENDENCY-GRAPH.md) · [Prioritisation Matrix](PRIORITISATION-MATRIX.md) · [Phase 7 Master Plan](PHASE-7-MASTER-PLAN.md) · [Implementation Rules](IMPLEMENTATION-RULES.md) · [CEO Gate](CEO-GATE.md).*
