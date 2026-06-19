# Chapter 19 — Rollout Plan (Cross-cutting)

> **A note on this chapter's shape.** Ch.19 is a Volume V cross-cutting chapter, not a system chapter (05–17), so it does *not* follow the fourteen-section template. It is a rollout plan: a gate, eight phases, and the mechanics that make each phase safe. It still opens with Purpose and Goals, still references the canon by number, and still answers the Golden Rule — because *how* we ship the OS must itself be sound at one million companies.

---

## 1. Purpose

This chapter is the plan for installing the operating system **underneath a live product without an outage, a regression, or a big-bang cutover**. The Bible says *what* to build and *why*; this chapter says *in what order*, *behind which switch*, *how we know it worked*, and *how we turn it off* if it did not. It is the chapter the CEO reads to approve direction (Ch.00 reading guide) and the chapter every engineer returns to before starting a phase.

The whole plan is one principle (P7) made concrete: **reversible, flag-gated, preview-first.** Nothing here is a one-way door. Every phase is additive, observable before it is active, and revertible by flipping a single row in `hq_settings`. We ship the OS the way Directive 007 shipped the design system — incrementally, gated, and clean — except the cargo this time is an event spine, a workforce, and a protection ring rather than colour tokens.

---

## 2. Goals & non-goals

**Goals**

- **A safe sequence.** An order of phases in which every phase depends only on phases already shipped, and each phase leaves the HQ fully working and *better*.
- **Zero regression on day one.** The first capability migration seeds a `super_admin` role holding every capability and grants it to every allowlisted super-admin, so the new `authorize()` chokepoint changes *nothing* on the day it lands (Ch.14).
- **Independently revertible phases.** Each phase is gated by its own flag(s) in `hq_settings`; flipping a flag off restores the prior behaviour without a deploy and without dropping data.
- **Observable before active.** Observability (Ch.15) ships *before* anything consequential, so every later phase is measurable from its first minute — *you cannot roll out what you cannot see.*
- **One capability at a time.** AI execution is granted per employee, per capability, lowest-risk first, on evidence — never as a block.

**Non-goals**

- **Not** destabilising the live product. The HQ serves the business throughout; no phase requires downtime, a tenant-schema change, or a relaxation of tenant RLS (Ch.01 non-goals, Ch.16).
- **Not** a big-bang. There is no "switch to the OS" day. The OS *accretes*; the collection of pages becomes an operating system one additive island at a time (P2).
- **Not** a rewrite of what already works. Research AI — the one live executor — *folds into* the framework; it is not rebuilt (Ch.07, ♻️ `hq-research.ts`).
- **Not** speculative infrastructure. No broker, search cluster, or vector store ships before a measured trigger demands it (P6, Ch.17). The phases below adopt none.

---

## 3. Principles of this rollout

Five rules govern every phase. They are P-numbers from Ch.01, specialised to shipping.

1. **Preview-first (P7).** Every change reaches a Vercel preview deployment before production. The preview is where the validation triplet (tsc / lint / tests) and the Vercel build must be green, and where a human exercises the flag on/off path. Production follows only after the preview is approved. This is an established operating principle (Ch.01), not a new ceremony.
2. **Additive + flagged (P2).** Every migration is `create`/`add column` — forward-only, non-destructive (Ch.03 §Migration plan). Every behaviour change is wrapped in a flag in `hq_settings`, default **off**. Shipping code and activating code are two separate acts; the first is routine, the second is a decision.
3. **Observable before active (P3).** A phase that cannot be measured does not go active. Observability and the metric registry (Ch.15) ship in Phase 1, before any consequential behaviour, so every subsequent phase has golden signals from day one.
4. **One capability at a time (P4/P5).** Autonomy is granted, never assumed. Execution is enabled per employee, per capability, lowest blast-radius first, each behind its own approval policy and watched against evals, cost, and audit.
5. **Reliability over speed.** When a phase's success criteria are not green, the phase does not advance — we hold, diagnose, and fix. A slower, sound rollout beats a fast one that destabilises a live company-operating surface. The schedule is *relative and evidence-gated* (§10), never a calendar promise.

**The per-phase contract** (every phase, no exceptions): additive migrations only · behind a flag in `hq_settings` (default off) · preview deploy first · validation triplet + Vercel build green · a written backout · success criteria defined as **observable metrics from Ch.15** · and the Golden-Rule check — *does this phase make CrewFlow feel more like an operating system than a collection of pages?* If a phase does not move that needle, it does not ship.

---

## 4. The gate: PR #171 to production & stable, *before* Phase 0

There is a hard gate before any Bible/OS work begins. **The Release Candidate, PR #171 (branch `feature/design-system-foundation`), is frozen and ships first.** No OS migration is written, no flag is added, no spine table is created until PR #171 is in production *and* proven stable. The RC branch is never touched by OS work (Ch.00 ground rules); the OS is authored on `directive-008/architecture-blueprint` and its successors.

Why a gate and not a parallel track: the OS installs *underneath* the live HQ. Installing underneath a surface that is itself mid-release doubles the blast radius and makes any regression impossible to attribute. We let the foundation set before we build on it — the same discipline by which Directive 007 was production-verified before #008 was even proposed (ARCHITECTURE, Prerequisite).

**Exit criteria for the gate (all must hold before Phase 0 starts):**

- **Merged & deployed.** PR #171 is merged and live in production on `crewflow.uk`, not merely approved.
- **Stable for a soak window.** A defined soak period elapses in production with **no Sev-1/Sev-2 regression** attributable to the release, judged against the existing golden signals (error rate, p95, the health surface).
- **Clean signals.** Vercel build green on `main`; no open release-blocking bug; Sentry shows no new error cluster traceable to the RC.
- **Rollback proven, not just available.** The RC's own revert path has been confirmed deployable (we do not enter Phase 0 trusting an untested backout).
- **CEO sign-off on direction.** The blueprint (ARCHITECTURE.md) and this Bible are approved (Ch.00 — "no production code … until the CEO approves the blueprint **and** the RC is in production and stable").

🔬 **Open question for Ch.20:** the exact soak-window length and the precise "stable" rubric (which signals, which thresholds, over how many days) are a decision for the CEO/CTO to fix before the gate is asserted.

Until every criterion is green, the OS programme is paperwork. The moment they are, Phase 0 may begin.

---

## 5. The eight phases

The eight phases are a finer-grained decomposition of the seven-row sequence in ARCHITECTURE §19 — the same order, split so that *observability* and *the control plane* each get their own phase, and so AI work is cleanly divided into *draft-only*, *oversight*, and *graduated execution*. The ordering mirrors the migration ordering in Ch.03 §Migration plan: **spine → observability → read-models → real-time → memory → runtime → approvals → execution.** Each phase below states: *what ships*, *why it is safe*, *the flag(s)*, *dependencies*, *the backout*, and *the observable success criteria* (metrics from Ch.15).

A convention for the flags: all live in `hq_settings`, all default **off**, and every flip emits `system.flag_changed` (Ch.04) so the rollout audits itself. Flag keys below are illustrative (🔬 final key names are an implementation detail, fixed at build time).

---

### Phase 0 — Foundations / canon (the spine, verbs, the protection ring, flags)

**What ships.** The load-bearing core, entirely behind flags, with **no behaviour change**:
- `hq_events` — the append-only, monthly-partitioned spine — plus the partition-creator cron and `hq_event_consumers` (Ch.03 §03.1–03.2; Ch.04). ♻️ generalises the existing `_record_activity()` / `notify_*` trigger pattern into the transactional outbox.
- The **canonical verb registry** (Ch.04) as the typed `Verb` union — an unregistered verb will not compile.
- `hq_capabilities` / `hq_roles` / `hq_role_capabilities` / `hq_principal_roles` and the `authorize()` chokepoint (Ch.14), **seeded so a `super_admin` role holds every capability and every allowlisted super-admin email is granted it.**
- The `hq_settings` flag scaffold itself (♻️ `hq_settings` already exists) — the switchboard every later phase plugs into.

**Why it is safe.** Every table is `RLS:hq` (service-role only); no tenant table is touched. Outbox triggers *write* events but nothing *reads* them yet, so users see nothing. The permission seed is the crux of zero-regression: because every existing super-admin holds every capability on seed, `requireCapability()` resolves identically to today's `isSuperAdminEmail()` → `requireHq()` — **the new chokepoint denies nothing it did not already deny** (Ch.14 §Additive migration). This is the additive-migration design that the whole rollout models itself on.

**Flag(s).** `spine.outbox_enabled` (gate the AFTER-trigger emissions), `authz.enforce` (gate whether `authorize()` is consulted vs. the legacy binary gate). Both off → the system behaves exactly as it does today.

**Dependencies.** The gate (§4) only.

**Backout.** Flip both flags off: outbox triggers stop emitting; `authorize()` falls back to the binary super-admin check. The tables remain (additive, harmless, unread). No data is dropped — the spine is append-only and the capability rows are inert when `authz.enforce` is off.

**Success criteria (Ch.15).** Spine **throughput** > 0 (events are being written by the outbox); **partition health** = next month's partition exists (a `critical` signal if not); the **seed/back-compat test** passes — every super-admin email resolves to the full capability set (zero regression vs `isSuperAdminEmail`); **fail-closed test** green (a forced authz error denies, never allows). No change to existing-page error rate or p95.

---

### Phase 1 — Observability & audit (so every later phase is visible from minute one)

**What ships.** The system monitor (Ch.15), consuming the spine that Phase 0 began writing:
- The **metric registry** `hq_metric_definitions` (seeded) + `hq_metrics` rollups + the live-counter store `hq_metric_counters` (Ch.03 §03.14–03.15b). ♻️ promotes `lib/hq/metrics.ts` into one-formula-per-metric.
- **Tracing** by `correlation_id` over `hq_events`, and `hq_runs` / `hq_spans` (Ch.03 §03.18) — ♻️ generalising `withCronTelemetry` / `cron_runs` across cron/ai/webhook/projection.
- The **immutable audit** posture confirmed on ♻️ `admin_activity_log` (append-only, service-role only), with the hash-chain *seam* specified but not necessarily enabled (🔬).
- The golden-signal definitions, SLOs, and alert routing (♻️ `hq-alerts-scheduler` + `admin_alert_state`).

**Why it is safe.** Pure projections (Ch.04 *projection* class: pure, fast, offset-driven, idempotent) — read-only consumers of the spine. They invent no behaviour and own no source of truth; each is droppable and replayable. The audit table is reused, not replaced.

**Flag(s).** `observability.consumers_enabled` (the trace/counter consumers), `metrics.rollup_enabled` (the rollup cron).

**Dependencies.** Phase 0 (the spine must be emitting for there to be anything to observe).

**Backout.** Flip the flags off: consumers stop draining, rollups stop. Read-models (`hq_metrics`, traces) are rebuildable from the spine by replaying offsets, so turning them off loses nothing — the spine retains the full history (Ch.15 §Failure handling).

**Success criteria (Ch.15).** **Consumer lag** (`max(id) − last_event_id`) computes and stays within SLO (< 500 events / < 60s) — *the canary the rest of the rollout watches*; a `getTrace(correlation_id)` reconstructs the Ch.02 dunning waterfall correctly; the metric registry produces a non-empty `getMetricsSnapshot()`; **audit-write error rate** ≈ 0. From this phase on, every later phase reports against these signals.

---

### Phase 2 — Read-only projections (Timeline, Search, Mission Control — read-only)

**What ships.** High-value, low-risk *views* over the spine, all read-only, no AI execution:
- The **Event Timeline** (Ch.11) — global, per-entity, and per-employee feeds projected from `hq_events`, plus the idempotent backfill of ♻️ `activity_log` + `admin_activity_log` history into the spine (originals untouched, P2).
- **Global Search** (Ch.10) — `hq_search_index` (Ch.03 §03.13) maintained additively by triggers, plus the ⌘K command palette in *find* mode (no action verbs yet).
- **Mission Control** (Ch.09, inferred from Ch.11/15) — the `/admin` landing surface rendered from precomputed `hq_metrics` rollups and a recent-events slice, **read-only** (no live deltas, no approvals inbox yet).

**Why it is safe.** Every surface is a *read*. The timeline reads the spine; search reads `hq_search_index`; Mission Control reads `hq_metrics`. Nothing writes state, nothing executes. The backfill is idempotent (keyed by `(source, source_id)`) so re-runs do not duplicate (Ch.04 §Backfill). Existing pages keep working; these are *new* islands beside them.

**Flag(s).** `timeline.enabled`, `search.enabled`, `mission_control.enabled` (each independently revertible).

**Dependencies.** Phase 0 (spine), Phase 1 (so the new surfaces are themselves observable as they come up).

**Backout.** Flip any flag off and that surface is hidden; the page falls back to the existing SSR pages it sits beside. The backfill is non-destructive — the originals remain authoritative for their domains, so a hidden timeline loses nothing.

**Success criteria (Ch.15).** Timeline **backfill** completes with no duplication (oracle test, Ch.04); search returns ranked results within budget; Mission Control **metric snapshot < 50ms server-side** and is O(1) in company count (Ch.15 §Performance); query **p95 < 200ms**; no rise in existing-page error rate. The Golden-Rule check: an operator can *see* the company's activity stream in one place for the first time.

---

### Phase 3 — Real-time (the island model; Mission Control goes live)

**What ships.** Liveness, delivered by ♻️ Supabase Realtime, which is present but entirely unused today (Ch.06):
- The **broadcaster** — a server-side, service-role consumer of the spine owning `consumer = 'realtime'` in `hq_event_consumers` — which authorises each event for the HQ audience and **broadcasts a minimal, vetted delta** (Ch.06 §The broadcaster).
- The reusable **island**: one `<LiveRegion>` / `useLiveEvents()` pattern with reconnect, snapshot-resync, and a polling fallback.
- **Presence** ("who is here") on Realtime's ephemeral presence primitive — deliberately *not* a durable fact.
- Mission Control and the Timeline flip from read-only snapshots to **live-prepending** surfaces.

**Why it is safe.** The broadcaster is a *reader*, never in the write path — if it is down, liveness degrades to polling and the spine/projections are unaffected (Ch.06 §Resilience). Critically, it **does not expose `hq_events` to client subscriptions**: HQ tables stay `RLS:hq` (zero policies); the browser never holds the service-role client and never subscribes to a table. This is the hard-no honoured (Ch.06 §Why not `postgres_changes`, Ch.16) — server-authorised Broadcast only, an ADR already settled in Ch.20.

**Flag(s).** `realtime.enabled` (♻️ the broadcaster reads this from `hq_settings` as its kill switch) plus fan-out/sampling parameters.

**Dependencies.** Phase 0 (spine), Phase 2 (the surfaces that go live).

**Backout.** Flip `realtime.enabled` off: the broadcaster stops, islands fall back to slow polling, and pages revert to SSR snapshots — exactly the Phase-2 behaviour. No data implication; presence is in-memory and ephemeral.

**Success criteria (Ch.15).** **Broadcast fan-out** healthy and **reconnect rate < 5%/min**; worst-case delivery latency within the operator-experience budget (≤ a few seconds on the launch deployment, Ch.06 §Where the broadcaster runs); consumer lag for `consumer='realtime'` within SLO; no increase in error budget burn. The Golden-Rule check: Mission Control *changes under you* without a refresh — the first "it's alive" moment.

---

### Phase 4 — Memory graph (employees can READ/WRITE memory before they can ACT)

**What ships.** The semantic layer over the most-built foundation we have (Ch.12, ♻️ the 26KB `hq-memory.ts` engine + `hq_memories` and its relationship/version/grant tables):
- The `vector` extension + `hq_memories.embedding` (replacing the reserved `embedding_placeholder`) + the HNSW index, and `hq_memory_edges` — typed graph edges with weight, confidence, and provenance (Ch.03 §03.16–03.17).
- **Hybrid recall** (FTS + vector similarity + edge traversal) and a **lazy embedding backfill** (nullable column; recall degrades gracefully to FTS-only until backfilled).

**Why it is safe.** Additive: a new column and a new edge table; the embedding backfills lazily and is ignorable until present (Ch.03 §Failure handling). This phase grants employees *knowledge*, not *action* — they can read and assert memory, but no side-effecting capability is enabled here. Memory writes are themselves gated by ♻️ `hq_memory_access_grants` (least privilege for knowledge).

**Flag(s).** `memory.embeddings_enabled`, `memory.graph_enabled`.

**Dependencies.** Phase 0 (the `memory.*` verbs on the spine), Phase 1 (observability of the backfill). It is sequenced *before* the runtime so employees have real recall before they do anything (ARCHITECTURE §19, Phase 5 rationale).

**Backout.** Flip the flags off: recall falls back to the existing FTS-only path; the `embedding` column and `hq_memory_edges` remain, inert and harmless. No memory is deleted — conflicting facts are versioned, never overwritten (Ch.12).

**Success criteria (Ch.15).** Embedding backfill progresses without blocking writes; hybrid recall returns provenance-stamped results; memory-assert/supersede events flow to the spine; no regression to existing memory-search latency. Vector recall uses HNSW (sub-linear) — the Golden-Rule answer for memory at scale.

---

### Phase 5 — AI framework, DRAFT-ONLY (the runtime; all 12 onboarded `locked()`; Research AI folds in)

**What ships.** The uniform runtime, generalised from the one proven executor (Ch.07, ♻️ `hq-research.ts` + `research-llm.ts` + the `research-drain` cron pattern):
- `ai_employee_runs` / `ai_employee_tool_calls` / `ai_employee_schedules` and the additive state-machine columns on ♻️ `ai_employee_tasks` (Ch.03 §03.3–03.6).
- The lifecycle FSM (*perceive → plan → gate → act → record → reflect*) and the typed **tool registry**, every tool carrying a `required_capability`.
- **All twelve employees onboarded** as principals with `foundation:true` / `locked([...])` — **draft, propose, review only; the runtime refuses to ACT for a foundation employee** (Ch.08 §Permissions baseline). **Research AI folds into the framework** rather than being rebuilt — it remains the single live executor of its own low-risk `research.execute` capability throughout.

**Why it is safe.** The deterministic-infra ↔ AI-execution boundary (Ch.02 §3) is enforced by the *absence* of granted capabilities: an employee can `plan` and produce a structured proposal, but `authorize()` denies every side-effecting tool because no principal holds the capability yet (Ch.14 §Edge cases — a principal with no roles can do nothing). Drafts are inert artifacts. Research AI is unchanged — its existing, already-live behaviour simply now runs through the general runtime.

**Flag(s).** `runtime.enabled` (the FSM/scheduler), `runtime.draft_mode` (asserts: no `act` phase reaches a side-effect regardless of policy — belt-and-braces over the empty capability set).

**Dependencies.** Phase 0 (verbs + `authorize()`), Phase 1 (run cost/latency are *observed from the first run* — P9), Phase 4 (employees have recall before they plan).

**Backout.** Flip `runtime.enabled` off: scheduling stops, no runs trigger; Research AI reverts to its standalone executor path (which still exists, untouched). Run tables remain (additive). No data loss — runs are an append-only record.

**Success criteria (Ch.15).** Every run records `cost_usd` / tokens / latency in `ai_employee_runs`; **AI cost/employee/day** is a live tile (the most-watched signal, P9) and stays within each employee's budget; **run error rate < 1%**; zero side-effects emitted by any `foundation` employee (asserted: no `ai.tool_called` with a granted danger capability); Research AI's existing KPIs hold steady through the fold-in. The roster ceiling (~$52/day, Ch.08) is visible as one tile.

---

### Phase 6 — Approvals & oversight (drafts can now route to humans)

**What ships.** The human-in-the-loop infrastructure that turns the SDK default (`requires_approval=true`) into a system (Ch.13):
- `hq_approvals` and `hq_approval_policies` (Ch.03 §03.7–03.8) — the inbox and the policy engine that routes `auto` | `require_human` | `dual_control` by employee × capability × risk tier × monetary threshold.
- The **Approvals Inbox** as a primary Mission Control zone — newest-first, one-click decide, with each row capturing *exactly what will execute* (payload) and *what it means* (projected effect).
- SLA timers and escalation so no approval stalls silently.

**Why it is safe.** Approvals are *plumbing for a decision that still cannot fire*: at the end of Phase 6, employees are still `foundation` (no `can_execute`), so a draft can now *route to a human*, but approving it grants nothing the employee could act on yet. Defaults are conservative — *everything consequential → `require_human`* — and loosen only on measured trust (Ch.13 §Policy engine). The most dangerous capability (`billing.refund`) is wired as `dual_control` from the start (Ch.14 §Dual-control).

**Flag(s).** `approvals.enabled` (the inbox + policy engine).

**Dependencies.** Phase 0 (the `authorize()` `needs_approval` decision branch and the `approval.*` verbs), Phase 3 (approvals broadcast live to the inbox), Phase 5 (there are drafts to route).

**Backout.** Flip `approvals.enabled` off: the policy engine stops creating `hq_approvals` rows; the inbox hides. Because no employee can execute yet, nothing is stranded. Pending approval rows persist (append-only history); they simply expire per their `expires_at`.

**Success criteria (Ch.15).** **Approval latency** (`approval.granted.ts − approval.requested.ts`) p95 < 30 min in business hours; **dual-control completion** works (an action cannot execute with one approver; requires two distinct humans; no AI in the approver set — Ch.14 tests); every approval decision lands in ♻️ `admin_activity_log` with `decided_by`. The Golden-Rule check: Mission Control now *asks you* for decisions.

---

### Phase 7 — Graduated execution (flip employees to `can_execute`, ONE capability at a time)

**What ships.** The payoff, made safe by Phases 4–6: AI employees begin to *act* — but only by deliberate, per-employee, per-capability grants, **lowest-risk first**:
- For one chosen employee, set `permissions.can_execute` and grant a single, low-blast-radius capability via `hq_principal_roles` (e.g. an internal-only `ticket.triage` or a `doc.draft`-to-`doc.publish` path), under an explicit approval policy.
- Watch it against evals, cost, and audit; only then grant the next capability or the next employee.
- **Dangerous capabilities never graduate to AI execution:** `billing.refund` stays `dual_control` and **never AI-executed**; the four highest-risk powers (`billing.refund`, `content.publish`, `email.send`, `reply.send`) remain approval-gated (Ch.08 roster ceiling).

**Why it is safe.** This is P4/P5 mechanised. Each grant is additive, audited (`permission.role_granted` on the spine), and **revertible by revoking the role or flipping the employee's flag** — the cache busts immediately for a danger capability (Ch.14 §Failure handling). The blast radius of any single grant is one capability for one employee, gated by an approval policy, watched by a live cost-and-error tile. We extend Research AI's proven pattern to one neighbour at a time (e.g. Documentation AI, then Support-drafts), never a block of employees.

**Flag(s).** A per-employee `execute.<employee_slug>` flag *and* the per-employee `permissions.can_execute` — both must be true for any execution (Ch.07 §Cost, budget, safety: live only when `can_execute` is set, an approval policy exists, *and* the flag is enabled).

**Dependencies.** Phase 5 (the runtime), Phase 6 (the approval gate the execution routes through), Phase 1 (the evals/cost/audit being watched).

**Backout.** Revoke the capability grant or flip `execute.<slug>` off → the employee reverts to draft-only instantly; in-flight runs park at the gate. No data loss; the audit trail of what it did while live is preserved (the safety record).

**Success criteria (Ch.15).** The graduated employee's **run error rate** and **cost/day** stay within budget; its eval pass-rate holds; **zero unauthorised side-effects** (no `ai.tool_called` without a held capability — the catalogue-coverage and least-privilege tests, Ch.14); an **`AI principal attempting `permission.*`** would be a `critical` alert and must never fire. Each capability is judged green before the next is granted — *reliability over speed* (§3.5).

---

### Phase 8 — Steady state & graduation (the named scaling exits arm; the Bible becomes the reference)

**What ships.** Operationalisation, not new surface:
- The **named graduation triggers** (Ch.17) are *armed as monitors* — `pgmq` when retryable-queue depth strains plain tables; a broker when sustained event rate exceeds partitioned-Postgres comfort; Typesense/Meilisearch behind `searchHq()` at the search-latency ceiling; a dedicated vector store only if HNSW recall latency forces it. None adopted now; each watched, each behind a service boundary so the backend swaps without touching call sites.
- **Continuous eval** of the workforce; the optional hash-chained audit + scheduled `verifyAuditChain` on the SOC2 path (🔬); cost forecasting closing the P9 loop (*measure → bound → predict*).
- The Bible becomes the **standing reference**: every new feature references the relevant chapter before a line of production code (Ch.00 Authority).

**Why it is safe.** Nothing here changes the running system on adoption — graduations are *triggered by measured thresholds*, never speculative (P6). Each exit sits behind an existing service abstraction (the bus, the queue, search, vectors) so it is a transport swap, not a rewrite.

**Flag(s).** Per-graduation flags armed but off (e.g. `queue.pgmq_enabled`, `search.external_enabled`); each flips only when its Ch.17 trigger trips.

**Dependencies.** All prior phases (steady state presupposes the OS is running and observed).

**Backout.** Each graduation is itself flag-gated and reversible behind its service boundary — revert to the Postgres-native implementation, which remains the default until a trigger demands otherwise.

**Success criteria (Ch.15).** All golden signals within SLO at steady state; **error budgets** not chronically burning; cost forecast tracks actuals; no graduation activated without its measured trigger. The Golden-Rule check, now continuous: the OS runs the company, and every number is a doorway.

---

## 6. Feature-flag mechanics

Flags are the rollout's control surface. The mechanics (♻️ `hq_settings` already exists and already backs feature flags):

- **Where.** Every flag is a server-side row in `hq_settings` — service-role-only config (`RLS:hq`). No flag is client-readable; the browser never decides its own feature state.
- **Default.** Every OS flag defaults **off**. A migration that *creates* a flag does not *activate* it — shipping and activating are separate acts (§3.2).
- **Granularity.** Flags are per-phase and, in Phase 7, per-employee (`execute.<slug>`). A phase is independently revertible because its flag(s) are independent of every other phase's.
- **Preview vs production.** Flags are evaluated per environment, so a phase can be **on in preview, off in production** — the preview-first path (P7). A phase is exercised, both on and off, in preview before its production flip is even proposed.
- **Auditability.** Every flip emits `system.flag_changed` (Ch.04) and lands in ♻️ `admin_activity_log` with the actor — *who turned what on, when*, reconstructable forever. The rollout audits itself on the same spine it installs.
- **Kill-switch latency.** A flip takes effect within the config cache TTL (seconds); a *danger*-adjacent flag (e.g. `execute.<slug>`) busts immediately, mirroring the permission-cache discipline (Ch.14 §Failure handling). The only acceptable failure mode is one you can disable in seconds (P7).

🔬 **Open question for Ch.20:** whether flags remain simple booleans in `hq_settings` or graduate to a small typed flag schema (percentage rollouts, per-actor targeting). Booleans suffice for this plan; the seam is noted.

---

## 7. Backout & rollback philosophy

The rollback model is a strict hierarchy — **cheapest, safest action first:**

1. **Flip the flag (first resort, always).** Every phase is revertible by setting its `hq_settings` flag off. This is instant, needs no deploy, and is the *only* rollback most phases ever need. Behaviour reverts to the prior phase; the new tables sit inert.
2. **Revoke a grant (Phase 7).** For execution, revoking a capability or per-employee flag returns the employee to draft-only immediately — finer-grained than a phase flag, same instant effect.
3. **Drop + replay a projection (read-models).** A corrupted read-model (timeline, metrics, search) is *recomputed from the spine*, never hand-edited (Ch.04 §Replay; Ch.15 §Failure handling). The spine is the recovery anchor.
4. **Re-deploy the prior build (last resort).** Only if a flag cannot isolate the fault. Even then, the additive migrations stay — we revert *code*, not *schema*.

The invariants underneath all four:

- **Migrations are additive, forward-only, and non-destructive (Ch.03).** Backout is *never* a `down` migration that drops a table or a column. We do not drop data — ever (P2). A new table that is unwanted is simply *ignored* (read-models are rebuildable; the spine is append-only).
- **The spine and the audit log are append-only.** No update/delete grant is exposed even to service-role except partition retention (Ch.04 §Security). History cannot be rewritten by a rollback.
- **The audit log is the safety record.** When a phase is reverted — especially an execution grant in Phase 7 — the full record of what happened while it was live is preserved in ♻️ `admin_activity_log` (and the spine). We can always answer *what did the AI do before we turned it off?* This is what makes flipping a switch a safe decision rather than a leap.

A backout is therefore boring by design: flip a flag, watch the signal recover, and the inert tables wait for the fix. That boredom is the point.

---

## 8. Risk register

Top risks, by phase, each with its mitigation. The pattern throughout: **the architecture pre-empts the risk** rather than relying on operator vigilance.

| # | Risk | Phase(s) | Mitigation |
|---|---|---|---|
| R1 | A migration **locks a hot table** during deploy | 0, 4 | Additive `create` / `add column` only — no rewrites, no `ALTER` of a hot column's type; `embedding` is a *nullable add* that backfills lazily off the write path (Ch.03 §Failure handling). Migrations run in the established gated pipeline. |
| R2 | The new `authorize()` chokepoint **regresses access** (locks someone out) | 0 | Seeded `super_admin` holds *all* capabilities; back-compat test asserts every super-admin email resolves to the full set (Ch.14). `authz.enforce` flag falls back to the binary gate instantly. Self-revocation lockout is structurally prevented (last `super_admin` cannot revoke itself, Ch.14 §Edge cases). |
| R3 | The spine becomes a **write-path bottleneck** | 0 | One indexed insert appended to an existing transaction — negligible overhead (Ch.04 §Performance). Partitioning + bounded reads keep it O(1)-ish; consumer lag is the canary that warns *before* users notice (Ch.15). |
| R4 | **`hq_events` is accidentally exposed** to client subscriptions | 3 | Hard-no, ADR-settled: server-authorised Broadcast only; `hq_events` stays `RLS:hq` zero-policy; the broadcaster is the *only* spine reader for liveness, server-side under service-role (Ch.06 §Why not `postgres_changes`, Ch.16). |
| R5 | An AI employee **executes a capability prematurely** | 5, 7 | Defence in depth: `foundation`/`locked()` means no capability is held; `authorize()` denies a wish, not a grant (Ch.14 §Security — injection cannot escalate); `runtime.draft_mode` asserts no `act` reaches a side-effect; execution needs `can_execute` *and* a flag *and* a policy, all three (Ch.07). Granted one capability at a time, watched live. |
| R6 | **Cost runaway** (LLM spend scales with the business) | 5, 7, 8 | Cost is a first-class metric (P9): every run records `cost_usd`; per-employee budgets with **circuit breakers** auto-suspend on overrun (Ch.07); `ai_cost_per_employee_day` is the most-watched tile; an SLO breach catches drift before a month-end bill (Ch.15 §Performance). Roster ceiling (~$52/day) is a single tile. |
| R7 | A **dangerous action** (refund, suspend, publish) fires without sufficient control | 6, 7 | `danger` capabilities are `dual_control` (two distinct humans, no AI approver); `billing.refund` is **never AI-executed**; conservative defaults route everything consequential to a human until trust is measured (Ch.13/14). |
| R8 | A **poison event** blocks a consumer / the rollout stalls | 1+ | After N attempts an event moves to `dead_events`, the offset advances, and `system.alert_raised` fires — one bad event never blocks the stream (Ch.04 §Failure handling); `dead_event_count > 0` is a standing `critical` alert (Ch.15). |
| R9 | **Cost/eval signals are unread** because observability lagged the feature | all | Sequencing pre-empts this: Phase 1 (observability) ships *before* any consequential phase, so every later phase is measurable from minute one (§3.3). *You cannot roll out what you cannot see.* |
| R10 | **Backfill double-counts** or corrupts the timeline | 2 | Idempotent backfill keyed by `(source, source_id)`; oracle test asserts re-running does not duplicate; originals stay authoritative for their domains (Ch.04 §Backfill). |

---

## 9. Roles & sign-off

Who approves each phase gate. The principle: **the CEO gates the execution-enabling phases; engineering gates the additive-infrastructure phases — but every phase still meets the per-phase contract (§3).**

| Phase | Approver to *activate* in production | Rationale |
|---|---|---|
| **The gate (§4)** | **CEO** (direction) + **CTO/Eng lead** (stability rubric) | Blueprint approval + RC-stable judgement are explicitly CEO-and-engineering calls (Ch.00). |
| 0 Foundations | Eng lead | Additive infra, no behaviour change; reviewed like any gated migration (Directive 007 discipline). |
| 1 Observability | Eng lead | Read-only projections; safety-enabling, not behaviour-changing. |
| 2 Read-only projections | Eng lead | Read-only; reviewed for performance budgets and backfill correctness. |
| 3 Real-time | Eng lead (+ **security review** of the broadcast boundary) | The `hq_events`-exposure risk (R4) warrants an explicit security sign-off. |
| 4 Memory | Eng lead | Additive; embedding backfill reviewed for write-path impact. |
| 5 Runtime (draft-only) | Eng lead (+ **CEO informed**) | No execution yet, but the workforce becoming *real* is a CEO-visible milestone. |
| 6 Approvals | Eng lead (+ CEO sets the **default policy** conservatism — ARCHITECTURE App. D Q2) | The CEO owns "how conservative initially." |
| 7 Graduated execution | **CEO gates each employee/capability grant** | This is where AI *acts*. P4/P5 make autonomy a granted, CEO-approved decision — *which employee first* and *which capability next* (ARCHITECTURE App. D Q1). |
| 8 Steady state | Eng lead; **CEO informed of graduations** | Graduations are evidence-triggered (Ch.17); the CEO is informed, engineering executes. |

**Standing rule:** any phase whose success criteria are not green does not advance — the approver *holds*, and the reason is recorded. Reliability over speed is enforced at the sign-off, not just in spirit.

🔬 **Open questions for Ch.20** (the CEO decisions this plan surfaces, echoing ARCHITECTURE App. D): which employee goes live first in Phase 7; how conservative the Phase 6 approval defaults are; whether human sub-roles (Auditor/Viewer) arrive in Phase 0/6 or stay binary while only the AIs are scoped; whether hash-chained audit is enabled now or deferred; the exact gate soak-window rubric (§4).

---

## 10. Timeline shape

This plan deliberately states **relative sequencing and dependencies, not calendar dates.** The schedule is evidence-gated: a phase begins when its dependencies are green and its predecessor's success criteria hold — not on a date.

The dependency spine (each arrow = "must precede"):

```
  GATE (PR #171 prod & stable)
     │
     ▼
  Phase 0  Foundations (spine · verbs · authorize() seeded · flags)
     │
     ▼
  Phase 1  Observability & audit ───────────────┐ (everything below is observed from here)
     │                                            │
     ▼                                            │
  Phase 2  Read-only projections (Timeline · Search · Mission Control)
     │                                            │
     ▼                                            │
  Phase 3  Real-time (broadcaster · islands · presence) — Mission Control live
     │                                            │
     ▼                                            │
  Phase 4  Memory graph (read/write knowledge, not action)
     │                                            │
     ▼                                            │
  Phase 5  Runtime DRAFT-ONLY (12 onboarded locked() · Research AI folds in)
     │                                            │
     ▼                                            │
  Phase 6  Approvals & oversight (drafts route to humans)
     │                                            │
     ▼                                            │
  Phase 7  Graduated execution (one capability at a time, CEO-gated) ◀── watched by Phase 1
     │
     ▼
  Phase 8  Steady state & graduation (scaling exits arm on measured triggers)
```

**Sequencing logic, restated:**

- **The spine is first** because every other capability is a consumer or projection of it (ARCHITECTURE §2, "the single most important architectural decision").
- **Observability is second** because it makes every later phase measurable from minute one (§3.3).
- **The safety rails precede the cars:** the control plane (`authorize()` in Phase 0, approvals in Phase 6) is in place *before* AI execution in Phase 7 (ARCHITECTURE §19, Phase 4 rationale).
- **Knowledge precedes action:** memory (Phase 4) and draft-only runtime (Phase 5) come before any execution (Phase 7).
- **Execution is the narrowest, most-gated, last behavioural phase** — and even then it advances one capability at a time.

Phases may *overlap in preparation* (a later phase's migration can be written while an earlier phase soaks), but no phase **activates** in production until its predecessors' criteria are green. The one-million Golden Rule applies to the rollout itself: this sequence — spine-first, observable-before-active, capability-by-capability — is the *only* order in which an OS can be installed under a live, company-operating product without ever taking it down. That is why we build it this way.
