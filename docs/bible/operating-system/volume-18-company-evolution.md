# Volume XVIII — Company Evolution

> **The Operating Model layer, volume 5 of 5 — the CHANGE axis.** Architecture
> only. Constitutional design work under **CEO Directive #008 — "AI Workforce
> Architecture, Phase 2"** (2026-06-21).
>
> **This is design, not a build order.** Per the directive: *no code, no
> implementation, no production changes, no PRs, no prototypes, no migrations.*
> Nothing here is built until a future CEO Directive instructs it.
>
> This volume **inherits C1 and P6** (roster & capabilities are data; migrations
> are additive, idempotent, versioned) and **SDK §4 and §18** (the capability
> registry; semantic versioning of an employee/SDK). It **governs change across
> every layer** — substrate, workforce, and operating model — and **re-implements
> no registry**: the tables that hold the roster and the capabilities already
> exist, and this volume designs only the *governance* of their evolution.
>
> **Read `./README.md` first** — it pins the five axes, the operating primitives
> O1–O6 (here especially **O5** *change-is-data-or-additive-migration* and **O6**
> *human supremacy & the single audit spine*), the concept-ownership map, and the
> cross-volume citation rule this volume obeys.

---

## 1. Purpose & scope

**The job, in one sentence:** be the **CHANGE axis** of the company — the single
governed process by which CrewFlow **grows, retires, and re-versions itself** —
adding and removing employees, evolving capabilities, versioning the SDK, the
operating system and the Bible, and absorbing future CEO Directives, **so the
company still scales cleanly a decade-plus from now.**

This volume realises **operating primitive O5**: *everything that varies as the
company evolves is either data or a versioned, additive, idempotent migration —
never a breaking rewrite.* A company-organ analogy frames it: if Volume XIV is
the heartbeat, XV the constitution, XVI the hippocampus and XVII the sensory
cortex, then **Volume XVIII is the genome and the developmental plan** — how the
organism is allowed to change shape over time without ever stopping its heart.

**In scope (the mandatory coverage — every one is a section below):** how new AI
employees are added (§5); how old employees are retired (§6); how capabilities
evolve (§7); how SDK versions evolve (§8); how the operating system itself
evolves (§9); how the Bible evolves (§10); how future CEO Directives modify the
platform (§11); and the framing demand — *design CrewFlow so it can still scale
cleanly ten years from now* (§12).

**Out of scope (owned elsewhere — this volume cites, never restates):** the
registries themselves — `ai_employees` and `hq_ai_capabilities` (SDK §4/§5, C1);
the migration mechanics — additive/idempotent SQL discipline (P6); the approval
that gates every change (the decision rule / approval gate, Volume XV); the
calibration that justifies an autonomy raise (the lesson-capture / learning loop,
Volume XVI, and the metric / dashboard, Volume XVII); the cadence on which
version reviews run (the cadence/lifecycle, Volume XIV). This volume adds **no
new mechanism** — change rides the substrate and the workforce exactly as they
ship.

---

## 2. Where it sits

```
            ┌───────────────────────────────────────────────────────────┐
   governs  │   CHANGE (XVIII) — the genome & developmental plan          │
   change   │   adds/retires employees · versions capabilities/SDK/OS/    │
   across → │   Bible · absorbs CEO Directives — all as DATA or additive  │
   ALL      │   migration (O5), all audited as events (O6)                │
   layers   └───────────────┬───────────────────────────────────────────┘
                            │ composes (adds no mechanism)
        ┌───────────────────▼───────────────────────────────────────────┐
        │  OPERATING MODEL  XIV TIME · XV AUTHORITY · XVI LEARNING ·       │
        │                   XVII MEASUREMENT       (siblings; cited)      │
        ├─────────────────────────────────────────────────────────────────┤
        │  LAYER 4 — THE AI WORKFORCE   42 employees · 16-section specs    │
        │            roster `ai_employees` · capabilities                  │
        ├─────────────────────────────────────────────────────────────────┤
        │  THE AI SUBSTRATE — IX–XIII   Comms·Memory·Bus·Tasks·SDK         │
        │            `hq_ai_capabilities` (§4) · versioning (§18) · P6     │
        ├─────────────────────────────────────────────────────────────────┤
        │  Postgres (Supabase) · RLS:hq · service-role doorman            │
        └─────────────────────────────────────────────────────────────────┘
```

- **Built on:** **C1** (the roster is data in `ai_employees`; capabilities are
  data in `hq_ai_capabilities`); **P6** (additive, idempotent, versioned
  migrations; lookups-as-data); **SDK §18** (an employee, its prompt and each
  capability carry a semantic version, stamped on every output, rolled forward
  alongside the old and rolled back by re-activation). Change is the *use* of
  these three facts as an operating discipline.
- **Governs change across:** the **substrate** (a new table, verb, or entry-point
  function arrives additively); the **workforce** (a new or retired employee is a
  roster + capability data change plus one handler); and the **operating model**
  (a new cadence, decision-limit, KPI, or learning-policy is a row where possible,
  an additive migration where structural).
- **What this volume must NOT re-implement — the registries.** It does not
  redesign `ai_employees` or `hq_ai_capabilities`; it does not re-specify the
  migration conventions (P6 owns them); it does not invent an employee-spec format
  (the Workforce 16-section template owns that). It owns the **lifecycles and the
  directive pipeline** that operate on those registries — nothing else.

---

## 3. Built vs. to-build

The honest ledger. Almost every *mechanism* this volume needs already exists; the
**evolution governance** — the lifecycles and the directive pipeline — is the new
organisational design.

| Capability the CHANGE axis needs | State | Where it lives / note |
|----------------------------------|-------|------------------------|
| A roster that grows as data | **Built** | `ai_employees` (C1; Workforce §7 roster). |
| A capability registry with version, scopes, status | **Built (to-build in code)** | `hq_ai_capabilities` (SDK §4) — designed, not yet implemented. |
| Additive / idempotent / versioned migration discipline | **Built (as doctrine)** | P6; `create … if not exists`, `add column if not exists`, `on conflict do nothing`. |
| Semantic versioning of an employee / prompt / capability / SDK | **Built (as design)** | SDK §18; version stamped on every output (P3 provenance). |
| Employee lifecycle `register→configure→activate→run→pause→retire` | **Built (as design)** | SDK §17. |
| A directive decomposer that turns intent into routed cross-department work | **Built (as design)** | Boardroom Orchestrator (#42), consuming Workflow (#39). |
| The enum→lookup graduation worked example | **Flagged** | Workforce §8 department-enum gap → future `hq_ai_departments` lookup. |
| **The hiring lifecycle** (spec→register→shadow→calibrate→activate, with gates) | **To design (here)** | §5 — the new governance. |
| **The retirement lifecycle** (disable→revoke→reassign zones→archive→audit) | **To design (here)** | §6. |
| **Capability-evolution governance** (recalibrate, scope shift, deprecate) | **To design (here)** | §7. |
| **SDK-version governance** (ABI contract, rolling upgrade, deprecation window) | **To design (here)** | §8. |
| **OS-evolution governance** (versioning XIV–XVIII; amending O1–O6) | **To design (here)** | §9. |
| **Bible-evolution governance** (ADRs, supersession, amendment provenance) | **To design (here)** | §10. |
| **The directive→change pipeline** (intake→decompose→route→track) | **To design (here)** | §11. |

**Net:** the *parts that change* (rows) and the *way structure changes* (additive
migrations) are already settled by C1 and P6. What is new here is the **discipline
that keeps every future change one of those two shapes** — and never a breaking
rewrite — for a decade-plus.

---

## 4. The change model

The heart of the volume. One principle, four corollaries.

### 4.1 The principle (O5)

> **Every change to CrewFlow is one of exactly two things: DATA, or a versioned,
> additive, idempotent migration with a path. There is no third, breaking, kind.**

A new employee is a roster row plus capability rows. A new cadence, KPI,
decision-limit, event-verb, tool-label, or memory-zone is a row in a lookup. A
new structural capability is a migration that *adds* — a new table, a new column
(`add column if not exists`), a new entry-point function — alongside the live
shape a runner depends on, never an in-place mutation of it (P6). A renamed or
repurposed employee is a **new version** activated beside the old, not an
overwrite (SDK §18). The company evolves the way a genome does: by additive
expression and versioned variants, not by rewriting the running organism.

### 4.2 The "never break a running employee" rule

Because change is additive, **no live employee is ever broken by an evolution
step.** A migration that would alter a column a runner reads in place is
forbidden; the new capability arrives as a new column or table, and the runner is
migrated to it on its own schedule. A capability a caller depends on is never
deleted out from under it — it is *deprecated* (status `deprecated` in
`hq_ai_capabilities`, SDK §4) while still resolvable, then retired only after its
callers have moved. The standing guarantee: **a change in flight never produces a
half-broken company** — the worst case is an additive object that is not yet used.

### 4.3 Backward compatibility as a contract

Callers in CrewFlow name a **capability**, never an employee (SDK §4, C1) — so the
unit of compatibility is the *capability slug and its scope*, not the identity of
who fulfils it. That indirection is what makes the workforce re-versionable
without ripple: a capability may move from one employee to a successor, gain a
new version, or be split, and **every caller keeps working** because it asked for
`qualify.lead`, not for "employee #14." The SDK §18 version stamp on every output
makes the contract auditable across time: any past decision is attributable to the
exact employee/prompt/capability version that made it, and any version is
rollback-able by re-activation (a row update, not a deploy).

### 4.4 Change is itself audited as events (O6)

Every evolution step is a fact in the one log, `hq_events` — *hired*, *retired*,
*version-activated*, *capability-deprecated*, *directive-accepted*,
*directive-routed*. A change carries the same correlation envelope as any other
work (P1/P2), so **the company's entire evolutionary history is reconstructable**
with `WHERE correlation_id = X ORDER BY id`. And because change is audited, it is
**reversible and human-supervised**: a human can inspect, pause, override, or
reverse any evolution step, and the board is the apex of every change-related
escalation ladder (O6; the emergency override, Volume XV, is absolute). Evolution
is auditable and reversible **by construction**, not by good intentions.

---

## 5. How new AI employees are added — the hiring pipeline

Adding an employee is a **governed, gated data change** — never a framework
build. The pipeline runs through nine stages; the gates are the decision rule /
approval gate (Volume XV), and the calibration evidence is the learning loop
(Volume XVI) plus the KPI tree (Volume XVII).

| # | Stage | What happens | Shape (O5) | Gate (Volume XV) |
|---|-------|--------------|------------|-------------------|
| 1 | **Directive** | A CEO Directive (or the CEO AI via the board) authorises a new role and its mandate. | An intake event (§11). | Human-authored. |
| 2 | **Specification** | The role is written as a **16-section employee spec** (Workforce template). It invents no mechanism — only configuration. | A new `employees/NN-<slug>.md` doc. | Documentation AI (#10) authors; CTO/board review. |
| 3 | **Capability registration** | Its capabilities are declared as **rows** in `hq_ai_capabilities` (SDK §4): slug, confidence (seeded low), scopes, `requires_approval=true` default, version 1, status `active` on activation. | `INSERT`s (data, C1). | Capability grant is human-approved. |
| 4 | **Roster INSERT** | Its identity is one `ai_employees` row (slug, role, department, config, default-locked permissions). | An `INSERT` (data, C1). | Hiring an employee is a **T0 human-gated act** (Workforce §5). |
| 5 | **Register & configure** | SDK §17 `register→configure`: model, prompt, scopes, budgets, manager/escalation set. | Config jsonb (data). | CTO AI (#3) configures within mandate. |
| 6 | **Shadow / probation** | The employee **runs**, but its high-impact acts stay **human-gated regardless of role default** — a probationary posture stricter than its eventual tier. It claims tasks, reasons, proposes; nothing irreversible auto-applies. | `requires_approval=true` on all capabilities (data). | The decision rule (Volume XV) holds the gate shut. |
| 7 | **Calibration** | Its outputs are scored against realised outcomes: confidence is recalibrated from the learning loop (Volume XVI); accuracy/latency/approval-rate accrue on the KPI tree (Volume XVII). The shadow period ends when the evidence clears a bar. | `UPDATE hq_ai_capabilities.confidence` (data). | The board/executive reads the metric (Volume XVII). |
| 8 | **Activation** | On calibrated evidence, the human raises the autonomy threshold to the role's tier: reversible/bounded capabilities flip `requires_approval=false`. The employee is now a full member. | A row update (data) — **never a self-grant** (O6). | Human-approved autonomy raise (Volume XV). |
| 9 | **Steady state** | It is routed by capability (SDK §4); it learns (Volume XVI), is measured (Volume XVII), runs on the clock (Volume XIV), and decides within authority (Volume XV). | — | Ongoing. |

**The worked example — department enum → `hq_ai_departments` lookup.** The shipped
`ai_employees.department` enum has no slot for *security*, *devops*, *platform*,
*HR*, *legal*, or *analytics* (Workforce §8). Hiring a dedicated Security or HR
employee at full fidelity wants a department value the enum lacks. The **clean,
O5-compliant** way to get there is *not* to alter the enum in place (a breaking
change to a constrained column a runner reads); it is the **additive graduation**:

1. `create table if not exists public.hq_ai_departments (slug text primary key,
   name text, …)` — a lookup table (data, not code; P6).
2. Seed it with the existing enum values **plus** the missing ones, `on conflict
   do nothing` (idempotent).
3. Add `ai_employees.department_slug text references hq_ai_departments(slug)`
   with `add column if not exists`, **backfilled** from the existing enum.
4. Migrate readers to the new column on their own schedule; the old enum column
   stays until every reader has moved (the never-break rule, §4.2).
5. A new department is then forever an `INSERT`, never a deploy.

This is the canonical pattern for *every* structural evolution: a fixed set
graduates to a data-driven lookup **additively, with a path**, and the running
company never sees a break. (Flagged in Workforce §8 as a future additive
migration; deliberately **not** actioned under Directive #008 — see §16.)

---

## 6. How old employees are retired — the offboarding lifecycle

Retirement is the mirror of hiring: a **fully reversible, fully audited,
data-driven decommission** that leaves **no orphaned zone and no orphaned
capability.** It builds on SDK §17 `retire` and never hard-deletes anything
(Volume X durability; the knowledge survives in the learning loop, Volume XVI).

| # | Stage | What happens | Shape (O5) | Reversible? |
|---|-------|--------------|------------|-------------|
| 1 | **Decision** | A directive (or executive within mandate) retires the role. Retiring an employee is a **T0 human-gated act** (Workforce §5). | An intake event (§11). | — |
| 2 | **Stop claiming** | Status → `pause`/`disabled` (SDK §17/§20): the employee stops claiming new tasks; in-flight tasks finish or are reaped (Task Engine). | A status update (data). | Yes — re-enable. |
| 3 | **Capability revoke** | Its `hq_ai_capabilities` rows move to `deprecated` (SDK §4). Callers that name those capabilities **re-route to peers** automatically (SDK §4 routing; the capability outlives the employee). | A status update (data). | Yes. |
| 4 | **Zone reassignment** | Any **shared-memory ownership zone** it curated (the relationships map of owners) is reassigned to a **named successor** before retirement completes — there is no ownerless zone. | A row update (data). | Yes. |
| 5 | **Memory archived, not deleted** | Its episodic/semantic memory is **archived**, never hard-deleted (Volume X durability). The institutional knowledge it accrued survives and is consolidated by the learning loop (Volume XVI) into canon that outlives the employee. | Archive flag (data). | Yes — un-archive. |
| 6 | **Final audit** | A closing `employee.retired` event captures the reason, the successor, the reassigned zones, and the last version that ran. Its full history stays queryable by `actor_id` (O6). | An event (P1). | — |
| 7 | **Version archived** | The employee's final version is archived (SDK §18); re-hiring is re-activating a version (a row update), not a rebuild. | Version archive (data). | Yes. |

**Invariants of a clean retirement:** (a) **no orphaned capability** — every
deprecated capability is either re-routable to a peer or explicitly sunset; (b)
**no orphaned zone** — every owned shared-memory zone has a named successor; (c)
**no lost knowledge** — memory is archived and consolidated, never deleted; (d)
**fully reversible** — every step is a data change that can be undone. A botched
retirement (an orphaned zone, a non-re-routable capability) is a **failure mode**,
caught and recovered in §14.

---

## 7. How capabilities evolve

A capability is a **versioned row** in `hq_ai_capabilities` (SDK §4) — so its
evolution is a sequence of data changes, each gated and audited. Four evolution
moves, all additive:

1. **Confidence recalibration.** The `confidence` integer (which drives
   best-candidate routing, SDK §4) is **recomputed from realised outcomes** — the
   learning loop (Volume XVI) turns post-hoc accuracy into a calibrated estimate,
   and the KPI tree (Volume XVII) supplies the measured accuracy/success-rate. A
   capability that proves reliable rises; one that drifts falls and sheds work to
   better candidates. This is an `UPDATE` on a column — **data, on a cadence**
   (Volume XIV).
2. **Scope expansion or contraction.** A capability's `scopes[]` and
   `requires_approval` (SDK §4) may widen (more resources, more autonomy) or
   narrow. **Every scope change is a decision the decision framework gates**
   (Volume XV): widening autonomy on a reversible/bounded capability may be
   approved on calibrated evidence; widening it on an irreversible one always
   stays human-gated.
3. **The autonomy-threshold ratchet.** Autonomy moves **one notch at a time, on
   evidence, and never backwards silently.** A capability earns a lower approval
   bar only when the learning loop (Volume XVI) and the KPIs (Volume XVII) clear
   the bar for it; the ratchet is the §5-stage-8 mechanism generalised — a row
   update, human-approved (O6), never a self-grant. If reliability regresses, the
   ratchet **tightens** (autonomy is pulled back) by the same gated update.
4. **Deprecating a capability — additively.** A capability is never deleted while
   callers depend on it. It moves to status `deprecated` (SDK §4) — **still
   resolvable** so nothing breaks — and a successor capability (a new version, or
   a different employee's grant) takes new traffic. The deprecated grant is
   retired only once its callers have moved. New capability kinds arrive the same
   way: an `INSERT`, never a deploy (C1/P6).

Each move is stamped with a capability **version** (SDK §18), so any past decision
is attributable to the exact capability version and scope that produced it.

---

## 8. How SDK versions evolve

The SDK is the **ABI** every employee runs on (SDK §2). Versioning it is therefore
governed as a **contract**, not a free rewrite — SDK §18 semantic versioning is the
anchor, and this section is the governance that keeps the contract honest across a
decade of employees.

| Change class | SemVer move | Compatibility obligation | Rollout |
|--------------|-------------|--------------------------|---------|
| New `ctx` surface, new tool kind, new optional field | **MINOR** | Purely additive; existing handlers untouched. | Ships; employees opt in when ready. |
| Bug fix, perf, internal hardening | **PATCH** | No surface change. | Rolls transparently. |
| Changed/removed `ctx` method signature or semantics | **MAJOR** | **Old surface preserved through a deprecation window** (§8.2); never removed under a running employee. | Staged migration; both versions live. |

### 8.1 Backward compatibility is the default

A MINOR/PATCH SDK change **never breaks a running employee** — new capability
arrives as a new surface; old surfaces keep their contract. An employee **pins**
the SDK version it was authored and calibrated against (config, data; SDK §18), so
a platform upgrade does not silently change the behaviour or cost of a calibrated
employee. Upgrading is an **opt-in version bump** in the employee's config, a row
update, rollback-able by reverting the pin (SDK §18 — config is data).

### 8.2 Rolling upgrades, no workforce-wide breakage

A MAJOR SDK change rolls out as a **new version live alongside the old**: employees
migrate to it **one at a time, on their own schedule**, each re-calibrated against
the new behaviour before its autonomy is restored (§5 stages 6–8). The old major
stays available for a published **deprecation window** so no employee is forced to
move before it is ready. There is **never a flag-day** where all 42 employees must
upgrade at once — that would violate the never-break rule (§4.2) at platform scale.
The deprecation window is itself a governed decision (Volume XV) and a tracked
change (§11).

---

## 9. How the operating system evolves

The operating model itself — Volumes **XIV–XVIII** and the operating primitives
**O1–O6** — is **versioned and amended under the same O5 discipline it preaches.**
A meta-rule: *the rules of the company change the way the company changes — as data
where possible, as an additive migration where structural, never as a silent
overwrite.*

- **A new cadence** (a new periodic ritual) is a new recurring Task row
  (`hq_ai_schedules`, the clock owned by Volume XIV) — **data**, hung on the
  existing clock, not new plumbing.
- **A new decision-limit or approval rung** is a row in the authority configuration
  the decision framework reads (Volume XV) — **data**.
- **A new KPI** is a new projection over `hq_events` (Volume XVII; O4 — measurement
  is projection, never a parallel truth) — a **read-model**, not a second copy of
  the truth.
- **A new learning-policy** (a consolidation or propagation rule) is configuration
  the learning loop reads (Volume XVI) — **data**.
- **A structural OS change** (a genuinely new operating concept that needs a table
  or column) is an **additive migration with a path** (P6) and an ADR (§10).

**Amending the operating primitives O1–O6.** The six primitives are the
constitution of this layer; they are amended **only by CEO Directive**, through the
directive pipeline (§11), and **only additively or by supersession** — a primitive
is never silently rewritten. An amendment lands as an ADR (§10) that records the
old text, the new text, the directive that authorised it, and the reasoning. The
primitives drift slowly and traceably, exactly like the Bible they govern (§10).
Because the keystone README is the single home of O1–O6, an amendment edits **one
place**, and every volume inherits it — the same one-home-per-concept discipline
that the concept-ownership map enforces.

---

## 10. How the Bible evolves — the document constitution

The Bible is a **versioned, append-corrected canon** — never silently overwritten.
Its evolution is governed so the company's constitution stays *true* as it grows,
with full provenance for every amendment.

- **ADRs are the unit of constitutional change.** A material decision — a new
  table, a primitive amendment, a roster or capability change of consequence,
  an SDK major — lands as an **Architecture Decision Record** in
  `../decisions/NNNN-*.md`, authored by Documentation AI (#10, the curator of the
  Bible zone), in the **same change-set as the work it documents** (the
  document-before-you-build discipline the substrate inherits). The `decisions/`
  directory is the canonical future home; it is created when the first ADR lands.
- **Supersession, not deletion.** A superseded decision is **marked superseded and
  linked to its replacement**, never erased. The reasoning that led to the old
  decision stays readable — the Bible is an *append-corrected* record of how the
  company thought over time, not a snapshot of only its latest opinion. This is the
  textual analogue of memory durability (Volume X) and capability deprecation
  (§7): the old is retained, the new takes precedence.
- **Amendment provenance.** Every amendment carries *who* (the directive and the
  authoring employee), *when*, *what changed* (old → new), and *why* (the
  reasoning). An amendment with no provenance is not admitted. Provenance makes the
  Bible auditable the way `hq_events` makes operations auditable (O6).
- **The open Bible-renumbering item.** The Substrate Block was named IX–XIII, which
  **collides** with the provided canon's existing IX–XII, and the operating-model
  block was named XIV–XVIII on top. The collision is **tracked, not silently
  overwritten**: the canonical renumber proposed in `../adoption-analysis.md`
  Appendix A is the single place the whole Bible's numbering is reconciled, by a
  future directive. Until then **titles are authoritative and numbers are
  provisional** — exactly the standing resolution the substrate README records. The
  renumber is a documentation migration (rename + cross-reference fix), itself
  governed by this section, and is an **open question** (§16), not a blocker.

The Bible evolves like the rest of the company: **additively, with provenance,
superseding rather than overwriting** — a canon that accumulates correction
without losing its history.

---

## 11. How future CEO Directives modify the platform — the directive→change pipeline

A CEO Directive is the **root cause** of nearly every deliberate evolution. The
pipeline that absorbs one is the spine of this volume, and it **re-uses existing
machinery end-to-end** — it builds nothing new.

```
  CEO Directive (human / board)
        │  minted as a root-cause event: fresh correlation_id (P2), actor=human (O6)
        ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  AI Boardroom Orchestrator (#42)  —  intake → convene execs → DECOMPOSE │
  │     decomposes the directive into a cross-department task graph         │
  │     BY CONSUMING Workflow AI (#39); routes by capability (SDK §4).      │
  │     It makes no strategy, executes nothing, re-implements nothing.      │
  └───────────────┬─────────────────────────────────────────────────────┘
                  │ the directive fans out into…
   ┌──────────────┼───────────────┬────────────────────┬──────────────────┐
   ▼              ▼               ▼                    ▼                  ▼
 16-section     `hq_ai_         ADR(s) in            additive          KPI / cadence /
 employee spec  capabilities`   ../decisions/        migration         decision-limit
 (Workforce     rows / version  (§10)                with a path       rows (§9)
  template)     (C1, §7)                             (P6)
   │              │               │                    │                  │
   └──────────────┴───────────────┴────────────────────┴──────────────────┘
                  │ routed to departments, tracked to delivery
                  ▼
   every step shares the directive's correlation_id → fully auditable (O6):
   "what did the board direct, how did it change the platform, was it delivered?"
                     = WHERE correlation_id = X ORDER BY id
```

- **A directive is a root-cause event** with a **fresh `correlation_id`** (P2) and
  `actor_type=human` (O6). Everything the directive spawns — specs, ADRs,
  migrations, roster/capability rows, KPI/cadence rows — **inherits that
  correlation_id**, so the entire platform change is one queryable saga.
- **Decomposition is the Boardroom Orchestrator's job (#42), consuming Workflow
  (#39).** #42 intakes the directive, convenes the executives to shape it, and
  decomposes it into a cross-department task graph **by delegating the DAG to
  Workflow** — it does not build orchestration, set strategy, or execute. The
  decomposition routes each unit of change to the right department by capability
  (SDK §4).
- **The governance that keeps directives additive and traceable.** Every unit a
  directive spawns must land in one of O5's two shapes — **data, or an additive
  migration with a path.** A directive cannot authorise a breaking rewrite; if it
  implies one, the decomposition expresses it as an additive graduation (the §5
  enum→lookup pattern). The pipeline thereby makes O5 a property of *how directives
  are absorbed*, not merely of how individual rows are written.
- **C8 directive sequencing.** Directives are numbered and sequenced — #003 (one
  architecture), #004/#005 (already issued), the substrate block, #007 (workforce),
  **#008 (this Operating Model layer)**. A new directive takes the **next number**,
  cites the directives it builds on, and **never silently contradicts an earlier
  one** — if it supersedes a prior directive, it says so explicitly and an ADR
  records the supersession (§10). Sequencing is what keeps a decade of directives a
  coherent, ordered constitution rather than a pile of conflicting edicts (the
  detailed resolution is §15).

---

## 12. Ten-year clean-scaling

The framing demand the directive sets: *design CrewFlow so it can still scale
cleanly ten years from now.* The argument has four legs, each a direct consequence
of the architecture above.

**1. The roster is data, so 42 employees and 420 scale the *same way*.** Adding the
43rd, the 100th, the 420th employee is the **identical operation** every time: a
roster `INSERT`, capability `INSERT`s, one handler, the §5 hiring pipeline (C1, SDK
§4). There is no point at which growth stops being a data migration and becomes a
re-architecture — because callers name **capabilities**, never employees, the
routing fabric does not change shape as the workforce grows. **Scale is a row
count, not a rewrite.**

**2. One substrate, so the cost of the Nth employee is bounded.** Every employee
inherits identity, memory, comms, events, tasks, permissions, cost, audit and
approval from the **one** SDK (the inheritance contract, Workforce §2). The
substrate does not fork per employee; the 420th reuses exactly what the 1st did.
The marginal cost of an employee is **its config and its handler** — not a new
framework — so complexity grows **linearly with capability, not combinatorially
with headcount.**

**3. Additive migrations, so the schema never seizes.** Structural change is always
additive with a path (P6, §4). Ten years of evolution accretes new tables, new
columns, new lookup rows — and the live tables a runner depends on are never
mutated in place. The schema **grows**; it does not get **rewritten**. There is no
"big migration" that stops the company.

**4. Construction-specifics are configuration, so a new vertical reuses the OS.**
The UK-construction domain — CDM 2015, CIS, the Building Safety Act, NRM take-off,
the construction capability slugs and memory zones (Workforce §6) — lives in
**data**: capability rows, memory-zone ownership, lookup values, employee specs.
The substrate and the operating model carry **no construction logic.** So a future
vertical (a different trade, a different jurisdiction, a different industry
entirely) is **a new dataset on the same OS** — a new roster, a new capability set,
new memory zones — not a new platform. The same fact makes CrewFlow
**multi-tenant** (tenant is an actor type and a visibility scope on the event spine,
P1) and **multi-domain** (the domain is the data, not the code).

**What would break at scale — and how the design prevents it.**

| Failure that *would* arrive at scale | Why it is prevented |
|--------------------------------------|----------------------|
| Per-employee plumbing duplicated 420× → unmaintainable | The inheritance contract: zero duplicated logic; one substrate (Workforce §2). |
| Roster/capability conflicts as employees multiply | C1: one registry, capabilities are the only routing key; adding rows cannot contradict code. |
| Schema rewrites blocking the running company | P6 additive/idempotent migrations; the never-break rule (§4.2). |
| A breaking SDK upgrade taking down the whole workforce | Pinned versions + rolling upgrades + deprecation windows (§8). |
| Measurement diverging into many conflicting "truths" | O4: every metric is a projection of `hq_events`; one source, many read-models. |
| Knowledge lost as employees turn over | Memory archived not deleted (§6); consolidated into canon (Volume XVI). |
| Directives accumulating into contradiction | C8 sequencing + ADR supersession (§11, §10). |
| Domain assumptions hard-coded, blocking a new vertical | Construction-specifics are data (leg 4); the OS is domain-agnostic. |

The conclusion the directive asks for: **CrewFlow scales cleanly for a decade-plus
because growth, retirement and re-versioning are all the *same two operations* —
write a row, or run an additive migration with a path — applied uniformly from the
1st employee to the 420th, from the construction vertical to the next.**

---

## 13. Cross-axis seams

CHANGE is the axis that *operates on* the other four; every seam is cited by volume
+ named concept (never a sibling section number), per the keystone's rule.

| Seam | CHANGE (XVIII) owns | The sibling owns | Resolution |
|------|---------------------|------------------|------------|
| **TIME** | *When* a version review / hiring calibration / capability recalibration runs is a change governed here. | The clock and every cadence (the cadence/lifecycle, **Volume XIV**). | A version review is a recurring Task on XIV's clock; XVIII says *what it produces*, XIV says *when it fires*. |
| **AUTHORITY** | The hiring/retiring/scope-change/SDK-deprecation **gates** are change steps. | *Who may approve each gate* — the approval matrix, autonomy levels, emergency override (the decision rule / approval gate, **Volume XV**). | Every gate in §5–§11 defers to XV for *who decides*; XVIII never sets its own approval authority. |
| **LEARNING** | *That* confidence is recalibrated and autonomy ratcheted is a change. | *How* experience becomes a calibrated estimate and propagated lesson (the lesson-capture / learning loop, **Volume XVI**). | XVIII consumes XVI's calibrated confidence to justify a capability version bump or autonomy raise; it does not compute the lesson. |
| **MEASUREMENT** | *That* an activation/ratchet requires evidence is a change rule. | The KPIs, dashboards, trends that *supply* the evidence (the metric / dashboard, **Volume XVII**). | A §5 stage-8 activation reads XVII's calibration KPIs; XVIII never maintains its own metric (O4). |
| **Substrate & Workforce (below)** | The lifecycles and directive pipeline. | The registries (`ai_employees`, `hq_ai_capabilities`; SDK §4), migration discipline (P6), the employee template (Workforce). | XVIII governs their *evolution*; it re-implements none of them (§2). |

---

## 14. Failure & recovery

What happens when an evolution step goes wrong — and how the O5/O6 discipline makes
each recoverable.

- **A bad employee version → rollback.** A new employee/prompt/capability version
  behaves worse than its predecessor (caught by the KPI tree, Volume XVII).
  **Recovery:** re-activate the prior version — a **row update**, not a deploy (SDK
  §18). Because every output is version-stamped (P3 provenance), the regression is
  isolated to exactly the version that caused it, and no good prior work is lost.
- **A breaking migration → prevented, not recovered.** A migration that would
  mutate a live column in place is **forbidden by P6 and the never-break rule
  (§4.2)** before it ships — the design *prevents* the failure rather than
  recovering from it. The only shape permitted is additive-with-a-path, whose worst
  case is an unused new object. If a structural change is genuinely needed, it takes
  the enum→lookup graduation form (§5).
- **A directive that conflicts with the Bible → resolution.** A new directive
  contradicts a standing primitive (O1–O6) or a prior directive. **Recovery:** the
  conflict is surfaced at intake (#42 cannot decompose a directive into O5-compliant
  units if it implies a breaking rewrite); it is escalated to the human board (O6);
  resolution is either an explicit, ADR-recorded **supersession** of the older rule
  (§10) or a re-framing of the directive into additive form. A directive **never
  silently overrides** the Bible (C8, §11).
- **A botched retirement → reversal.** A retirement leaves an orphaned zone or a
  non-re-routable capability. **Recovery:** because every retirement step is a
  reversible data change (§6) and audited (O6), the missing reassignment is
  completed (assign the zone to a successor) or the retirement is rolled back
  (re-enable the employee, un-archive its memory). The §6 invariants are the
  pre-flight checklist that makes this rare; the audit trail is what makes it
  recoverable when it happens.
- **A capability deprecated too early → still resolvable.** A capability is
  deprecated while a caller still depends on it. Because `deprecated` capabilities
  **remain resolvable** (§4.2, §7), the caller keeps working; the fix is to delay
  final retirement until the caller has moved. The deprecation status is a soft,
  reversible state by design.

The throughline: every evolution failure is either **prevented by the additive
discipline** (breaking migrations) or **recovered by a reversible, audited data
change** (everything else). Nothing about change is irreversible, because change is
data, and data is correctable under the one audit spine (O6).

---

## 15. Conflicts resolved

This volume closes **C1** and operationalises **C8**.

### C1 — the workforce specified with conflicting rosters (roster & capabilities are DATA)

The adoption analysis catalogued the AI workforce **three times with conflicting
rosters** (13 vs ~30 employees) and a numbering collision. The substrate resolved
the *mechanism* (SDK §4: the roster is rows in `ai_employees`, capabilities are
rows in `hq_ai_capabilities`). **This volume resolves the *governance* — it makes
"roster & capabilities are data" a durable operating discipline for a decade-plus:**

- The conflicting rosters were never a contradiction in *code* — they were
  different **row-sets** of one registry. 13, 30, 42 or 420 employees are the same
  architecture with more data (§12, leg 1).
- Every employee change in this volume — hire (§5), retire (§6), re-version (§7) —
  is an `INSERT`/`UPDATE` on those registries, **gated** (Volume XV) and **audited**
  (O6). There is no employee change that is a framework change.
- Callers name **capabilities, never employees** (SDK §4), so the roster can grow,
  shrink and re-version with **zero caller churn** — the structural fact that makes
  C1's resolution hold as the company scales, not just at one snapshot.

C1 is closed not by picking one of the three rosters, but by making **all of them
the same data-shaped registry** that this volume governs the evolution of.

### C8 — directives already issued, and the sequencing that keeps them coherent

Directives #003, #004 and #005 were already issued before the substrate block; the
analysis (§9) sequenced new work from #006+. This volume **operationalises the
sequencing as a standing rule** (§11):

- Every directive takes the **next number** in sequence; #008 (this layer) follows
  #007 (workforce), which followed the substrate block, which followed #003.
- A directive **cites the directives it builds on** and **never silently
  contradicts** an earlier one; supersession is **explicit and ADR-recorded**
  (§10).
- The directive→change pipeline (§11) gives each directive **one correlation_id**,
  so a decade of directives is a **traceable, ordered constitution** — every
  platform change attributable to the directive that authorised it.

C8 is closed by making directive sequencing a **governed, audited pipeline**, so
the accumulation of directives over ten years stays coherent and additive rather
than contradictory.

---

## 16. Open questions

What a future CEO Directive must still decide. None blocks the architecture; each is
**flagged, not silently resolved** — the standing discipline of this Bible.

1. **The Bible renumbering (open, tracked).** The IX–XIII / XIV–XVIII numbering
   collides with the provided canon (§10). The canonical renumber
   (`../adoption-analysis.md` Appendix A) is the single place to reconcile the whole
   Bible's numbering; it awaits a directive. Until then, **titles are
   authoritative, numbers provisional.** When ratified, it is a documentation
   migration governed by §10.
2. **The department enum → `hq_ai_departments` lookup graduation (flagged, not
   actioned).** The §5 worked example is the *designed* path; it is deliberately
   **not implemented** under Directive #008 (no migrations). A future directive that
   hires a dedicated security/HR/legal/analytics employee at full fidelity should
   action it — additively, with a path — exactly as §5 specifies.
3. **The autonomy-ratchet bar.** §5/§7 ratchet autonomy "on evidence that clears a
   bar." *Where the bar sits* per capability class (how much calibrated accuracy, at
   what confidence, over what sample) is a governance decision for the decision
   framework (Volume XV) and the KPI tree (Volume XVII) to set; the mechanism is
   designed, the threshold values are a directive's to choose.
4. **SDK major-version deprecation-window length.** §8 mandates a published
   deprecation window for a MAJOR SDK change; *how long* it stays open (and whether
   it varies by employee criticality) is an operational policy a future directive
   sets.
5. **Retirement archival retention.** §6 archives (never deletes) a retired
   employee's memory; *how long* archived memory and versions are retained before
   cold-storage, and under what data-governance policy, is an open question for the
   board (consistent with Volume X durability, which forbids hard delete but does
   not fix the cold-storage horizon).
6. **Vertical-expansion governance.** §12 argues a new vertical is data on the same
   OS; the *governance* of standing up a second vertical (tenancy isolation policy,
   per-vertical roster ownership, shared-vs-forked capability vocabulary) is a
   strategic decision a future directive must frame.

---

*Volume XVIII of the CrewFlow Bible — the Operating Model layer. Architecture only
— no code, no production change, no migration, no PR. Composes the AI Substrate
(IX–XIII) and the AI Workforce (Layer 4); re-implements neither.*
