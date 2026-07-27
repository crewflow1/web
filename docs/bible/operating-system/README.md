# The CrewFlow Operating Model — Volumes XIV–XVIII

> **Status:** Architecture specification. Constitutional design work under **CEO
> Directive #008 — "AI Workforce Architecture, Phase 2"** (2026-06-21).
>
> **This is design, not a build order.** Per the directive: *no code, no
> implementation, no production changes, no PRs, no prototypes. Architecture
> only.* Nothing in this directory is implemented until a future CEO Directive
> explicitly instructs it. These documents exist so that, when implementation is
> authorised, the company can be **operated** exactly as designed — without
> inventing behaviour.
>
> **Companion documents.** This layer sits on the **AI Substrate**
> (`../substrate/`, Volumes IX–XIII) and the **AI Workforce**
> (`../workforce/`, the 42 employees + `relationships.md`). The capstone that
> synthesises all three layers end-to-end is **`crewflow-operating-system.md`**
> in this directory — the definitive blueprint.

---

## Why this exists

We have designed the Vision, the Philosophy, the Bible, the AI Substrate, the AI
SDK, and the 42 AI Employees. One question remains, and it is the one that
separates CrewFlow from every other AI platform:

> **How do forty-two AI employees actually operate together as a company?**

A substrate is a kernel. A workforce is a roster. Neither, on its own, is a
*company*. A company is what emerges when a roster runs on a kernel **in time,
under authority, learning as it goes, measuring itself, and changing without
breaking**. That emergent behaviour is the **operating model** — and it is what
these five volumes design.

We are no longer designing individual employees. **We are designing CrewFlow
itself.**

This layer adds **no new mechanism.** Every cadence is a Task-Engine schedule
(XII); every decision is an autonomy test (P4) and an approval checkpoint (XII);
every lesson is a Shared-Memory write (X); every KPI is a projection of
`hq_events` (XI); every change is data or an additive migration (P6). The
operating model is the **composition** of the substrate and the workforce into a
running company — never a parallel implementation of either. That discipline is
the whole point: *one architecture, one source of truth* (Directive #003).

---

## The five volumes — the five axes of a company

A company is a system that runs along five orthogonal axes. Each volume owns
exactly one. Orthogonality is deliberate: it is what keeps the five from
overlapping or contradicting one another.

| Vol | Volume | Axis | The question it answers | Company-organ analogy |
|-----|--------|------|-------------------------|-----------------------|
| **XIV** | **Company Operations** | **TIME** | *When* does the company act — from midnight to midnight, and out to the fiscal year? | The heartbeat & circadian clock |
| **XV** | **Decision Framework** | **AUTHORITY** | *Who* may decide *what*, *how far*, before a human is in the loop? | The constitution & nervous reflexes |
| **XVI** | **Company Memory** | **LEARNING** | *How* does the company turn experience into permanent, ever-improving knowledge? | The hippocampus & institutional DNA |
| **XVII** | **Company Intelligence** | **MEASUREMENT** | *How* does the company see itself — KPIs, dashboards, trends, predictions? | The sensory & analytic cortex |
| **XVIII** | **Company Evolution** | **CHANGE** | *How* does the company grow, retire, and re-version itself cleanly for a decade-plus? | The genome & developmental plan |

```
                    THE RUNNING COMPANY  (what these five volumes make real)
        ┌──────────────────────────────────────────────────────────────────────┐
        │   TIME            AUTHORITY        LEARNING       MEASUREMENT   CHANGE │
        │   XIV             XV               XVI            XVII          XVIII  │
        │  cadences →     decisions →      lessons →       KPIs →       versions │
        │  the clock      the constitution the company     the company  the     │
        │                                  brain's growth  scoreboard   genome  │
        └──────────────────────────────────────────────────────────────────────┘
                                          ▲ composes (adds no mechanism)
        ┌──────────────────────────────────────────────────────────────────────┐
        │  LAYER 4 — THE AI WORKFORCE   (../workforce/)                          │
        │  42 employees · 8 divisions · 5 tiers · relationships.md              │
        └──────────────────────────────────────────────────────────────────────┘
                                          ▲ inherits (configures, never re-implements)
        ┌──────────────────────────────────────────────────────────────────────┐
        │  THE AI SUBSTRATE — Volumes IX–XIII   (../substrate/)                  │
        │  Comms · Memory · Event Bus · Task Engine · AI SDK                     │
        └──────────────────────────────────────────────────────────────────────┘
                                          ▲ runs on
        ┌──────────────────────────────────────────────────────────────────────┐
        │  Postgres (Supabase) · RLS:hq · service-role doorman                   │
        └──────────────────────────────────────────────────────────────────────┘
```

**Read them as a sentence:** CrewFlow *runs in time* (XIV), *under clear
authority* (XV), *learning continuously* (XVI), *while measuring itself* (XVII),
*and evolving cleanly over decades* (XVIII).

---

## The prime law of this layer — inherit, never re-implement

The workforce README states the inheritance contract for an *employee*. This is
its equivalent for the *company*: every operating-model volume **inherits the
layers below and adds only the organisational behaviour that composes them.** If
a volume finds itself specifying a table, an FSM, a permission gate, a metric
pipeline, or a message format, it has crossed into the substrate's job and must
stop and reference instead.

| This layer needs… | …is already provided once by… | …so the volume may only state… |
|-------------------|-------------------------------|--------------------------------|
| A clock / recurring cadences | **Task Engine (XII)** — `hq_ai_schedules` + the tick | *which* cadences exist, *who* runs them, *what* they produce |
| The "act vs ask" rule | **P4 autonomy test** + Task Engine approval checkpoints | *how* decision rights are organised into a constitution |
| Tiers & the escalation ladder | **Workforce §5** + **`relationships.md` §6** | *the consolidated* approval matrix & limits |
| A place to remember | **Shared Memory (X)** + **Memory Manager (38)** | *how the company learns* — the organisational loop on top of the store |
| A record that something happened | **Event Bus (XI)** — `hq_events`, the system of record | *which* KPIs/dashboards/reports **project** from it |
| A way to talk / hand off | **Comms (IX)** + **`relationships.md`** graphs | *which* coordination rituals & meetings use them |
| A roster & capabilities | **`ai_employees`** + **`hq_ai_capabilities`** (data) | *how* employees are added, retired, and re-versioned |
| Versioning of an employee/SDK | **SDK §18** (config & versioning) | *how* the OS, the Bible, and directives evolve on top |

**The three-question gate still governs** (Directive 003, carried from the
substrate): no operating rule is admitted unless it (1) aligns with the Bible,
(2) fits the substrate naturally, and (3) every future AI employee can reuse it.

---

## The concept-ownership map (one home per concept — no duplication)

The five volumes touch shared themes (incidents, approvals, KPIs, post-mortems).
To stop them re-defining each other, **every cross-cutting concept has exactly
one owning volume**; the others **reference it by name**, never restate it. This
table is canonical; a volume that contradicts it is wrong.

| Cross-cutting concept | **Owned by** | Siblings reference it as… |
|-----------------------|--------------|---------------------------|
| The operating clock, all cadences, the lifecycles | **XIV** | "the cadence/lifecycle (Volume XIV)" |
| Decision rights, autonomy levels, escalation, approval matrix, all limits, emergency override | **XV** | "the decision rule / approval gate (Volume XV)" |
| The learning loop, post-mortem→lesson pipeline, best-practice propagation, institutional memory | **XVI** | "the lesson-capture / learning loop (Volume XVI)" |
| The KPI tree, dashboards, trend & predictive analysis, board reports | **XVII** | "the metric / dashboard (Volume XVII)" |
| Adding/retiring employees, capability/SDK/OS/Bible versioning, the directive→change pipeline | **XVIII** | "the change/evolution process (Volume XVIII)" |
| **Incident response** | playbook & rhythm in **XIV**; override authority in **XV**; incident KPIs (MTTR) in **XVII**; the blameless lesson in **XVI** | each volume holds *only its slice*, citing the others |
| **The board pack** | assembled on the planning cadence in **XIV**; content (KPIs/trends) in **XVII** | "the board report (XVII), on the cadence (XIV)" |

**Cross-volume citation rule:** reference a sibling by **volume + named
concept**, never by a sibling section number. Section numbers drift; volume names
and concept names do not. (Within a single volume, section references are fine.)

---

## Shared operating primitives — defined ONCE here, referenced everywhere

As the substrate has P1–P7, the operating model has **O1–O6**. They are canonised
here and only referenced (never redefined) in the volumes.

### O1 · The operating clock (nested cadences, all scheduled — never polled)

The company runs on a **nested hierarchy of cadences** — minute, hour, day, week,
month, quarter, year — each a loop with a trigger, participants, inputs, outputs
and emitted events. **Every cadence is a recurring Task (XII `hq_ai_schedules` +
the tick), not a poller** — this is the standing resolution of conflict **C3**
("nothing polls"). The clock is owned by Volume XIV; other volumes hang their
periodic behaviour (memory consolidation, KPI snapshots, version reviews) on it
by reference.

### O2 · One decision, one owner

**Every decision the company makes has exactly one accountable owner** — an
employee at a tier (Workforce §5) whose authority is defined by Volume XV. Acts
that pass the **autonomy test (P4)** are owned and executed autonomously; acts
that fail it are owned *and escalated* to the next rung, terminating at a human.
No decision is ownerless, and no decision is owned by committee. Authority is
defined once in Volume XV; every other volume defers to it.

### O3 · The learning loop (experience becomes canon)

Knowledge flows one way and never evaporates: **experience → reflection → lesson
→ consolidation → canon → recall → improved action.** It rides Shared Memory (X)
and the Memory Manager (38); Volume XVI defines the *organisational* loop on top.
The promotion of private experience into shared company canon is **gated by the
decision framework (Volume XV)** and recorded forever (no hard delete — Volume
X's durability rule).

### O4 · Measurement is projection, never a parallel truth

**Every company metric is a read-projection of `hq_events`** (the system of
record, P1) — never a separately-maintained number. This is the standing
resolution of conflict **C5**: one source of truth, many read-models. A KPI, a
dashboard, a board report and a forecast are all *views* over the same event
spine. Volume XVII owns the views; it never owns a second copy of the truth.

### O5 · Change is data, or an additive versioned migration

**Everything that varies as the company evolves is either data or a versioned,
additive, idempotent migration** — never a breaking rewrite (P6, and the standing
resolution of **C1**: roster and capabilities are data). New employee → a roster
row + capability rows. New cadence, KPI, decision-limit, event verb → a row. New
structure → an additive migration with a path. Volume XVIII owns the governance
that keeps it so for a decade-plus.

### O6 · Human supremacy and the single audit spine

Two invariants bind the whole model: **(a)** a human can always inspect, pause,
override, or reverse any AI decision — the emergency override (Volume XV) is
absolute and the board is the apex of every escalation ladder; and **(b)**
**everything the company does is an event in the one log** (`hq_events`) — so the
company's entire operating history, every decision, lesson, metric and change, is
reconstructable with `WHERE correlation_id = X ORDER BY id`. The operating model
is auditable by construction.

---

## How to read an operating-model volume

Each of the five follows the same skeleton, adapted from the substrate's:

1. **Purpose & scope** — the one-sentence job; the axis it owns.
2. **Where it sits** — what it inherits from below (substrate + workforce) and how it composes it; what it must *not* re-implement.
3. **Built vs. to-build** — the honest ledger: what mechanism already exists (mostly the substrate) vs. what organisational design is new here.
4. **The model** — the heart: the cadences (XIV) / the constitution (XV) / the learning loop (XVI) / the KPI tree (XVII) / the change process (XVIII).
5. **Worked detail** — the named cycles, matrices, pipelines, dashboards, or processes the volume is responsible for.
6. **Cross-axis seams** — exactly where this volume touches the other four, and which side owns what (per the concept-ownership map).
7. **Failure & recovery** — what happens when the model breaks (a missed cadence, an out-of-authority act, a bad lesson, a gamed metric, a broken migration).
8. **Observability** — how the health of *this model itself* is seen (and where Volume XVII measures it).
9. **Conflicts resolved** — the C-items this volume closes (XIV→C3, XV→C2, XVI→C6, XVII→C5, XVIII→C1).
10. **Open questions** — what a future directive must still decide.

---

## The master document

When the five volumes are complete, **`crewflow-operating-system.md`** synthesises
them — together with the substrate and the workforce — into one end-to-end
blueprint: how the AI company **thinks, communicates, learns, decides, improves,
scales, serves customers, manages itself, and evolves over decades.** It is the
highest document in the Bible: the definitive description of CrewFlow as the
world's first truly AI-native company for the construction industry.

---

*Design work under CEO Directive #008 (2026-06-21). No implementation proceeds
from these documents until an explicit future CEO Directive instructs it.
Architecture only — no code, no production change, no migration, no PR. This
layer composes the AI Substrate (IX–XIII) and the AI Workforce (Layer 4); it
re-implements neither.*
