# Chapter 20 — Glossary, Conventions & Decision Log

> The reference volume. Where every other chapter *uses* the shared vocabulary, this chapter *defines* it; where they *make* decisions, this chapter *records* them; where they *defer* a decision, this chapter *collects* it so the people who must choose can choose in one place. It is the index of the Bible's mind.

This chapter has five substantive parts:

- **§20.1 Glossary** — the shared vocabulary, defined once.
- **§20.2 Conventions** — the naming, notation, and authoring rules every chapter obeys.
- **§20.3 Decision Log (ADRs)** — the load-bearing decisions already made, with their rationale.
- **§20.4 Open Questions** — the 🔬 decisions still owed, organised by who must make them. **This is the CEO's decision surface.**
- **§20.6 Engineering Lessons** — discoveries *proven by building*, recorded so they are learned once and never lost.

---

## 20.1 Glossary

The terms that recur across the Bible. Each entry is tight on purpose; the owning chapter holds the full treatment.

| Term | Definition |
|---|---|
| **ADR** | *Architecture Decision Record* — context → decision → consequences, logged in §20.3. Canon changes (Ch.03/04/14) require one. |
| **`admin_activity_log`** | The immutable, append-only human-readable audit log (♻️ existing; Ch.15). No update/delete path is exposed — immutable *by construction*. |
| **`ai_employee_runs`** | The table holding one row per employee *run* — the unit of AI work, carrying the lifecycle FSM `state` (Ch.07). |
| **Approval** | A paused AI side-effect awaiting a human decision; a row in `hq_approvals` (Ch.13). Carries a `projected_effect` so the human decides on a plain-language preview. |
| **Approval inbox** | The operator's live queue of pending approvals — a *projection* over `hq_approvals`, not a second store (Ch.13). |
| **`authorize()`** | The single permission chokepoint: `authorize(principal, capability, ctx) → allow | deny | needs_approval`. Fail-closed. Every side-effect passes through it (Ch.14). |
| **Budget governor** | The per-run and per-day spend ceiling with a circuit-breaker; on exhaustion an employee is *suspended*, not crashed (Ch.07/17). |
| **Capability** | A fine-grained permission verb, `domain.action` (e.g. `billing.refund`). Held by principals via roles. The universal unit of authority (Ch.14). |
| **CANON** | The three highest-stakes chapters — Ch.03 (Data Model), Ch.04 (Event Taxonomy), Ch.14 (Permissions). A change here ripples everywhere and requires an ADR + a consistency sweep. |
| **Causation ID** | The id of the event that *directly caused* this one. With **correlation id**, makes every causal chain reconstructable (Ch.04). |
| **Correlation ID** | A shared id threading all events of one logical flow (e.g. a dunning cycle) end-to-end (Ch.04/15). |
| **Dual-control** | A `danger` capability requires a *second, distinct human* to approve execution. The two principals must differ; an AI is never one of them (Ch.13/14). |
| **Edge (memory)** | A *typed, scored, machine-generated* link in the memory graph (`hq_memory_edges`) — recall-bearing. Distinct from a human **relationship** annotation (Ch.12). |
| **Event spine** | `hq_events` — the one append-only event log; `bigint` identity PK as **total order**, monthly-partitioned, `RLS:hq`. The single source of "what happened" (Ch.04). |
| **Foundation employee** | An AI employee shipped read/draft-only (`foundation: true`, capabilities `locked()`); it can *propose* but not *execute* until granted `can_execute` (Ch.07/08). |
| **Fusion** | Hybrid recall combining full-text (FTS), vector similarity, and graph proximity with tunable weights (Ch.12). |
| **The gate** | Colloquial name for `authorize()` and the GATE phase of the run loop where a tool call spends its capability (Ch.07/14). |
| **Golden Rule** | *"If CrewFlow had one million companies, would we still build it this way? If no — redesign it."* Answered explicitly in every Performance/Scalability section. |
| **Golden signals** | The handful of health metrics (latency, errors, saturation, traffic) per system that page a human (Ch.15). |
| **Graduation trigger** | A *named, observable threshold* at which a deliberately-simple choice (Postgres queue, cron drainer) upgrades to a heavier one — scaling as a pre-decided event, never a panic (Ch.17). |
| **High-water mark** | Per-operator `last_seen_event` into the spine's total order; powers "N new since you looked" by a single id comparison (Ch.09). |
| **`HqActor`** | The authenticated super-admin human `{ id, email }` (♻️ `server/auth/`). A *principal* of type `human` (Ch.14). |
| **`hq_*` / `admin_*` / `ai_employee_*`** | The HQ (super-admin plane) table prefixes. Tenant tables are unprefixed (Ch.03). |
| **Idempotent consumer** | A spine projector that tracks its **offset** and can re-process safely — replay and redelivery never double-apply (Ch.04). |
| **Island model** | The Realtime design: a page is independent live "islands", each subscribing to a shared, **server-authorised** channel; no island can block or break another (Ch.06/09). |
| **`locked([...])`** | The SDK helper marking an employee's capabilities read/draft-only by default — least privilege as the starting posture (Ch.07/08). |
| **Mission Control** | The OS homepage (`/admin`) — live, connected, composed by a tile-provider registry; answers *what happened / is happening / will happen* without navigation (Ch.09). |
| **Outbox** | The *transactional outbox* — events are written in the same transaction as the state change, then drained, so an event is never lost nor emitted for an uncommitted change (Ch.04). |
| **Presence** | Ephemeral "who is online right now", held in Realtime memory, **not** on the spine — liveness, not truth (Ch.06). |
| **Principal** | A holder of roles/capabilities: a human (`HqActor.id`) or an AI employee (slug). Uniform to the gate (Ch.14). |
| **Projected effect** | The plain-language preview of exactly what an approval will do if granted (e.g. "refund £240 to Acme") — the human decides on this, not on raw payload (Ch.13). |
| **Projection / read-model** | A view *derived* from the spine (timeline, search index, metrics, Mission Control tiles). Always rebuildable by **replay**; never a hand-maintained second truth (Ch.04/11). |
| **Replay** | Reconstructing any projection by re-reading the spine from offset zero — the property that makes read-models disposable and trustworthy (Ch.04). |
| **`requireCapability()`** | The throwing server-action guard, the fine-grained successor to `requireHq()` (Ch.14). |
| **`requireHq()` / `requireHqPage()`** | The existing binary super-admin guards (♻️ `server/auth/hq.ts`) — the entry/page gate that the capability check layers *inside* (Ch.14). |
| **RLS:hq / RLS:tenant / RLS:public** | The three RLS postures: *hq* = RLS on with **zero policies** (service-role only, the dominant HQ posture); *tenant* = org-scoped via `current_org_ids()`; *public* = rare read-only reference (Ch.03). |
| **Role** | A named bundle of capabilities, typed `human` or `ai`, granted to principals (Ch.14). |
| **Run loop** | The employee execution cycle: **perceive → plan → gate → act → record → reflect** (Ch.07). |
| **Server-authorised broadcast** | The Realtime transport: a service-role consumer reads the spine, *authorises* for the audience, *shapes* a safe delta, and broadcasts it. Clients subscribe but **cannot publish** (Ch.06). |
| **Tile / tile-provider registry** | A Mission Control unit (`MissionControlTile`) declaring its capability, server loader, and live channel; the page renders the registry filtered by the operator's capabilities — systems appear by **registration, not surgery** (Ch.09). |
| **Tool / tool registry** | A typed AI capability (`ToolDef`) binding a `requiredCapability` and `riskTier`; the runtime can only act through registered tools (Ch.07). |
| **Verb** | An event name, `domain.action`, past-tense fact (e.g. `invoice.payment_failed`). The canonical **verb registry** (Ch.04) is the single source; the `Verb` TS union enforces it at compile time. |

---

## 20.2 Conventions

The authoring and engineering rules every chapter obeys. (The mandatory chapter templates live in [Ch.00](00-INDEX.md); this section is the rest.)

**Naming.**
- HQ tables are prefixed `hq_`, `admin_`, or `ai_employee_`; tenant tables are unprefixed; new event-sourced tables use `hq_`.
- **Verbs** (event names) and **capabilities** are both `domain.action`, snake-case within a segment: `invoice.payment_failed`, `billing.refund`. Verbs are **past-tense facts**; capabilities are **present-tense powers**. The same `domain.action` string is never both an event and a capability by accident — context (the registry vs the catalogue) disambiguates, and the type system keeps them in separate unions (`Verb` vs `CapabilityKey`).
- One concept, one name, everywhere. A rename is a breaking change handled with a migration + an ADR.

**RLS notation.** Every table declares exactly one of `RLS:hq` · `RLS:tenant` · `RLS:public` (see glossary). The default for the HQ plane is `RLS:hq`.

**Status legend.** ✅ drafted · ⏳ planned · 🔬 needs a decision (collected in §20.4) · ♻️ reuses an existing asset (named inline).

**Reuse callouts (♻️).** Where a design extends something that already exists, it is marked ♻️ with the real file/table, so a reviewer sees we are *extending, not reinventing*. The Bible is honest about what is greenfield and what is grounded.

**Code is illustrative.** Every SQL/TypeScript block communicates *intent and shape*. It is **not** the production migration or source — those are produced during implementation, reviewed, typechecked, built, and gated exactly as Directive 007 shipped. A reader must never copy a Bible snippet into production unread.

**Prose.** British spelling throughout (behaviour, authorise, optimise, defence). Plain, confident, senior-engineer voice. No filler. Diagrams in ASCII so they live in git.

**The one-source rule (P1).** Every fact exists once and is derived everywhere else. If two chapters seem to own the same fact, one of them is wrong — raise it as a consistency issue, do not fork the vocabulary.

**The one-million test.** Every Performance and Scalability section answers the Golden Rule explicitly, by name.

**Change control.** Material changes are edits to the owning chapter + a one-line ADR appended to §20.3. The three CANON chapters (03/04/14) additionally require a consistency sweep of dependent chapters. *One source, forever — applied to the specification itself.*

---

## 20.3 Decision Log (ADRs)

The load-bearing decisions, recorded so a future engineer finds the *why* in one place. Format: **context → decision → consequence.**

| # | Decision | Context → Decision → Consequence | Chapters |
|---|---|---|---|
| **ADR-001** | **The event spine is the single source of truth.** | A SaaS that must be *observable everywhere* cannot scatter truth across tables. → One append-only `hq_events` log; `bigint` identity PK as **total order**; monthly partitions; transactional **outbox** producer; **offset-based idempotent** consumers. → Every read-model is a disposable projection rebuildable by replay; "what happened" has one answer. | 03, 04 |
| **ADR-002** | **The canonical verb registry is a generated TS union.** | Event names drifting across producers/consumers is the classic event-system rot. → One registry (Ch.04); the `Verb` type is generated from it; an unregistered verb *won't compile*. → "One source of event names", enforced by the compiler, exactly as 007 enforced design tokens in ESLint. | 04 |
| **ADR-003** | **Realtime uses server-authorised Broadcast, not `postgres_changes`.** | `postgres_changes` would require SELECT policies on `hq_events` — making the company's most sensitive table JWT-readable, violating `RLS:hq` and Ch.16. → A service-role consumer reads the spine, authorises for the audience, shapes a safe delta, and broadcasts; clients subscribe but never publish. → The transport is secure by construction; this is **not** reopened per-page. | 06, 16 |
| **ADR-004** | **One `authorize()` chokepoint; uniform principals; additive seed.** | Two authority paths (one for humans, one for AIs) would double the surface to reason about. → A single `authorize(principal, capability, ctx)`; humans and AIs are both principals; capability→role→principal; **fail-closed**; seed a `super_admin` role with *all* capabilities granted to every allowlisted email. → Day-one behaviour is identical to today's binary gate (zero regression); finer roles arrive additively. | 14 |
| **ADR-005** | **`RLS:hq` (RLS on, zero policies, service-role only) is the dominant HQ posture.** | The HQ plane is super-admin-only; per-row tenant policies don't apply and a JWT-readable HQ table is a liability. → HQ tables enable RLS with **no** policies; all access flows through server code holding the service role. → The browser never reads HQ data directly; the trust boundary is the service layer. | 03, 16 |
| **ADR-006** | **AI employees are config, not code.** | Twelve bespoke agents would be twelve maintenance burdens. → One SDK (`defineEmployee()`/`AIEmployeeDefinition`); each employee is a configuration over six dimensions; `locked()`/`foundation:true` make read/draft-only the default. → New employees are onboarded by configuration; least privilege is the starting posture. | 07, 08 |
| **ADR-007** | **Approvals are a policy engine over the spine; dual-control needs two humans.** | Dangerous AI actions must be gated without bespoke per-action code. → A policy routes each gated action to `auto` / `require_human` / `dual_control`; the inbox is a projection; the decision is a CAS single-write; expiry changes nothing; danger ⇒ two *distinct* humans, AI never an approver. → Human oversight is uniform, live, and auditable; the most dangerous powers cannot be exercised by one actor. | 13, 14 |
| **ADR-008** | **`hq_metric_counters` (§03.15b) catalogued as canon.** | Mission Control and KPIs need O(1) live counters; recomputing from the spine on the hot path doesn't scale. → A tiny counter store the rollup *reconciles against*; `hq_metrics` stays the authoritative time-series; drift self-heals on recompute. → A canon addition to Ch.03 made during authoring (this Bible). | 03, 15 |
| **ADR-009** | **`hq_operator_dashboard` (§03.15c) catalogued as canon.** | Mission Control needs per-operator layout + an unread high-water mark, and no chapter may invent a table outside Ch.03. → A single small `RLS:hq` table — the *only* table Mission Control owns. → A canon addition to Ch.03 made during authoring; its table-vs-`hq_settings` shape remains an open question (OQ-8). | 03, 09 |
| **ADR-010** | **Mission Control is composed by a tile-provider registry.** | A hand-wired homepage rots as systems are added. → Every system registers a `MissionControlTile` (capability + loader + channel); the page renders the registry filtered by capability. → "Everything connects" by construction; the home grows by registration, not surgery. | 09 |
| **ADR-011** | **Scaling via named graduation triggers.** | Premature distributed infrastructure is waste; unplanned scaling is a panic. → Start deliberately simple (Postgres queue, cron drainer, monthly partitions, single region) and name the *exact observable threshold* at which each choice graduates. → Scaling is pre-decided and monitored; the contracts (`emitEvent`/`drain`/`getTrace`) don't change when the host does. | 17 |
| **ADR-012** | **Rollout is eight additive, flagged, observable-before-active, CEO-gated phases.** | Layering an AI OS onto a live product risks destabilising it. → Eight phases (canon → observability → read-only projections → realtime → memory → draft-only AI → approvals → graduated execution); flags in `hq_settings` default off; the RC (PR #171) ships and stabilises *first*; execution-enabling phases are CEO-gated, one capability at a time. → Every phase is independently revertible by a flag flip; nothing big-bang. | 19 |
| **ADR-013** | **Memory is episodic/semantic/procedural with pgvector + typed scored edges.** | An AI workforce that cannot *remember* repeats work and mistakes. → Three memory kinds; `pgvector(1536)` HNSW for similarity; typed, scored `hq_memory_edges` for graph recall; reflection distils *facts with provenance*, never raw PII/secrets. → Recall is hybrid and tunable; the graph is machine-maintained while human annotations stay a separate, unscored layer. | 12 |
| **ADR-014** | **The audit log is immutable by construction; hash-chaining is an optional seam.** | Compliance needs a tamper-resistant record without over-building on day one. → `admin_activity_log` is append-only with no update/delete grant exposed (immutable by construction); a `prev_hash`/`row_hash` chain + scheduled `verifyAuditChain` is *specified* but not necessarily *enabled*. → Strong evidence today; tamper-*evidence* is one cron away on the SOC2 path (OQ-1). | 15 |
| **ADR-015** | **Production-equivalent verification is mandatory; the live CI-Postgres harness is its proof surface.** | A mocked unit tier structurally cannot prove what Postgres *does* — RLS enforcement, triggers, constraints, a migration's ability to bootstrap from zero (OQ-16, *"the single most important gap"*). → CI provisions a real Postgres (Supabase CLI local stack) and runs the integration/RLS tier on **every** PR; **every** feature touching security, auth, multi-tenancy, the database, AI infrastructure, billing, payroll, or customer data must carry a **live** integration test — a mock alone is no longer sufficient *(CEO Directive, post-OQ-16)*. → The irreversible-property gates (2, 5, 8) can finally *block* a bad merge, not just decorate it; the binding discipline is **P11 — never assume; verify against production-equivalent infrastructure**. The harness's first live runs immediately surfaced two real defects (§20.6 L-1, L-2), proving the principle on day one. | 18, 01 |
| **ADR-016** | **The Bible is a living knowledge base; every operational lesson is recorded in §20.6.** | A lesson learned once and not written down is paid for again; OQ-16's two findings proved how much a single fresh-eyes run surfaces. → From this point, every engineering lesson discovered in **production, CI, QA, customer feedback, security testing, or a postmortem** is appended to [§20.6](#206-engineering-lessons-the-living-knowledge-base) in the *same* change that fixes it, structured as discovery → impact → fix → lesson, and — wherever possible — hardened so the failure class becomes uncompilable, CI-gated, or principle-bound *(CEO Directive, post-OQ-16)*. → The Bible stops being a point-in-time design and becomes institutional memory; each mistake costs once. Enforced by [Ch.00 §Change control](00-INDEX.md) rule 6. | 20, 00 |

---

## 20.4 Open Questions (the 🔬 log)

Every 🔬 in the Bible, consolidated and de-duplicated. Each is **additive and reversible** — none blocks the blueprint's approval; they are calibrations and policy choices to settle during implementation. They are grouped by **who decides**.

### A. CEO decisions (the choices this plan deliberately surfaces upward)

| # | Question | Options & recommendation | Source |
|---|---|---|---|
| **OQ-1** | **Enable hash-chained audit now, or defer?** | Immutable-by-construction already holds; the chain adds tamper-*evidence* at a per-write hash cost + a verifier cron. **Recommend defer** until the SOC2 effort begins — the seam is specified (ADR-014). | 15, 16, 19 |
| **OQ-2** | **The gate "stable" rubric** before Phase 0. | Fix the soak length and the exact signals/thresholds (e.g. ≥7 days in prod, error rate < X, zero Sev-1, dashboards green). **Recommend** the CTO proposes concrete numbers for CEO sign-off. | 19 |
| **OQ-3** | **Which employee executes first** (Phase 7)? | Research AI already executes and is the natural proving ground; the next lowest-risk graduation is Support AI's *draft→send behind approval*. **Recommend** Support AI first, one capability, approval-gated. | 19 |
| **OQ-4** | **How conservative are Phase 6 approval defaults?** | Start with `require_human` on *every* AI side-effect, relax to `auto` only where evals prove safety. **Recommend** maximally conservative; loosen on evidence. | 19 |
| **OQ-5** | **When do human sub-roles arrive?** | Auditor/Viewer/billing-operator roles vs binary super-admin only. The model already supports them (pure data). **Recommend** stay binary until a second human persona genuinely exists. | 14, 19 |
| **OQ-6** | **Where does AI-originated email live?** | (a) extend the live `notification_email_queue` additively with nullable `run_id`/`approval_id`; (b) a parallel `hq_outbound_email` sharing the drainer. (a) honours one-source; (b) physically separates HQ/tenant mail. **Recommend (a).** Touches a live tenant table → CEO/lead call. | 05 |
| **OQ-7** | **Promote `q<T>()` to a shared `lib/hq/db.ts`?** | The typing shim is currently per-file. Promoting it puts the cast in one place repo-wide (the one-source ethos). **Recommend yes** — but it touches every service file, so it is a lead call. | 05 |

### B. Lead / implementation ADRs (settle at build time; record the choice)

| # | Question | Recommendation | Source |
|---|---|---|---|
| **OQ-8** | `hq_operator_dashboard` dedicated table vs a per-operator `hq_settings` row. | Dedicated table (already catalogued §03.15c) — keeps the hot `last_seen_event` write off the config store. | 09, 03 |
| **OQ-9** | Dual-control second approver: a `decided_by_2` column vs two spine `approval.granted` events. | Events suffice for the spine; add the column only if the inbox's *read* needs it. | 13 |
| **OQ-10** | Entity-slice `object OR target` read form: (a) planner-trusted `OR`, (b) explicit `UNION ALL … LIMIT` in the service, (c) generated `participants text[]` + GIN (a canon change adding a spine column + `hq_events_target_idx`). | (b) as the safe default; revisit (c) only if measurement demands. | 11 |
| **OQ-11** | Embedding model/provider and dimension (1536 vs smaller to halve the HNSW index). | Pin the model in `hq_settings`, record per-row provenance, decide the provider at implementation; keep 1536 unless a smaller dim proves sufficient. | 12 |
| **OQ-12** | Initial memory fusion weights (`w_fts/w_vec/w_graph`) + per-hop decay; hand-set vs learned. | Hand-set in `hq_settings`, instrument click-through, learn later behind the same flag. | 12 |
| **OQ-13** | Unify `hq_memory_relationships` (human, unscored) with `hq_memory_edges` (machine, typed, scored)? | Keep both; promote a human annotation to a typed edge only when it recurs with evidence. | 12 |
| **OQ-14** | Does `shapeDelta` reuse the timeline projection's row-shaping verbatim? | Yes — one shaping function, one source (P1). | 06, 11 |
| **OQ-15** | Re-derive `projected_effect` at decision time vs request time for volatile actions. | Edit re-renders from a fresh payload before granting; keep volatile actions short-`expires_at` so they lapse rather than execute stale. | 13 |
| **OQ-16** ✅ | **How CI provisions a real Postgres** — Supabase CLI local stack in the runner vs an ephemeral project per PR. | **✅ RESOLVED — Supabase CLI local stack in the runner.** Built and green on every PR via the `integration (real Postgres)` job ([PR #172](https://github.com/crewflow1/web/pull/172)): `supabase start` applies all migrations to a fresh volume, then the RLS/tenant-isolation tier runs as anon + tenant-JWT + service-role. Two real defects surfaced on its first live runs (§20.6 L-1, L-2). See [ADR-015](#203-decision-log-adrs). The PR's *merge* to `main` is held until the RC is in production (the standing gate, OQ §C below); move to ephemeral-per-PR only if parallelism later demands. | 18 |
| **OQ-17** | Search ranking-weight ownership, the trigram similarity threshold, and the searchable-event window. | Hand-set weights in `hq_settings`; bound the searchable window; calibrate by measurement. | 10 |
| **OQ-18** | Feature flags: simple booleans vs a typed schema (percentage rollouts, per-actor targeting). | Booleans in `hq_settings` suffice for this plan; the typed-schema seam is noted. | 19 |
| **OQ-19** | Secret rotation cadence + a per-secret owner; dual-key the service-role during rotation. | Define a written policy (e.g. quarterly + on-incident); the *mechanism* already exists, only the *policy* is missing. | 16 |
| **OQ-20** | A CI/lint guard rejecting a secret-shaped value behind `NEXT_PUBLIC_`. | Add it — cheap belt-and-braces on the bundle boundary. | 16 |

### C. Graduation-triggered (decided by *measurement*, not now — Ch.17)

These are not choices to make today; they are **named thresholds to calibrate** as load is observed. Listed so they are not forgotten.

- **OQ-21 — OpenTelemetry export.** An optional OTLP adapter for `hq_runs`/`hq_spans` to an external collector (Honeycomb/Tempo). The internal trace viewer is the day-one tool; OTel is the seam when trace-read p95/volume outgrows Postgres. *(15, 16, 17)*
- **OQ-22 — Dedicated secrets manager.** Graduate from Vercel env to Vault/Doppler/AWS SM behind the unchanged `createAdminClient()` contract, when scale/compliance demands. *(16)*
- **OQ-23 — Durable operator presence.** A small `hq_operator_presence` table for durable "last seen", deferred until a feature needs it (presence is ephemeral by default). *(06, 09)*
- **Realtime broadcaster host** — inline drainer → standing worker/Edge Function when sustained delivery p95 or concurrent-operator count crosses the Ch.17 trigger. *(06, 17)*
- **Materialised feeds** — introduce a replay-rebuildable materialised projection when a feed read pattern outgrows live-from-spine at the Ch.17 events/min or p95 threshold. *(11, 17)*

---

## 20.5 Using this chapter

- **A new engineer** looks up a term in §20.1 and reads the owning chapter for depth.
- **A reviewer** checks a change against §20.2 and confirms any canon edit added an ADR to §20.3.
- **The CEO** reads §20.4.A — the seven decisions this plan asks of you — and §20.3 for the reasoning behind what is already settled.
- **Anyone proposing a change** appends an ADR here and, if the change touches Ch.03/04/14, runs the consistency sweep. The Bible governs itself by its own one-source rule.

---

## 20.6 Engineering Lessons (the living knowledge base)

The decisions in §20.3 are made *before* code; the lessons here were *proven by operating* — and they are recorded permanently because the cheapest place to learn a lesson is once.

**Standing rule (CEO Directive, post-OQ-16) — the Bible is a living knowledge base.** Every engineering lesson discovered in **production, CI, QA, customer feedback, security testing, or a postmortem** is recorded in this section — as a permanent entry, in the *same* change that resolves it. A lesson is not "closed" when the bug is fixed; it is closed when the Bible has changed so the mistake becomes *impossible to repeat*: the failing class is made uncompilable, gated in CI, or written into the principle that governs it. This section therefore grows for the life of the system — it is the institutional memory that turns each incident into a one-time cost. The discipline is recorded as [ADR-016](#203-decision-log-adrs) and bound into governance by [Ch.00 §Change control](00-INDEX.md) (rule 6). **Every mistake should become impossible to repeat.**

Each entry states, at minimum: **what was discovered**, its **impact / blast radius**, the **fix**, and the **lesson** (the general rule that prevents recurrence). The first two entries — surfaced the day the [OQ-16 CI-Postgres harness](18-testing-strategy.md) first ran the real migrations against a real Postgres, the harness earning its keep on day one and the executable proof of **[P11 — verify against production-equivalent infrastructure](01-philosophy-and-principles.md)** — set the template.

**L-1 — A migration that no-ops on production can still be unable to *bootstrap* a fresh database.** The baseline schema migration grouped its constraints by table, emitting several `FOREIGN KEY`s before the `PRIMARY KEY`/`UNIQUE` they reference. Postgres requires a FK's target to already carry a PK/UNIQUE, so `supabase start` aborted on a clean volume (`SQLSTATE 42830`). The bug had never surfaced because production was migrated *incrementally* and the migration's `if not exists` guards make the whole file a no-op on an already-migrated database — so the ordering fault was invisible to every environment **except a fresh one**.

- **Impact:** disaster recovery, any new or staging environment, and local developer onboarding were all silently broken — none could rebuild the schema from zero.
- **Fix:** a schema-preserving two-pass reorder (all `PRIMARY KEY`/`UNIQUE` first, then all `FOREIGN KEY`s), produced by an auditable script asserting the statement *multiset* is unchanged — so the edit is provably a no-op on the already-migrated production database.
- **Lesson:** *a migration set is only as correct as its ability to rebuild the world from zero. Assert that in CI on a fresh volume; never infer it from a green production, whose `if-not-exists` guards hide the very faults a clean apply would catch.*

**L-2 — A test that mocks its dependencies hides its runtime requirements.** The harness's first live client call threw `Node.js 20 detected without native WebSocket support`: `supabase-js` eagerly constructs a `RealtimeClient`, which needs a global `WebSocket` — present natively only on Node ≥ 22. The mocked unit tier never builds a live client, so it never exercised that path and never revealed the requirement.

- **Fix:** the `integration` job runs on **Node 22**; the mocked unit jobs deliberately stay on Node 20.
- **Lesson:** *the runtime a mock lets you skip is exactly the runtime production depends on. A production-equivalent gate finds the missing dependency; a mock-shaped gate cannot — which is precisely why P11 makes the real gate mandatory for the highest-stakes domains.*

**L-3 — A dependency-audit step cannot be a hard CI gate without breaking determinism — or forcing unscheduled major upgrades.** While building the Security Validation gate (gate 5 of the mandatory pipeline), the obvious wiring — `npm audit --audit-level=high` as a *blocking* step — was found to be wrong on two counts. (1) `npm audit` reads the **live upstream advisory database**, so its verdict can flip from green to red with *zero change to our code* the moment a new CVE is published — exactly the non-determinism the [Ch.18 flake policy](18-testing-strategy.md) forbids ("a re-run that goes green is not a pass"). (2) The current production dependency tree already carried 8 high + 1 critical advisories whose only `fixAvailable` was a **semver-major** bump (Next.js, Sentry, react-email) — so a blocking audit would have either red-locked the gate permanently or forced an unscheduled mass-upgrade *during a launch freeze that explicitly forbids customer-facing dependency changes*.

- **Impact:** had the audit been wired as a blocker, "all six gates green" was unreachable and the harness PR un-mergeable — not because the app was insecure, but because the gate was mis-designed. The failure mode is seductive precisely because the step *looks* like diligence.
- **Fix:** split the security gate. The **blocking** half is the hermetic trust-boundary suite (`__tests__/security` — tenant isolation on the service-role path, cron Bearer gates, portal-upload safety, CSP + baseline headers, rate limits, role-escalation, no-client-secrets): deterministic, no network, fully within our control to keep green. `npm audit` runs as an **explicitly non-blocking advisory** (`continue-on-error`), surfaced on every run and triaged into deliberate, separately-scheduled upgrades.
- **Lesson:** *a CI gate must be deterministic and within the team's control to keep green. A check whose verdict is owned by an external, time-varying source — a live advisory feed, a third-party status — is **intelligence to act on, not a merge-blocker to be held hostage by**. Block on what you control (hermetic proofs of your own trust boundaries); surface what you don't (the upstream threat landscape) and schedule the response.*

**L-4 — On Supabase, `revoke … from public` does not lock a `SECURITY DEFINER` function: the platform's default privileges grant EXECUTE to `anon`/`authenticated` by name.** Building the [Event Spine](04-event-spine-and-taxonomy.md) (Module 1, PR1), the two service-role-only functions — `hq_emit_event` (the sole write entry point) and `hq_create_events_partition` — were hardened the textbook way: `revoke all on function … from public`, then `grant execute … to service_role`. The real-Postgres integration gate, calling each as a live **anon** JWT client, proved anon could *still* emit events and create partitions — a genuine privilege-escalation hole on the most sensitive table in the system. Root cause: Supabase ships `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE ON FUNCTIONS … TO anon, authenticated`, so every new function in schema `public` is granted to the JWT roles *individually, by name*. Revoking from `PUBLIC` removes only the pseudo-role grant; the direct `anon`/`authenticated` grants survive it.

- **Impact:** any "service-role-only" function written with the textbook revoke is in fact callable by an unauthenticated client. Tables are immune — RLS:hq denies the rows regardless of any grant — but a function has **no RLS**, so the grant *is* the gate; this is a latent escalation path under every future `SECURITY DEFINER`. It is invisible to a mocked unit test (which never constructs a JWT client) and to a `revoke-from-public`-only reading of the migration.
- **Fix:** revoke explicitly from `public, anon, authenticated` and grant only to `service_role` (the hardening the activity-log-retention function already used). Closed two ways: the integration tier proves anon's call *errors* against a live DB; the [security tier](16-security.md) pins the `from public, anon, authenticated` text and asserts the migration grants EXECUTE to no JWT role.
- **Lesson:** *on Supabase a function's privilege surface is not `PUBLIC` — it is `PUBLIC` **plus** the platform's standing default grants to `anon`/`authenticated`. Name those roles in the REVOKE, and prove the closure with a real JWT client; a mock cannot see a grant it never exercises.*

**L-5 — A partitioned parent's RLS is not inherited by its partitions, and only the parent is REST-exposed — so partition RLS is defence-in-depth, not the live gate.** The spine's `hq_events` is RANGE-partitioned monthly. The first integration test tried to prove "anon cannot read a partition directly" by selecting from a child (`public.hq_events_2026_06`) over PostgREST — and got `PGRST205: Could not find the table … in the schema cache`. In this Supabase/PostgREST version the child partitions are **not** exposed over REST; only the partitioned **parent** is routable. Separately and independently, a partitioned parent's `enable row level security` flag is **not** inherited: each partition must enable RLS in its own right.

- **Impact:** two opposite traps, both dangerous. (1) Believing the children are part of the API attack surface yields a test that can *never* pass (the relation isn't routable) and a false map of where the gate actually is. (2) Believing the parent's RLS covers the children leaves every partition unprotected against any future config that *does* expose a child, or any non-service direct (non-PostgREST) connection.
- **Fix:** prove denial at the **parent** — RLS:hq on `hq_events` denies every JWT client, asserted by the integration tier at the parent (the real API surface). Keep partition-level RLS as **defence-in-depth**: the partition-creator function runs `alter table … enable row level security` on every partition it makes (the initial runway, the DEFAULT catch-all, and each monthly partition), pinned from the migration text by the security tier. The integration test reads the parent, never a child.
- **Lesson:** *in a partitioned table RLS is per-relation and the REST surface is the parent only. Prove denial where the gate is (the parent), enable RLS on every partition as cheap insurance (the seam for a future exposure), and never assume a security flag is inherited — or test against a relation the API does not route.*

**L-6 — "No PII in payloads" is enforced by a lint on the TypeScript `emitEvent`; the trigger-emitted SQL producer is outside that lint's reach, so it needs its own proof.** Building the [Event Spine](04-event-spine-and-taxonomy.md) producers (Module 1, PR2), generalising `_record_activity()` to dual-write `hq_events` meant a *second* producer path beside the service-emitted `emitEvent()`: a SQL trigger producer, `hq_emit_from_activity()`. The first cut passed the existing `activity_log` metadata straight through as the event payload — the obvious "mirror the row" move. But that metadata **is** PII for several actions: a customer's name/email/phone on `customer.created`, the changed name on `customer.updated`, a quote signer's name on `quote.accepted`. Caught in **design review** (not CI) by re-reading [Ch.04 §Security](04-event-spine-and-taxonomy.md), which forbids PII in payloads — but names its enforcement as "a lint check on `emitEvent` payload shapes", a TypeScript control the SQL producer never passes through.

- **Impact:** the documented control has a blind spot exactly where the highest-volume producer lives — the trigger path that mirrors *every* tenant mutation. Pass-through would have copied tenant PII into the spine (an `RLS:hq`, append-only, broadcast-fanned-out log — the worst place to duplicate it), silently, with the Bible's stated enforcement reading as satisfied. The same blind spot is latent in PR4's backfill adapters (Ch.04 §Testing already anticipates them), which are also SQL/server-side and would inherit "the lint covers it" by false assumption.
- **Fix:** curate at the producer — `hq_emit_from_activity()` projects only non-PII hints (status, identifier, amount) and drops personal data, which stays in `activity_log`. Hardened two ways so the failure class is CI-gated: the [security tier](16-security.md) pins the migration text to forbid a PII payload key, and the integration tier asserts against a **live** insert that a customer's name and a quote signer's name never appear in the event payload while the non-PII context (the quote number) does. [Ch.04 §Security](04-event-spine-and-taxonomy.md) is updated to name the SQL-producer enforcement beside the TS lint.
- **Lesson:** *a control is only as wide as the surface it runs on. One principle ("no PII in payloads") with two producer paths (service `emitEvent`, trigger `_record_activity`) needs a proof on **each** path — a TypeScript lint cannot bind a payload built in SQL. When you generalise a producer, **mirror the event, not the record**: the source log may be PII-heavy precisely where the event must not be.*

> L-1, L-2, L-4 and L-5 share one root: **mocks prove intent, real infrastructure proves behaviour** — each was invisible to the mocked unit tier and surfaced only when the real-Postgres gate ran the migration against a live database with a live JWT client. The directive they harden into law — *every feature touching security, auth, multi-tenancy, the database, AI infrastructure, billing, payroll, or customer data carries a live integration test* — is recorded as [ADR-015](#203-decision-log-adrs) and enforced by [Ch.18 §13](18-testing-strategy.md) and the [Implementation Rules](../IMPLEMENTATION-RULES.md) Gate 2.

---

*The Bible is complete in structure: twenty chapters across six volumes, one philosophy, one rule, one source. What remains is not more specification — it is the CEO's decisions in §20.4.A, and then the disciplined, gated, preview-first implementation that Ch.19 lays out. This document is the foundation of CrewFlow for the next decade.*
