# Volume XVI — Company Memory

> **Status:** Operating Model layer, document 3 of 5. Constitutional design work
> under **CEO Directive #008 — "AI Workforce Architecture, Phase 2"**
> (2026-06-21). **Architecture only — no code, no implementation, no production
> change, no migration, no PR, no prototype.**
>
> This volume owns the **LEARNING axis**: *how the company turns experience into
> permanent, ever-improving knowledge.* It **inherits the Shared Memory engine
> (Volume X) and the Memory Manager (38); it designs the organisational learning
> loop on top, and re-implements no store.** It defines *what the company learns
> and how knowledge becomes canon organisationally* — never the tables, classes,
> embeddings, retrieval pipeline, consolidation algorithm, or no-hard-delete
> mechanics, all of which are Volume X's and the Memory Manager's.
>
> **Read `../README.md` first** — the keystone pins the five axes, the operating
> primitives O1–O6 (especially **O3, the learning loop**), the concept-ownership
> map, the inheritance contract, and the cross-volume citation rule this volume
> obeys.

---

## 1. Purpose & scope

**The job, in one sentence:** make the company *get better at being itself* —
turn every experience the forty-two AI employees accumulate into permanent,
institutional knowledge that survives forever and continuously raises the
quality of every future decision.

This is the **LEARNING axis** of the operating model. Volume XIV gives the
company a clock; Volume XV gives it a constitution; this volume gives it a
**memory that learns** — the hippocampus that lays down lasting traces, and the
institutional DNA that outlives any single employee. It is the organisational
realisation of operating primitive **O3 (the learning loop)**: *experience →
reflection → lesson → consolidation → canon → recall → improved action*, flowing
one way and never evaporating.

**In scope (the organisational learning model):** the learning loop as a company
ritual; the post-mortem→lesson pipeline that turns failure into a permanent
guardrail; the best-practice propagation policy that spreads one employee's
discovery to the whole company; the continuous-improvement loop that makes each
employee measurably better over time; the durability doctrine by which
institutional knowledge survives any version, directive, or model upgrade; the
knowledge taxonomy (the institutional-memory map); and memory governance (truth
maintenance over a living brain).

**Out of scope (owned elsewhere, referenced by concept):** the memory **store**
itself — tables, the five classes, retrieval, embeddings/pgvector, the
consolidation/expiry algorithms, the durability *mechanism* (no hard delete) —
is the **Shared Memory engine (Volume X)**. The **housekeeping operation** of
that engine, and the shared-knowledge promotion checkpoint *mechanism*, are the
**Memory Manager (38)**. The **authority** to promote private experience into
company canon is the **decision framework (Volume XV)**. The **metrics** on
learning (velocity, reuse, calibration) are **company intelligence (Volume
XVII)**. The **cadence** of consolidation and reviews is **company operations
(Volume XIV)**. The **durability of an employee across versions/retirement** is
**company evolution (Volume XVIII)**. This volume *cites* each; it specifies none
of them.

---

## 2. Where it sits

Company Memory is the learning model that rides **on top of** the store. It adds
no table, no class, no algorithm — it composes the substrate the layers below
already provide into the behaviour of *a company that learns*.

```
        ┌────────────────────────────────────────────────────────────────┐
        │   VOLUME XVI — COMPANY MEMORY   (LEARNING axis)                  │
        │   the ORGANISATIONAL learning loop:                             │
        │   what is learned · how a lesson is made · how canon forms ·    │
        │   how best practice spreads · how the workforce improves        │
        └───────────────┬───────────────────────────────┬────────────────┘
                        │ rides (configures, re-implements nothing)
        ┌───────────────▼───────────────┐   ┌───────────▼────────────────┐
        │  MEMORY MANAGER (38)          │   │  SHARED MEMORY ENGINE (X)   │
        │  OPERATES X's housekeeping:   │   │  THE STORE: 5 classes,      │
        │  consolidation, expiry,       │   │  retrieval pipeline, pgvec, │
        │  dedupe, embeddings, the      │   │  consolidation/expiry mech, │
        │  promotion CHECKPOINT mech    │   │  versioning, NO HARD DELETE │
        └───────────────────────────────┘   └─────────────────────────────┘
                        ▲ promotion AUTHORISED by                ▲ episodic source
        ┌───────────────┴──────────────┐    ┌────────────────────┴───────┐
        │  DECISION FRAMEWORK (XV)      │    │  EVENT BUS (XI) — hq_events │
        │  who may promote to canon     │    │  experience & lessons are   │
        │  (the approval gate)          │    │  events; the audit spine    │
        └──────────────────────────────┘    └─────────────────────────────┘
```

- **Rides (and must NOT re-implement):** the **Shared Memory engine (Volume X)** —
  the five memory classes (semantic / episodic / working / long_term /
  procedural), the retrieval pipeline, embeddings, the consolidation/expiry
  engines, the permission matrix, and the **durability rule (no hard delete —
  archival/versioning only)**. If this volume finds itself naming a column, an
  embedding dimension, or a consolidation cron, it has crossed into Volume X and
  must stop and reference instead.
- **Is operated by:** the **Memory Manager (38)**, which runs Volume X's
  housekeeping and gates the **private→shared promotion** at the
  shared-knowledge checkpoint. This volume defines the *organisational learning*
  the operator serves; #38 turns the knobs.
- **Defers authority to:** the **decision framework (Volume XV)** — every
  promotion of private experience into company canon is an act that changes the
  company brain, so it is **gated by the decision rule / approval gate (Volume
  XV)**, never self-granted.
- **Composes:** the **Event Bus (Volume XI)** as the source stream for episodic
  experience and the single audit spine (O6); the **output envelope's
  confidence/evidence (P3)** as the raw material of calibration; the **zones in
  relationships §7** as the institutional-knowledge map it curates.

---

## 3. Built vs. to-build

The honest ledger. The **engine is shipped/designed**; the **organisational
learning behaviour is the new design here** — and it is *only* behaviour, never
a parallel store.

| Capability | State | Owned by |
|------------|-------|----------|
| The memory store, the five classes, versioning | **Built/designed** | Shared Memory engine (Volume X) |
| Retrieval pipeline, embeddings, context assembly | **Built/designed** | Shared Memory engine (Volume X) |
| Consolidation / dedupe / expiry **mechanisms** | **Built/designed** | Shared Memory engine (Volume X) |
| **Durability — no hard delete; archival + versioning** | **Built/designed** | Shared Memory engine (Volume X) |
| The shared-memory **ownership zones** (the knowledge map) | **Defined** | relationships §7 (canonical) |
| Housekeeping **operation** + the promotion **checkpoint** | **Designed** | Memory Manager (38) |
| **The organisational learning loop** (§4) | **NEW — this volume** | Volume XVI |
| **The blameless post-mortem→lesson pipeline** (§6) | **NEW — this volume** | Volume XVI |
| **The best-practice propagation policy** (§7) | **NEW — this volume** | Volume XVI |
| **The continuous-improvement loop & autonomy ratchet** (§8) | **NEW — this volume** | Volume XVI |
| **The institutional-durability & succession doctrine** (§9) | **NEW — this volume** | Volume XVI |
| **Memory governance: truth maintenance** (§11) | **NEW — this volume** | Volume XVI |

**Net:** the *filing cabinet has become cognition* (Volume X resolved that); this
volume turns that cognition into **organisational learning** — the rituals,
pipelines, and policies by which the *company*, not the database, remembers
lessons, spreads best practice, and improves. Every "new" item below is a way of
**using** the store, an approval path, or a cadence hung on the clock — never a
second store.

---

## 4. The learning loop (the heart — O3 in full)

The company learns by running **one loop, forever**. It is operating primitive
**O3**, expressed organisationally. Knowledge flows one way — *forward* — and
never evaporates: an experience that is reflected upon becomes a lesson, a lesson
that proves out becomes canon, canon is recalled at the point of need, and the
recall makes the next action better — which produces the next experience.

```
        ┌──────────────────────────────────────────────────────────────────┐
        │                    THE COMPANY LEARNING LOOP (O3)                  │
        │                                                                    │
        │   (1) EXPERIENCE ──────▶ (2) REFLECTION ──────▶ (3) LESSON         │
        │   an employee did X,     "what does this        a structured,      │
        │   observed Y            mean for next time?"    reusable memory     │
        │   = EPISODIC memory      = a reasoning step      = a candidate      │
        │     (sourced from        on the cadence          for canon         │
        │      hq_events, XI)      (Volume XIV)                               │
        │        ▲                                            │              │
        │        │                                            ▼              │
        │   (6) IMPROVED ACTION ◀── (5) RECALL ◀────── (4) CONSOLIDATION     │
        │   the next decision       at the point of      reflection earns    │
        │   rests on the lesson     need, the retrieval   its way into       │
        │   (its id in evidence[],  pipeline (X) serves   long_term/         │
        │    P3) — a better outcome the relevant canon    procedural CANON   │
        │   → a new experience      into the prompt        (gated → Vol XV)  │
        └──────────────────────────────────────────────────────────────────┘
              ↑ rides Shared Memory (X) + Memory Manager (38) end to end
```

**What triggers each step** — every trigger is an existing substrate signal; this
volume adds no new mechanism, only the meaning of the loop:

| Step | What it is | What triggers it | Whose mechanism |
|------|-----------|------------------|-----------------|
| **1 · Experience** | A time-stamped thing an employee did/observed | The work itself; an `hq_events` fact | Episodic class (Volume X), sourced from the Event Bus (Volume XI) |
| **2 · Reflection** | "What does this mean for next time?" — a reasoning pass that names a pattern | A reflection cadence (a recurring Task on the operating clock) and post-action triggers (a closed task, a resolved incident, a quarter's outcomes) | The cadence/lifecycle (Volume XIV); reflection is reasoning, P3 |
| **3 · Lesson** | A structured, reusable memory: the generalised pattern + when it applies | Reflection that clears a salience bar (worth keeping) | A `remember()` write of a high-salience memory (Volume X) |
| **4 · Consolidation** | The lesson is rolled into durable `long_term` / `procedural` **canon** | The consolidation mechanism, run by the Memory Manager (38) on cadence (Volume XIV) | Consolidation engine (Volume X); promotion to canon **gated by the decision framework (Volume XV)** |
| **5 · Recall** | The canon is served into the next actor's working context | The point of need — any task that recalls (Volume X retrieval) | Retrieval pipeline (Volume X); the recalled id becomes `evidence[]` (P3) |
| **6 · Improved action** | The next decision rests on the lesson and produces a better outcome | The next unit of work | The acting employee; the outcome is measured by company intelligence (Volume XVII) and re-enters at step 1 |

Three invariants make this a *learning* loop and not merely a logging loop:

- **It is directed and irreversible-forward.** Experience can become canon;
  canon never silently decays back into noise. This is why the loop *accumulates*
  — and why permanence (§5) is its backbone.
- **Recall closes the loop.** A lesson nobody recalls is not learning — it is
  storage. The loop only counts when canon reaches the point of need; the
  retrieval pipeline (Volume X) is therefore the load-bearing return path, and
  **lesson-reuse rate** (§14) is the headline health metric.
- **Every turn is auditable.** Experience, lesson, consolidation, and the
  improved action are each an event on the one spine (O6), so any lesson is
  traceable to the experiences that formed it and the decisions that used it —
  `WHERE correlation_id = X ORDER BY id`.

---

## 5. How knowledge becomes permanent

Learning that can be forgotten is not learning. Permanence is the property that
makes the company brain an **asset that only grows**. It has two ingredients,
both inherited, and one organisational act, which this volume owns.

**The path from experience to permanence.**

```
   PRIVATE, PERISHABLE                          INSTITUTIONAL, PERMANENT
   episodic experience  ──reflection──▶ lesson ──consolidation──▶ long_term
   (an employee's lived          (a candidate)        + procedural CANON
    record; decays per X)                              (never auto-expires, X)
            │                                                 ▲
            └──────── the SHARED-KNOWLEDGE CHECKPOINT ─────────┘
                       (private → company canon)
                       GATED by the decision framework (Volume XV)
                       OPERATED by the Memory Manager (38)
```

- **Personal vs. institutional knowledge.** An employee's *private* episodic and
  working memory is its lived experience — perishable by design (it decays under
  Volume X's retention so the brain stays lean). The *company's* `semantic`,
  `long_term`, and `procedural` knowledge at `public_hq`/`department` visibility
  is institutional — durable, versioned, never auto-expiring. The boundary
  between them is the one place learning becomes *permanent for the company*.
- **The shared-knowledge checkpoint** is the gate across that boundary. A
  consolidated lesson proposed as company canon **always parks for approval**
  (the Memory Manager (38) requests it; the decision framework (Volume XV)
  authorises it) unless an explicit scoped grant pre-authorises that narrow
  knowledge type. This is deliberate: *the company brain cannot be silently
  rewritten* — not even by the employee that tidies it. Promotion is an act of
  authority, owned per O2, decided per Volume XV.
- **Permanence itself = the durability rule, inherited.** Once knowledge is
  canon, it is permanent because of Volume X's **no-hard-delete** doctrine:
  knowledge is **archived and versioned, never destroyed**. A lesson that is
  later superseded does not vanish — a new version supersedes it and the prior
  version remains in the lineage. This volume does not re-specify that mechanism;
  it *relies on it* as the substrate of institutional permanence and adds the
  organisational rule that **anything promoted to canon is, from that moment, a
  permanent company asset** subject only to the single narrow erasure exception
  (§11).

Permanence is therefore not a feature this volume builds — it is a **property
this volume depends on and an organisational commitment this volume makes**: what
the company learns, it keeps.

---

## 6. How mistakes become lessons (the blameless post-mortem pipeline)

A company that only remembers its successes learns half of what it could. The
most valuable lessons are the expensive ones. This volume owns the pipeline that
turns a failure into a **permanent guardrail** — never a blame record.

```
   FAILURE / INCIDENT EVENT                         A PERMANENT GUARDRAIL
   (a wrong call, an incident,    ┌──────────────┐  ┌────────────────────────┐
    a missed SLA, a bad outcome)──▶│ BLAMELESS    │──▶│ a "do-not-repeat"      │
    on hq_events (XI)             │ POST-MORTEM  │  │ memory (the lesson)    │
                                  │ what happened│  │            +           │
   the decision record that       │ why · what we│  │ a PROCEDURAL UPDATE so │
   led there (Volume XV) ─────────▶│ change       │  │ the next actor RECALLS │
                                  └──────────────┘  │ it at the point of need│
   the incident timeline                            └────────────────────────┘
   (Volume XIV) ─────────────────────────────────────────────▶ recall (X) → no repeat
```

- **The trigger is a failure event.** A breach, a reversed decision, a
  customer-impacting error, a missed cadence — each is already a fact on the
  Event Bus (Volume XI). The pipeline subscribes to the *outcome*, not to blame.
- **The post-mortem is blameless by construction.** It records *what happened,
  why, and what we change* — a structured reflection, in the P3 shape (summary,
  reasoning, evidence). It pulls in the **incident timeline (Volume XIV)** and
  the **decision record (Volume XV)** that led to the failure, so the lesson is
  grounded in exactly what was decided and observed. It attributes cause to
  *system and circumstance*, not to an employee's character — the record is a
  guardrail, not a verdict.
- **The output is two permanent memories, not a report filed away.**
  1. A **"do-not-repeat" lesson** — a high-salience `semantic`/`long_term`
     memory naming the failure pattern and the conditions under which it
     recurs.
  2. A **procedural update** — an amendment to the relevant `procedural` canon
     (a playbook) so that the *next* employee facing the same situation
     **recalls the guardrail at the point of need** (loop step 5) and does not
     repeat it (loop step 6). A lesson that does not change a procedure is a
     lesson that will be re-learned the hard way.
- **Promotion is gated.** Because the procedural update changes company canon, it
  crosses the shared-knowledge checkpoint and is **authorised by the decision
  framework (Volume XV)** — the failure becomes canon deliberately, with an owner
  (O2) and an approval reference, never silently.

This is the LEARNING-axis slice of **incident response**, per the
concept-ownership map: the **playbook & rhythm of an incident live in Volume
XIV**, the **override authority in Volume XV**, the **incident KPIs (MTTR) in
Volume XVII** — and **the blameless lesson is owned here**. The failure, properly
metabolised, makes the company permanently stronger.

---

## 7. How best practices spread

Learning that stays with one employee is a private skill; learning that spreads
is **company capability**. This volume owns the policy by which a single
employee's discovery becomes everyone's.

```
   ONE EMPLOYEE'S DISCOVERY                         COMPANY-WIDE CAPABILITY
   a high-salience PRIVATE      ┌───────────────┐   every relevant employee
   procedural memory        ───▶│ PROPAGATION   │──▶ recalls it via the ZONE
   ("this objection-handling   │ POLICY        │   (relationships §7) — by
    approach converts 2×")     │ promote to    │   REFERENCE, not by copy
                               │ department /  │
   proven by outcomes          │ public_hq     │   → when the owner updates
   (Volume XVII) ──────────────▶│ canon (gated, │     the canon, every reader
                               │  Volume XV)   │     sees the update at once
                               └───────────────┘
```

- **The unit of spread is a procedural memory promoted into a zone.** When an
  employee's private `procedural` knowledge (a playbook, a method, a repeatable
  win) earns enough salience and **proves out against outcomes (measured by
  Volume XVII)**, the propagation policy promotes it from `private` to the owning
  **zone** — `department` first, `public_hq` if it generalises company-wide.
- **The zones (relationships §7) are the distribution network.** Each zone has
  **one writer (the owner) and many readers by reference**. Promoting a best
  practice into a zone means *every relevant employee recalls it through the same
  retrieval pipeline* (Volume X) — and because readers consume **by reference,
  never by copy**, the instant the owner updates the canon, every reader sees the
  new version. One write; company-wide effect. *Playbook propagation* is exactly
  this: a procedural memory becoming the zone's canonical method.
- **Promotion is gated and owned.** Crossing from private into a shared zone is
  the shared-knowledge checkpoint again — **authorised by the decision framework
  (Volume XV)**, **operated by the Memory Manager (38)**, owned by the **zone's
  single writer** (only the owner curates that zone's canon, per the ownership
  doctrine). An employee proposes; the zone owner and the gate decide.
- **From discovery to capability.** A Sales objection that one employee handled
  brilliantly today becomes, after reflection and proof, the **company's**
  objection-handling playbook — recalled by every revenue employee in six months,
  long after the originating employee version has been retired (§9). That is how
  a single discovery becomes permanent, shared capability: not by broadcast, but
  by *promotion into a zone that everyone already reads.*

---

## 8. Continuous improvement (the workforce gets smarter)

The loop (§4) improves the *company brain*. This section is how the loop improves
each *employee* — the per-employee feedback cycle that makes the workforce
measurably better over time, and the **ratchet** that converts proven improvement
into greater autonomy.

```
   OUTCOMES & KPIs                  REFLECTED INTO MEMORY            BETTER DECISIONS
   an employee's results,    ┌────────────────────────┐   the employee recalls its
   measured by the KPI tree ─▶│ per-employee reflection │──▶ own lessons + calibrated
   (Volume XVII)             │ on cadence (Volume XIV) │   confidence next time
                             └────────────────────────┘            │
   P3 CONFIDENCE  ─────────────────────▶ CALIBRATION ◀─────────────┘
   (the employee's self-estimate)        confidence vs. REALISED outcome
                                                  │
                                                  ▼
                            THE AUTONOMY-THRESHOLD RATCHET
                  proven calibration → the decision framework (Volume XV)
                  may RAISE this employee's autonomy threshold (more "act",
                  less "ask") — never self-granted, always gated
```

- **The per-employee feedback loop.** An employee's **outcomes and KPIs are
  measured by company intelligence (Volume XVII)** — this volume does *not* define
  the metrics; it consumes them. On the reflection cadence (Volume XIV), those
  outcomes are **reflected into memory** as lessons specific to that employee
  ("when I scored leads this way, conversion was X"), so its *future* decisions
  recall its *past* results.
- **Confidence calibration.** Every AI output carries a **calibrated confidence
  (P3)**. The loop compares that *stated* confidence against the *realised*
  outcome (did the 0.9-confidence call actually succeed 90% of the time?). The
  gap — **calibration drift** — is itself a lesson: a chronically over-confident
  employee learns to lower its estimates; a reliably accurate one earns trust.
  Calibration is the bridge from P3's epistemic self-report to demonstrated
  reliability.
- **The autonomy-threshold ratchet.** This is how improvement compounds. When an
  employee's calibration and outcomes prove out over time, the **decision
  framework (Volume XV) may raise that employee's autonomy threshold** — letting
  it *act* where it previously had to *ask*. Proven learning literally widens
  what an employee is trusted to do alone. The ratchet is **owned by Volume XV**
  (it is an authority change); this volume supplies the *evidence* (the
  calibration record and the outcome history) that justifies the raise. It is a
  **ratchet, not a free dial**: a calibration regression is itself a lesson that
  can lower the threshold again (§13). The company does not just remember more —
  its workforce becomes, demonstrably and durably, more capable.

---

## 9. Institutional knowledge that survives forever

The deepest promise of the LEARNING axis: **the company's knowledge outlives
everything it was learned through.** Employees are re-versioned, directives are
superseded, models are upgraded — and the institutional brain persists, intact,
across all of it.

- **Knowledge outlives any single employee version or retirement.** When an
  employee is re-versioned or retired (**the change/evolution process, Volume
  XVIII**), its *private* experience does not have to die with it: what was worth
  keeping has already been **consolidated and promoted into a zone** (§7), so it
  survives as company canon owned by the zone, not by the departed version. The
  succession rule is therefore an organisational duty of this axis: *before a
  version is retired, its durable lessons are consolidated into canon* — handled
  on the cadence (Volume XIV) and authorised at the checkpoint (Volume XV).
  Retirement of an employee never retires what it taught the company.
- **Knowledge outlives any directive or model upgrade.** A directive sets
  *policy*; canon records *what the company has learned* — the two are distinct,
  so a superseded directive does not erase a lesson. A **model upgrade** is, in
  the store, a re-embedding (Volume X's `embedding_model` versioning) — the
  *knowledge* is untouched; only its index is refreshed. This volume's commitment
  is that **no upgrade and no policy change silently drops institutional
  knowledge**; permanence (§5) holds across the whole decade-plus horizon Volume
  XVIII designs for.
- **The company brain as a permanent asset.** The sum of the zones (§10) is a
  **knowledge graph over institutional memory** — the relationships between
  lessons, decisions, and the experiences that formed them, all carried on the
  store's relationship links (Volume X) and the one event spine (O6). Two
  properties make it trustworthy as it ages:
  - **Provenance.** Every canonical lesson is traceable — through `evidence[]`
    (P3) and `correlation_id` (O6) — to the experiences and decisions that formed
    it. The company can always answer *"why do we believe this, and what taught
    us?"*
  - **Truth maintenance.** As the brain ages, contradictions and staleness are
    actively resolved (§11) so the graph stays *true*, not merely *large*. A
    permanent brain that is never curated decays into a confident liar;
    permanence and governance are two sides of the same commitment.

The company brain is the one asset that compounds for the life of the company.
Everything else can be re-versioned around it; it remains.

---

## 10. The knowledge taxonomy (what the company knows)

What *is* the institutional memory? It is the set of **shared-memory ownership
zones** defined in **relationships §7** — that table *is* the company's
institutional-knowledge map, and this volume treats it as canonical (it does not
re-draw it). Each zone is a domain of company canon with **one writer (the
owner/curator) and many readers by reference**.

| Knowledge domain (zone) | Curated by (single writer) | Read across the company by |
|-------------------------|----------------------------|----------------------------|
| Company / lead intelligence | Intelligence (37) ← Research (13) writes | Qualification (14), Sales (16), CEO (1), COO (2) |
| ICP & qualification rubric | Qualification (14) | Sales (16), Marketing (17), Research (13) |
| Sales playbook & pipeline lore | Sales (16) | Outreach (15), Customer Success (18), COO (2) |
| Brand, content & SEO knowledge | Marketing (17) | Sales (16), Outreach (15), Customer Success (18) |
| Customer health & account history | Customer Success (18) | Support (19), Onboarding (20), Sales (16) |
| Product specs & roadmap | Product (5) | Eng Mgr (6), QA (7), Docs (10), CTO (3) |
| Engineering standards, ADRs, **the Bible** | Documentation (10) | all of Technology, CTO (3) |
| Schema & data catalogue | Database (11) | API (12), DevOps (9), Analytics (22) |
| Pricing, rate cards, cost book | Quote Writer (30) ← Finance (21) | Sales (16), Procurement (36), Cashflow (31) |
| Supplier catalogue & lead times | Procurement (36) | Quote Writer (30), Site Manager (34), Operations (23) |
| UK construction regs (CDM 2015, CIS, Building Safety Act, Part L) | Legal & Compliance (25) | **all**; mandatory for Site (34), Quote (30), Payroll (32) |
| Financial ledgers & forecasts | Finance (21) / Cashflow (31) | CFO (4), Analytics (22), Quote Writer (30) |
| The memory substrate itself (housekeeping) | Memory Manager (38) | — operational owner |

- **Ownership = single-writer canon.** One writer per zone keeps institutional
  knowledge single-source; this is the **ownership doctrine** (relationships §7)
  and the organisational expression of "one writer per zone, readers by
  reference." A best practice (§7) or a lesson (§6) becomes part of a zone only
  by promotion into it, authorised at the checkpoint (Volume XV), and only the
  zone's owner curates its canon.
- **Provenance is intrinsic.** Each zone's canon carries its lineage (the
  consolidated episodes, the decisions, the events) via Volume X's relationship
  links and the one spine (O6) — so every institutional fact knows *where it came
  from*.
- **How the map itself is curated.** The taxonomy is **data, not code** — adding
  a zone, or re-assigning a writer, is a governance act of **company evolution
  (Volume XVIII)** working from the canonical relationships §7, never a change
  this volume makes unilaterally. This volume owns *how knowledge fills and flows
  through the zones*; the *shape* of the map is Volume XVIII's to evolve and
  relationships §7's to record.

---

## 11. Memory governance (truth maintenance)

A permanent, ever-growing brain must also stay **true**. Governance is the
discipline that keeps institutional knowledge honest as it accumulates — and it
is the necessary counterweight to permanence (§5). The *mechanics* of versioning,
archival, and dedupe are Volume X's; this volume owns the **organisational rules
for keeping canon true**.

- **Contradiction / conflict resolution.** When two memories disagree — a newer
  lesson contradicts an older one; two employees' experiences point opposite ways
  — the conflict is resolved by **provenance and recency, not by overwrite**. The
  better-evidenced, more recent, higher-calibration lesson **supersedes** the
  other *as a new version* (Volume X's versioning); the superseded memory remains
  in the lineage (no hard delete) so the company can see *what it used to believe
  and why it changed*. A contested canon that cannot be auto-resolved escalates
  to its **zone owner** and, if needed, up the **decision framework (Volume
  XV)** — truth disputes about canon are decided by an owner, never by the loudest
  write.
- **Staleness.** Institutional canon never *auto*-expires (it is the brain), but
  it can go **stale** — true once, untrue now. The **stale-brain canary** (canon
  never reinforced/recalled in N months, from the Memory Manager's golden
  signals, §38) flags candidates for *review*, not deletion: a stale lesson is
  re-validated against current outcomes (Volume XVII) and either reaffirmed (a new
  version) or superseded. Staleness is a prompt to re-learn, never a licence to
  forget.
- **The one narrow break in permanence — GDPR erasure.** Permanence has exactly
  **one** exception, inherited as Volume X's open question: a future
  data-retention/erasure requirement may demand the *hard* deletion of specific
  customer-derived memories. This is the **single** sanctioned break in the
  no-hard-delete rule, and it is tightly bound: **human-gated through the decision
  framework (Volume XV)**, routed via Legal & Compliance (25), executed only as
  Volume X's documented exception path, and fully audited (O6). Lessons
  *generalised* from customer data survive (they hold no personal data); only the
  identifying source memory is erased. This is a compliance carve-out, not a
  general forgetting power — the company forgets a person's data only when the law
  compels it, by a human's hand, on the record.

Governance is what makes permanence *safe*: the company keeps what it learns
**and** keeps it true.

---

## 12. Cross-axis seams

The LEARNING axis is orthogonal to the other four but touches each at a precise
seam. Per the concept-ownership map, each side owns only its slice; this volume
cites the others by **volume + named concept**, never by section number.

| Seam | Volume XVI owns | The other axis owns |
|------|-----------------|---------------------|
| **TIME** | *That* reflection, consolidation, and review *happen* and *what they produce* | *When* they fire — the **cadence/lifecycle (Volume XIV)**; the learning loop's every periodic step hangs on the operating clock |
| **AUTHORITY** | *That* a lesson is **promoted** to canon and the evidence for it | *Whether* it may be — the **decision rule / approval gate (Volume XV)**; every promotion and every autonomy-ratchet step is authorised there |
| **MEASUREMENT** | *That* outcomes feed reflection and calibration | *The numbers* — the **metric / dashboard (Volume XVII)**; KPIs, learning-velocity and calibration metrics are measured there, consumed here |
| **CHANGE** | *That* a retired employee's lessons survive as canon | *The lifecycle* of versioning/retirement — the **change/evolution process (Volume XVIII)**; succession durability is designed there, fed by canon here |
| **The store (substrate)** | *What* the company learns and *how* knowledge becomes canon organisationally | The **Shared Memory engine (Volume X)** and the **Memory Manager (38)** — the store and its housekeeping |

The seam discipline is the whole point of orthogonality: this volume never sets a
cadence, never grants an authority, never defines a metric, never re-versions an
employee, and never touches a table. It **learns**; the others **time, authorise,
measure, evolve, and store.**

---

## 13. Failure & recovery

What happens when the learning model itself breaks. Each failure is recoverable
*because* of the inherited durability rule (no hard delete) and the one audit
spine (O6).

| Failure | What it looks like | Recovery |
|---------|--------------------|----------|
| **A wrong lesson is canonised** | A confidently-promoted lesson is later shown false; employees recall and act on it | It is **superseded by a corrected version** (Volume X versioning), never erased — the company keeps the record of the error and its correction (a meta-lesson). The blameless pipeline (§6) post-mortems *how the bad lesson passed the checkpoint* and tightens the gate (Volume XV). |
| **Knowledge decay / stale brain** | Canon goes untrue with age; the **stale-brain canary** (§38) fires | The flagged canon enters **review** (§11): re-validated against current outcomes (Volume XVII), then reaffirmed or superseded. Staleness is surfaced loudly (the canary is never quiet), never left to rot silently. |
| **A contested canon** | Two zones or employees assert conflicting truth | Resolved by **provenance + recency** (§11); if unresolved, it escalates to the **zone owner** and up the **decision framework (Volume XV)**. The contest itself is recorded — the company can see what was disputed. |
| **Over-promotion** | Too much private experience is pushed to canon; the brain bloats with low-value "lessons" | The checkpoint (Volume XV) is the brake — promotion is gated and owned (O2). The Memory Manager's (38) **dedupe and consolidation** keep the corpus dense; an over-promotion pattern is itself a lesson that raises the salience bar for future promotions. |
| **A broken loop (recall fails)** | Lessons exist but are not recalled at the point of need; **lesson-reuse rate** (§14) collapses | This is the cardinal learning failure — storage without learning. It surfaces as a reuse-rate breach (measured by Volume XVII) and is treated as an incident (Volume XIV); the fix is in the retrieval pipeline (Volume X), not a second store here. |

The throughline: **no learning failure is unrecoverable, because nothing is ever
truly lost** (no hard delete) and **everything is on the record** (O6). The
company can always reconstruct what it believed, when, why, and how it corrected.

---

## 14. Observability

How the health of the *learning model itself* is seen. This volume names the
signals; **company intelligence (Volume XVII) measures them** (O4 — every metric
is a projection of `hq_events`, never a parallel number), and several ride the
Memory Manager's existing golden signals (§38).

- **Learning velocity** — the rate at which experiences become canon (lessons
  consolidated and promoted per period). Too low: the company is not learning.
  Too high without proof: it may be over-promoting (§13).
- **Lesson-reuse rate** — the headline metric: how often canon is actually
  *recalled and used* at the point of need (recalled ids appearing in
  `evidence[]`, P3). A lesson that is never reused is storage, not learning; this
  is the truest measure that the loop (§4) is closing.
- **Calibration drift** — the gap between stated P3 confidence and realised
  outcomes, per employee and company-wide (§8). The signal that drives the
  autonomy ratchet — and the alarm when an employee's self-knowledge degrades.
- **The stale-brain canary** — canon never reinforced/recalled in N months (the
  Memory Manager's signal, §38). Surfaced on The Pulse (Volume XI); the trigger
  for the staleness review (§11).
- **Promotion approval rate** — the share of private→shared promotions approved
  on first ask. A high rate signals the company proposes durable, true canon; a
  falling rate signals noise reaching the checkpoint.

These let a human (and the board) answer *"is the company actually getting
smarter, and is its brain still true?"* — the health of the LEARNING axis itself,
measured by Volume XVII, never by a number this volume maintains.

---

## 15. Conflicts resolved

This volume is where **conflict C6** is closed at the *organisational* level.

**C6 — "memory is a table + UI, not a live substrate."** The Shared Memory engine
(Volume X) resolved C6 at the *substrate* level: memory became AI-writable, typed
across five classes, semantically searchable, with retrieval, consolidation, and
expiry engines — a living store, not a CRUD screen. **Volume XVI is the
organisational expression of that same resolution**: memory is not just a *live
store* but the **live substrate the company learns through.** Every section above
is C6 made organisational — the loop (§4) treats memory as the medium of
learning; permanence (§5) treats it as an asset that only grows; the post-mortem
pipeline (§6), best-practice propagation (§7), and the improvement loop (§8) are
all *the company thinking with its memory in real time.* C6 is fully closed only
when memory is both a live substrate (Volume X) **and** the thing a company
*learns through* (this volume). It also **contributes to C2/P4** (promotion to
canon and the autonomy ratchet route through the autonomy test's approval path,
Volume XV) and **to C5/O6** (every learning step is one event on the single audit
spine).

---

## 16. Open questions

What a future CEO Directive must still decide before this axis is implemented:

1. **The promotion bar for canon.** What salience, evidence, and calibration
   thresholds must a lesson clear before it is *proposed* to the checkpoint —
   and which narrow, low-risk knowledge types (e.g. departmental procedural
   playbooks) may a future scoped `memory.write.shared` grant let canonise
   *without* a manual gate (the Volume X / Memory Manager (38) open question)?
   The default remains: gated, never self-granted.
2. **Reflection cadence.** How often, and on which triggers, does each employee
   and each department reflect? This is a **cadence to be set by company
   operations (Volume XIV)**; this volume only asserts that reflection must
   *happen* on a rhythm, not its period.
3. **The autonomy-ratchet criteria.** Exactly what calibration and outcome record
   justifies raising (or lowering) an employee's autonomy threshold — and how
   fast the ratchet may move. The *decision* is **owned by the decision framework
   (Volume XV)**; the *evidence standard* is the open item.
4. **GDPR hard-erasure path.** The single sanctioned break in permanence (§11)
   inherits Volume X's open question and must be specified — human-gated, via
   Legal & Compliance (25), audited — before any customer-derived memory can ever
   be hard-deleted.
5. **Cross-employee lesson attribution.** When a lesson is consolidated from many
   employees' experiences, how is credit (and the calibration signal) attributed
   back for the improvement loop (§8)? Flagged, not resolved.

---

*Volume XVI of the CrewFlow Bible — the Operating Model layer. Architecture only
— no code, no production change, no migration, no PR. Composes the AI Substrate
(IX–XIII) and the AI Workforce (Layer 4); re-implements neither.*
