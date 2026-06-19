# CrewFlow OS — Phase 7 Master Plan

**CEO Directive #003.5 ("Lock the Foundation") · Part 5 of 7 · The week-by-week launch plan**

> *"I want implementation to feel like launching a rocket, not writing software."* This is that plan. A countdown, an ignition, a staged ascent, and an orbital insertion — each week with one objective, concrete deliverables, a milestone gate it must pass, the tests that prove it, the risks it carries, and the live metric that says it worked. It executes [Ch.19's eight rollout phases](bible/19-rollout-plan.md) in the order the [Prioritisation Matrix](PRIORITISATION-MATRIX.md) confirmed is optimal.

---

## Naming, up front

The CEO roadmap calls this whole effort **"Phase 7"** — the company's seventh macro-phase. Internally it runs **[Ch.19's eight rollout phases (P0–P8)](bible/19-rollout-plan.md)**. To keep the two straight:

- **"The Phase 7 programme"** = the entire ~18-week build this document plans.
- **"Rollout Phase N"** = one of the eight internal stages (P0 Foundations … P8 Steady state).

Think of it as one rocket (the Phase 7 programme) with eight burns (the rollout phases).

---

## How to read this plan — and the universal contract

To avoid repeating the same boilerplate eighteen times, three things are **inherited by every week** and stated once here. Each week's card then lists only what is *specific* to it.

**1. Every week inherits the [per-phase contract](bible/19-rollout-plan.md) (Ch.19 §3):**
> additive migrations only · behind an `hq_settings` flag (default off) · preview deploy first · validation triplet (tsc / lint / tests) + Vercel build green · a written backout · success criteria defined as observable Ch.15 metrics · and the Golden-Rule check.

**2. Every week inherits the universal rollback (Ch.19 §7), cheapest-first:**
> flip the flag → (Phase 7) revoke the grant → drop + replay the projection → re-deploy the prior build. **No backout is ever a `down` migration that drops data.** Per-week cards note only the *phase-specific* rollback nuance.

**3. Every deliverable inherits the [Definition of Done](IMPLEMENTATION-RULES.md) (Part 6):**
> no feature is "done" without unit + integration + E2E tests, monitoring, audit logging, analytics, documentation, security review, performance validation, and accessibility review. A week's "milestone" is not passed until its deliverables meet that bar.

> **On the calendar.** Weeks are **nominal and evidence-gated, not promises.** Ch.19 is explicit: a phase advances when its predecessor's success criteria are green, *not* on a date. The ~18-week shape assumes 1–2 senior engineers at the Directive 007 cadence and ±40% (see the [Review Pack](CEO-REVIEW-PACK.md)). If a milestone isn't green, the rocket holds — **reliability over speed is enforced at the gate, not hoped for.** A slipped week delays *only its downstream* (see the [dependency graph](BUILD-DEPENDENCY-GRAPH.md)), never the already-flown stages.

---

## 🔻 T-minus — Countdown / Pre-flight (before Week 1)

*The launch cannot begin until the pad is clear and the checklist is green. This is not optional warm-up; it is the gate from [Ch.19 §4](bible/19-rollout-plan.md), and it is where the only true pre-flight gaps are closed.*

| | |
|---|---|
| **Objective** | Clear every precondition so Phase 0 can ignite with zero ambiguity. |
| **Deliverables** | (1) **PR #171 in production and stable** — the Release Candidate merged, live on `crewflow.uk`, soaked with no Sev-1/Sev-2 regression. (2) **The seven CEO decisions** ([Ch.20 §20.4.A](bible/20-glossary-conventions-decision-log.md)) recorded — gate rubric, first employee, approval conservatism, hash-chain now/later, human sub-roles, AI-email location, `q<T>()` promotion. (3) **The CI-Postgres harness** ([OQ-16](bible/20-glossary-conventions-decision-log.md)) — a real Postgres in CI so RLS and event-contract tests can actually gate. (4) Team, environments, and the `directive-008` implementation branch ready. |
| **Milestone (the launch gate)** | All five [Ch.19 §4 exit criteria](bible/19-rollout-plan.md) hold: merged & deployed · stable for the agreed soak · clean signals (Vercel green, no new Sentry cluster) · rollback proven · **CEO sign-off on direction**. |
| **Testing** | The RC's own revert path is *exercised*, not just available. The CI-Postgres harness runs one real RLS test green end-to-end. |
| **Risks** | RC instability (hold — do not start under a mid-release surface); the gate rubric (OQ-2) being left vague (fix the numbers *now*, not mid-flight). |
| **Success metric** | The [CEO Gate](CEO-GATE.md) is signed and the gate criteria are all green. **Ignition is authorised.** |

> **Why this matters most:** the single most important pre-flight task is the **CI-Postgres harness**. Until it exists, the irreversible-property tests that protect the spine and the gate cannot block a bad merge. Build it during the RC soak so it is ready the day Phase 0 lands.

---

## 🚀 Ignition — Rollout Phase 0: Foundations (Weeks 1–4)

*The first burn. The load-bearing core ships entirely behind flags, changing nothing on the day it lands. This is the highest-stakes stage and the one where "additive, zero-regression" is proven, not asserted.*

### Week 1 — The spine
- **Objective:** lay the event spine — the single source of "what happened."
- **Deliverables:** `hq_events` (append-only, monthly-partitioned, `RLS:hq`), the partition-creator cron, `hq_event_consumers`, the transactional-outbox trigger pattern (♻️ generalising `_record_activity()`), behind `spine.outbox_enabled` (off). ([Ch.04](bible/04-event-spine-and-taxonomy.md), [Ch.03 §03.1–03.2](bible/03-data-model.md))
- **Milestone:** an event written by the outbox appears in `hq_events` in preview, with next month's partition present.
- **Testing:** event-contract tests (the `Verb` union compiles; an unregistered verb does not); partition-health test; outbox-atomicity test (no event for an uncommitted change).
- **Key risk (R3):** the spine becomes a write-path bottleneck → one indexed insert in an existing transaction; consumer-lag is the canary.
- **Success metric:** spine **throughput > 0**; **partition health** = next month exists (critical if not).

### Week 2 — The verb registry + the gate begins
- **Objective:** lock the canonical event vocabulary and stand up the permission chokepoint.
- **Deliverables:** the full canonical **verb registry** as the generated `Verb` union ([Ch.04](bible/04-event-spine-and-taxonomy.md)); `hq_capabilities` / `hq_roles` / `hq_role_capabilities` / `hq_principal_roles` and the `authorize()` function ([Ch.14](bible/14-permissions-and-rbac.md)), behind `authz.enforce` (off).
- **Milestone:** `authorize(principal, capability, ctx)` returns `allow | deny | needs_approval` in preview, fail-closed on error.
- **Testing:** fail-closed test (a forced authz error denies, never allows); the catalogue-coverage test (every capability is registered).
- **Key risk (R2):** the new chokepoint regresses access → the additive seed (next week) is the mitigation; until then `authz.enforce` is off.
- **Success metric:** **fail-closed test green**; the `Verb`/`CapabilityKey` unions are the single source (compile-enforced).

### Week 3 — Zero-regression seed + service scaffold + flags
- **Objective:** prove the gate denies *nothing it didn't already deny*, and lay the plumbing.
- **Deliverables:** the **`super_admin` seed** — one role holding every capability, granted to every allowlisted super-admin email ([Ch.14 §Additive migration](bible/14-permissions-and-rbac.md)); the service-layer scaffold + `q<T>()` decision ([Ch.05](bible/05-services-and-apis.md), [OQ-7](bible/20-glossary-conventions-decision-log.md)); the `hq_settings` flag scaffold confirmed (♻️ exists).
- **Milestone:** **`requireCapability()` resolves identically to today's `isSuperAdminEmail()` → `requireHq()`** for every super-admin.
- **Testing:** the **seed/back-compat test** — every super-admin email resolves to the full capability set (the zero-regression proof); self-revocation-lockout prevention test.
- **Key risk (R2):** lockout → back-compat test is the gate; the last `super_admin` structurally cannot revoke itself.
- **Success metric:** **zero regression** vs `isSuperAdminEmail` (the day-one promise, measurable).

### Week 4 — Foundation soak + Phase-0 sign-off
- **Objective:** hold and watch; let the foundation set before building on it.
- **Deliverables:** observability of the spine's own health; the Phase-0 backout drill (flip both flags, confirm the system behaves exactly as today); the written Phase-0 success report.
- **Milestone:** **Phase 0 success criteria all green** ([Ch.19 §5 P0](bible/19-rollout-plan.md)); eng-lead sign-off to proceed.
- **Testing:** the full backout path exercised in preview (flags off → identical-to-today behaviour confirmed).
- **Key risk:** advancing on amber → the standing rule holds (a phase whose criteria aren't green does not advance).
- **Success metric:** no change to existing-page error rate or p95; spine writing; seed proven. **Foundation is load-bearing.**

---

## 🛰️ Ascent — Rollout Phases 1–6 (Weeks 5–17)

### Rollout Phase 1: Observability (Week 5)

#### Week 5 — Eyes before everything
- **Objective:** make every later stage measurable from its first minute — *you cannot roll out what you cannot see.*
- **Deliverables:** the metric registry (`hq_metric_definitions` seeded + `hq_metrics` + `hq_metric_counters`), tracing by `correlation_id` over the spine (`hq_runs`/`hq_spans`), the immutable-audit posture confirmed on ♻️ `admin_activity_log`, golden-signal/SLO/alert routing. ([Ch.15](bible/15-observability-metrics-audit.md)) Behind `observability.consumers_enabled` / `metrics.rollup_enabled`.
- **Milestone:** **consumer lag computes and a `getTrace(correlation_id)` reconstructs the dunning waterfall** end-to-end.
- **Testing:** consumer-lag SLO test; trace-reconstruction test; audit-write-error test (≈0); projection replay test (drop + rebuild from offset 0).
- **Key risk (R9):** observability lagging the features it must watch → this is *why* it's Phase 1, ahead of everything consequential.
- **Success metric:** **consumer lag < 500 events / < 60s** (the canary the whole rollout watches); non-empty `getMetricsSnapshot()`; audit-write error ≈ 0.

### Rollout Phase 2: Read-only projections (Weeks 6–8)

#### Week 6 — The Timeline
- **Objective:** "see everything that happened to this company in one place" — the first visible win.
- **Deliverables:** the global / per-entity / per-employee timeline projected from the spine; the **idempotent backfill** of ♻️ `activity_log` + `admin_activity_log` history (originals untouched). ([Ch.11](bible/11-event-timeline.md)) Behind `timeline.enabled`.
- **Milestone:** the timeline renders a company's activity stream; the backfill completes with **no duplication**.
- **Testing:** the backfill **oracle test** (re-running does not duplicate, keyed by `(source, source_id)`); projection-replay test.
- **Key risk (R10):** backfill double-counts → idempotency key + oracle test.
- **Success metric:** backfill completes clean; query **p95 < 200ms**; no rise in existing-page error rate.

#### Week 7 — Global Search + ⌘K
- **Objective:** find anything instantly (find mode; no action verbs yet).
- **Deliverables:** `hq_search_index` maintained additively by triggers + the ⌘K command palette in *find* mode. ([Ch.10](bible/10-global-search.md)) Behind `search.enabled`.
- **Milestone:** ⌘K returns ranked cross-entity results within budget.
- **Testing:** ranking/threshold tests ([OQ-17](bible/20-glossary-conventions-decision-log.md)); index-trigger correctness; accessibility pass on the palette (keyboard-first).
- **Key risk:** search latency drift → the Ch.17 external-search trigger is armed (not adopted) behind `searchHq()`.
- **Success metric:** ranked results within the latency budget; index stays current with writes.

#### Week 8 — Mission Control, read-only
- **Objective:** stand up the OS homepage — the front door — reading precomputed rollups.
- **Deliverables:** the `/admin` landing surface rendered from `hq_metrics` + a recent-events slice + the **tile-provider registry** filtered by capability; `hq_operator_dashboard` (§03.15c). ([Ch.09](bible/09-mission-control.md)) Behind `mission_control.enabled`. **Read-only — no live deltas, no inbox yet.**
- **Milestone:** an operator sees *what happened* on one screen, with tiles gated by their capabilities.
- **Testing:** the **metric snapshot < 50ms server-side** and O(1)-in-company-count performance test ([Ch.15 §Performance](bible/15-observability-metrics-audit.md)); capability-filtering test (a tile you may not see does not render); responsive-layout pass.
- **Key risk:** a slow tile blocks the home → tiles are independent islands; one slow loader degrades only itself.
- **Success metric:** **MC snapshot < 50ms**; tiles correct per capability. *Golden-Rule check: the company's activity is visible in one place for the first time.*

### Rollout Phase 3: Real-time (Weeks 9–10)

#### Week 9 — The broadcaster (security-gated)
- **Objective:** liveness without exposing the spine — server-authorised Broadcast only.
- **Deliverables:** the service-role broadcaster owning `consumer='realtime'`, authorising each event for the HQ audience and shaping a **minimal vetted delta**; the reusable `<LiveRegion>`/`useLiveEvents()` island with reconnect, snapshot-resync, polling fallback. ([Ch.06](bible/06-realtime-infrastructure.md)) Behind `realtime.enabled`.
- **Milestone (with explicit security review):** events broadcast to the HQ audience **without `hq_events` ever being client-subscribable** (the R4 hard-no, ADR-003).
- **Testing:** the security-boundary test (the browser holds no service-role client, subscribes to no table); reconnect/resync test; **a dedicated security review of the broadcast boundary** (Ch.19 §9 requires it).
- **Key risk (R4):** `hq_events` exposed to clients → architecturally prevented; the review confirms it.
- **Success metric:** broadcast fan-out healthy; **reconnect rate < 5%/min**; `consumer='realtime'` lag within SLO.

#### Week 10 — Mission Control goes live + presence
- **Objective:** the "it's alive" moment — the home changes under you without a refresh.
- **Deliverables:** Mission Control and the Timeline flip from snapshots to **live-prepending**; ephemeral presence ("who is here"). ([Ch.06](bible/06-realtime-infrastructure.md)/[Ch.09](bible/09-mission-control.md))
- **Milestone:** an event occurs and Mission Control updates within the operator-experience budget (a few seconds).
- **Testing:** end-to-end liveness test (emit → broadcast → island update); degradation test (broadcaster down → falls back to polling, no data loss).
- **Key risk:** liveness failure cascades → it degrades to Phase-2 polling; the spine/projections are untouched.
- **Success metric:** worst-case delivery latency within budget; error budget not burning. *Golden-Rule check: Mission Control is alive.*

### Rollout Phase 4: Memory (Weeks 11–12)

#### Week 11 — The memory graph
- **Objective:** give the workforce recall *before* it can act — knowledge precedes action.
- **Deliverables:** the `vector` extension + `hq_memories.embedding` + HNSW index; `hq_memory_edges` (typed, scored, provenance); **hybrid recall** (FTS + vector + edge traversal). ([Ch.12](bible/12-memory-graph.md), ♻️ the 26KB `hq-memory.ts`) Behind `memory.embeddings_enabled` / `memory.graph_enabled`.
- **Milestone:** a hybrid query returns provenance-stamped results fusing all three signals.
- **Testing:** recall-quality test on a fixture corpus; fusion-weight sanity ([OQ-12](bible/20-glossary-conventions-decision-log.md)); the embedding model/dimension decision ([OQ-11](bible/20-glossary-conventions-decision-log.md)) recorded.
- **Key risk (R1):** a heavy migration locks a hot table → `embedding` is a *nullable add*; recall degrades to FTS-only until backfilled.
- **Success metric:** hybrid recall returns provenance; **no regression to existing memory-search latency**.

#### Week 12 — Lazy backfill + memory soak
- **Objective:** populate embeddings without blocking writes; confirm graceful degradation.
- **Deliverables:** the lazy embedding backfill (off the write path); memory-assert/supersede events flowing to the spine.
- **Milestone:** backfill progresses while writes continue unaffected.
- **Testing:** backfill-does-not-block-writes test; versioned-conflict test (conflicting facts versioned, never overwritten).
- **Key risk:** backfill pressure → it runs off the write path and is resumable.
- **Success metric:** embedding backfill progresses; `memory.*` events on the spine. *Vector recall is HNSW (sub-linear) — the one-million answer for memory.*

### Rollout Phase 5: AI runtime, DRAFT-ONLY (Weeks 13–15)

#### Week 13 — The runtime
- **Objective:** stand up the uniform employee runtime — but with no power to act.
- **Deliverables:** `ai_employee_runs` / `ai_employee_tool_calls` / `ai_employee_schedules` + the FSM (*perceive → plan → gate → act → record → reflect*) + the typed tool registry (every tool carries `required_capability`). ([Ch.07](bible/07-ai-employee-framework.md)) Behind `runtime.enabled` + `runtime.draft_mode`.
- **Milestone:** an employee can `perceive` and `plan` and produce a structured proposal; `authorize()` **denies every side-effecting tool** (no capability held).
- **Testing:** the draft-mode assertion (no `act` reaches a side-effect regardless of policy); the empty-capability-set test (a principal with no roles can do nothing).
- **Key risk (R5):** premature execution → defence in depth (`foundation`/`locked()` + `authorize()` denies a wish + `runtime.draft_mode`).
- **Success metric:** every run records `cost_usd`/tokens/latency from run one; **zero side-effects** emitted.

#### Week 14 — Research AI folds in + cost becomes visible
- **Objective:** prove the runtime on the one live executor, and make AI cost a first-class, watched number.
- **Deliverables:** **Research AI folds into the framework** (not rebuilt — it remains the single live executor of its own `research.execute`); the **AI cost/employee/day tile** (P9, the most-watched signal); per-employee budget governors + circuit breakers. ([Ch.07 §Cost](bible/07-ai-employee-framework.md))
- **Milestone:** Research AI runs through the general runtime with its existing KPIs steady; cost is a live tile.
- **Testing:** Research-AI-parity test (behaviour unchanged through the fold-in); budget-circuit-breaker test (overrun suspends, not crashes).
- **Key risk (R6):** cost runaway → budgets + breakers + the live tile + an SLO that catches drift before month-end.
- **Success metric:** **run error rate < 1%**; cost/employee/day within budget; Research AI KPIs hold.

#### Week 15 — Onboard all twelve (`locked()`)
- **Objective:** the workforce becomes real — twelve employees, none able to act.
- **Deliverables:** all twelve onboarded as principals with `foundation:true`/`locked([...])` — draft/propose/review only. ([Ch.08](bible/08-ai-employee-roster.md))
- **Milestone:** twelve employees exist, each draft-only; the roster ceiling (~$52/day) is one tile.
- **Testing:** the per-employee no-danger-capability assertion (no `ai.tool_called` with a granted danger capability); roster-budget aggregation test.
- **Key risk (R5):** a foundation employee acting → asserted impossible (empty capability set + draft mode).
- **Success metric:** **zero side-effects from any `foundation` employee**; roster cost ceiling visible. *The workforce is hired — and cannot yet touch anything.*

### Rollout Phase 6: Approvals (Weeks 16–17)

#### Week 16 — The policy engine + inbox
- **Objective:** build the human-in-the-loop ring so drafts can route to people.
- **Deliverables:** `hq_approvals` + `hq_approval_policies` (route `auto` / `require_human` / `dual_control` by employee × capability × risk × amount); the **Approvals Inbox** as a primary Mission Control zone with `projected_effect` (decide on plain language). ([Ch.13](bible/13-approvals-and-human-oversight.md)) Behind `approvals.enabled`. **Defaults maximally conservative** ([OQ-4](bible/20-glossary-conventions-decision-log.md)).
- **Milestone:** a draft routes to the inbox carrying *exactly what would execute* and *what it means*.
- **Testing:** policy-routing tests; the CAS single-decision test (one decision wins); expiry-changes-nothing test.
- **Key risk:** a stale `projected_effect` → re-render from a fresh payload at decision time ([OQ-15](bible/20-glossary-conventions-decision-log.md)).
- **Success metric:** approvals route correctly; the inbox is live (via Phase 3). *Golden-Rule check: Mission Control now asks you for decisions.*

#### Week 17 — Dual-control + SLAs
- **Objective:** make the dangerous powers require two humans, and stop anything stalling silently.
- **Deliverables:** dual-control (two distinct humans, AI never an approver) with `billing.refund` wired dual-control from the start; SLA timers + escalation. ([Ch.13](bible/13-approvals-and-human-oversight.md)/[Ch.14 §Dual-control](bible/14-permissions-and-rbac.md))
- **Milestone:** an action cannot execute with one approver; requires two distinct humans; no AI in the approver set.
- **Testing:** the dual-control tests (one approver insufficient; two distinct required; AI rejected as approver); SLA-escalation test.
- **Key risk (R7):** a dangerous action firing without control → dual-control + conservative defaults; `billing.refund` never AI-executed.
- **Success metric:** **approval latency p95 < 30 min** (business hours); dual-control enforced; every decision in ♻️ `admin_activity_log` with `decided_by`.

---

## 🌍 Orbital insertion — Rollout Phase 7: Graduated execution (Week 18 →, CEO-gated)

*The payoff burn. AI begins to act — but only by deliberate, per-employee, per-capability grants, lowest-risk first, each CEO-gated. This is not a "week"; it is a controlled cadence that continues as trust is earned.*

| | |
|---|---|
| **Objective** | Let one employee execute one low-blast-radius capability, watched live, and only then consider the next. |
| **Deliverables (per grant)** | For the CEO-chosen first employee ([OQ-3](bible/20-glossary-conventions-decision-log.md) recommends **Support AI, draft→send behind approval**): set `permissions.can_execute`, grant **one** capability via `hq_principal_roles`, under an explicit approval policy, behind a per-employee `execute.<slug>` flag. ([Ch.08](bible/08-ai-employee-roster.md)/[Ch.07](bible/07-ai-employee-framework.md)) |
| **Milestone (CEO gate, per capability)** | The CEO approves *which employee* and *which capability*. Both `can_execute` **and** the flag **and** a policy must be true for any execution (three independent locks). |
| **Testing** | Pre-grant: green AI evals for that capability ([Ch.18](bible/18-testing-strategy.md)); the least-privilege test (no `ai.tool_called` without a held capability); the **`AI principal attempting `permission.*` → `critical` alert** wired (must never fire). |
| **Rollback (phase-specific)** | Revoke the capability or flip `execute.<slug>` off → instant revert to draft-only; in-flight runs park at the gate; the **full audit of what it did while live is preserved**. |
| **Risks (R5/R7)** | Premature/over-broad execution → one capability, one employee, three locks, live cost/error tile, CEO gate. **`billing.refund` and the four highest-risk powers never graduate to AI.** |
| **Success metric** | The graduated employee's **run error rate & cost/day within budget**; eval pass-rate holds; **zero unauthorised side-effects**. Each capability is judged green *before* the next is granted — reliability over speed. |

> **Cadence, not calendar:** Phase 7 advances one capability at a time on evidence. Week 18 is *first ignition of execution*, not "execution finished." The CEO gates every step.

---

## 🛰️ On-orbit — Rollout Phase 8: Steady state (continuous, post-Week 18)

| | |
|---|---|
| **Objective** | Operate the OS, arm the scaling exits, and make the Bible the standing reference. |
| **Deliverables** | The [Ch.17 graduation triggers](bible/17-scalability.md) armed **as monitors** (pgmq, broker, external search, dedicated vector store — none adopted, each watched behind its service boundary); continuous workforce eval; optional hash-chained audit on the SOC2 path ([OQ-1](bible/20-glossary-conventions-decision-log.md)); cost forecasting (P9: measure → bound → predict). |
| **Milestone** | All golden signals within SLO at steady state; the Bible governs every new feature ([Ch.00 freeze](bible/00-INDEX.md)). |
| **Rollback** | Each graduation is itself flag-gated behind its service boundary — revert to the Postgres-native default. |
| **Risks** | A graduation fired without its trigger → triggers are *measured thresholds*, never speculative (P6). |
| **Success metric** | Error budgets not chronically burning; cost forecast tracks actuals; **no graduation activated without its measured trigger**. *Golden-Rule, now continuous: the OS runs the company, and every number is a doorway.* |

---

## The launch dashboard (the signals that must stay green the whole flight)

Independent of any one week, these [Ch.15 golden signals](bible/15-observability-metrics-audit.md) are watched continuously from Phase 1 onward. A red here **holds the next phase**, no matter the calendar:

| Signal | Green means | Goes red when | Watched from |
|---|---|---|---|
| **Consumer lag** | `max(id) − last_event_id` < 500 / < 60s | a projector falls behind | P1 |
| **Partition health** | next month's partition exists | the cron fails (critical) | P0 |
| **Dead-event count** | 0 | a poison event dead-letters (critical) | P1 |
| **Existing-page error rate / p95** | flat vs pre-programme baseline | any phase regresses the live HQ | P0 |
| **AI cost / employee / day** | within each budget | spend drifts (the P9 signal) | P5 |
| **Run error rate** | < 1% | the workforce misbehaves | P5 |
| **Unauthorised side-effects** | 0 | an AI acts without a held capability (critical) | P5/P7 |
| **Approval latency p95** | < 30 min (business hours) | the human ring stalls | P6 |

---

## Programme risk register (the rocket's abort modes)

The [Ch.19 §8 risk register](bible/19-rollout-plan.md) (R1–R10) is the authoritative list; here is the programme-level summary of *how the plan itself absorbs a shock*:

| If this happens… | The plan's response |
|---|---|
| A milestone is **amber, not green** | **Hold.** The phase does not advance; diagnose and fix. The standing rule (Ch.19 §9) is enforced at sign-off. |
| A phase **destabilises the live HQ** | Flip its flag off (seconds); behaviour reverts to the prior phase; inert tables wait for the fix. |
| The **RC isn't stable** at T-minus | Phase 0 does not start. The programme is paperwork until the gate is green. |
| A **dependency slips** (e.g. memory) | Only its *downstream* waits ([dependency graph](BUILD-DEPENDENCY-GRAPH.md)); already-flown stages are untouched. |
| An **AI acts wrongly** in Phase 7 | Revoke the one grant; instant draft-only; the audit trail of what it did is preserved (the safety record). |
| **CI can't truly gate** (OQ-16 unresolved) | The programme **does not begin** — the harness is a T-minus deliverable, not a nice-to-have. |

---

## Mission success — the definition

The Phase 7 programme is **complete** when:

1. **The OS is live and self-observing** — every action (human or AI) lands on the spine, every projection is replayable, every golden signal is green (Phases 0–3).
2. **The workforce exists and remembers** — twelve employees onboarded, with hybrid recall, all draft-capable (Phases 4–5).
3. **The human stays in command** — every consequential AI action routes through approvals; dangerous powers are dual-control and never AI-executed (Phase 6).
4. **At least one employee executes, safely and CEO-gated** — one capability, watched green, zero unauthorised side-effects, instantly revertible (Phase 7).
5. **Scaling is armed, not adopted** — every graduation trigger is a monitor; the Bible is the standing reference for everything built next (Phase 8).

> When all five hold, CrewFlow is no longer a product with an admin panel. It is an operating system that runs the company — live, connected, observable everywhere, actionable by AI — installed under a live product **without a single outage**. That is the mission. This is the flight plan.

---

*Executes [Ch.19 Rollout Plan](bible/19-rollout-plan.md) (canon) in the order confirmed optimal by the [Prioritisation Matrix](PRIORITISATION-MATRIX.md), constrained by the [Build Dependency Graph](BUILD-DEPENDENCY-GRAPH.md), to the quality bar of the [Implementation Rules](IMPLEMENTATION-RULES.md). Weeks are evidence-gated estimates, not commitments. Companion documents: [CEO Review Pack](CEO-REVIEW-PACK.md) · [CEO Gate](CEO-GATE.md).*
