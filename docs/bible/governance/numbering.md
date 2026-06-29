# CrewFlow Governance — Directive, ADR & Volume Numbering (canonical)

> **Status:** Canonical governance record. This file is the **single source of
> truth** for how CrewFlow's CEO Directives, Architecture Decision Records, and
> Bible volumes are numbered. Where any branch name, commit message, tag, code
> comment, directory label, or older document disagrees with this ledger, **this
> ledger wins.**
>
> **Issued under:** CEO Directive **#011** — *Governance, Numbering & Scope
> Reconciliation* (Master Roadmap **D-01**). Documentation only: this change
> renames nothing in code, runs no migration, and rewrites no git history.

---

## 1. Why this exists

By mid-2026 the same body of work was being numbered five different ways at once,
and the schemes contradicted one another:

1. **The roadmap governance ledger** (`docs/roadmap.md`) — thing-name first, with
   `001–005` + `003.5`; it labelled the Shared Memory Engine **#002**.
2. **The Bible README ledger** (`docs/bible/README.md`) — `001–005`, with a note to
   "begin new assignments at **#006**."
3. **The Bible directory self-labels** — the substrate/workforce volumes referred to
   themselves as **#007 Workforce**, **#008 Operating-model**, **#009
   Shared-Memory-build**.
4. **Branch / commit / tag labels** — the Shared Memory Engine shipped on
   `directive/009-shared-memory` with commits and a tag reading **"Directive 009 ·
   Module 1"**; CI-harness work used `directive-008/*`; the conversion substrate uses
   `directive/010-*` and commits reading **"CEO Directive 010, Phase 2/3/4"**.
5. **The adoption-analysis recommendation** (`docs/bible/adoption-analysis.md` §9) —
   a *proposed* forward sequence (#006 Bible Adoption → #007 SDK → #008 Event Bus →
   #009 Design → #010 Conversion Arc → #011 Boardroom → …).

The headline collisions: **#002 vs #009** for one engine; the first operational
employee mislabelled **#004** in one brief when #004 is the Event Spine; **#008**
used by three different things; and a *recommended* sequence that never matched what
was actually issued. A constitution cannot contradict itself, so D-01 fixes **one**
canonical scheme and records every other label as an alias.

---

## 2. The canonical model

1. **The thing-name is the identity.** "Shared Memory Engine", "The Conversion Arc",
   "Company Research AI" are stable forever. The directive **number is metadata** for
   ordering and citation, not the primary key. When in doubt, cite the thing-name.
2. **Numbers are monotonic from #011 and never reused.** Every directive issued from
   D-01 onward takes the next free integer. Retired numbers (§4) and skipped numbers
   (§4) stay dead — they are never backfilled, reassigned, or recycled.
3. **No new half-integers.** `#003.5` ("Lock the Foundation") is a frozen historical
   artifact. Future directives are whole integers only.
4. **History is immutable; the ledger is authoritative.** Branch names, commit
   messages, tags, and in-code comments are permanent artifacts of when they were
   written. We **do not** rewrite them. Where they disagree with this ledger, the
   ledger is correct and the old label is recorded here as an alias.
5. **ADR numbers are a separate sequence** (§5). They have nothing to do with
   directive numbers.
6. **Volume numbers are governed by principle, not renumbered en masse** (§6).

---

## 3. Canonical directive ledger

| # | Thing-name (canonical) | What it governs | Status | Aliases / other labels |
|---|---|---|---|---|
| **001** | AI Employee Framework / AI Boardroom | The roster + `ai_employees` table; framework + seed. | Issued · framework + seed built; Boardroom orchestration pending | — |
| **002** | *(retired number)* | — | **Retired** — do not reuse | Was used briefly as an early label for the **Shared Memory Engine**; that engine's canonical number is **#009** (see below). |
| **003** | HQ Sales AI programme | Umbrella for the Sales-AI module sequence. | Issued · Modules 1–3 shipped | — |
| **003.5** | Lock the Foundation | Freeze Architecture v1.0 + the governance "programme pack". | Issued (historical half-integer) | commit `6d63d60` |
| **004** | Engineering Bible / Event Spine / six-gate CI | The frozen `hq_sales_*` reservation, the Event Spine, the six-gate CI bar. | Issued · Spine core (PR1–PR5) shipped; PR6/PR7 pending | **Mislabel of #005:** the Pulse (Spine PR5) code header in `lib/events/categories.ts` cites "CEO Directive #005, PR5" — that work is part of the Event Spine, i.e. **#004**. Code comment left as-is (Rule 4); the meaning is recorded here. |
| **005** | Company Research AI | The first **operational** AI employee (Sales Module 2). | Issued · shipped | One early brief called "the first AI employee" **#004**; that collides — #004 is the Event Spine, the first executing employee is **#005**. |
| **006** | *(reserved — never issued)* | — | **Skipped** — do not reuse | `adoption-analysis.md` §9 *recommended* "#006 Bible Adoption / Constitution". Never issued as a directive; that governance work is **#011**. |
| **007** | *(reserved — never issued)* | — | **Skipped** — do not reuse | Bible workforce volume self-labelled "#007 Workforce"; adoption-analysis §9 recommended "#007 AI Employee SDK". Never issued. |
| **008** | *(reserved — never issued)* | — | **Skipped** — do not reuse | Used only as branch/dir names (`directive-008/architecture-blueprint`, `directive-008/ci-postgres-harness`), a Bible "#008 Operating-model" self-label, and an adoption-analysis "#008 Event Bus" recommendation. Never a numbered directive. |
| **009** | Shared Memory Engine | The company brain (`queue → embed → store → ANN → recall`), lifecycle, `forget`, and the first SDK facet `ctx.memory`. | Issued · shipped (PR #183, tag `crewflow-shared-memory-v1.0`); **prod migration gated** | The roadmap ledger labelled it **#002**; it shipped on `directive/009-shared-memory` with commits/tag reading "Directive 009 · Module 1". **#009 is canonical.** |
| **010** | The Conversion Arc | The Approval Engine, Draft Generation, and Communication Layer substrate, plus Outreach AI Phases 1–4. ADRs `0001`–`0003`. | Issued · phases authored; PRs **#187/#188/#189** pending merge to `main` | Branches `directive/010-*`; commits "CEO Directive 010, Phase 2/3/4". |
| **011** | Governance, Numbering & Scope Reconciliation | **This directive.** The canonical numbering ledger, the Architecture Freeze, and the Version 1.0 Constitution. Documentation only. | Issued · in progress | Master Roadmap **D-01**. |
| **012** | Generic Task Engine | One durable, crash-safe, audited work queue (`hq_ai_tasks`) every AI employee runs on — plus the runner SDK, `task.*` spine emission, the memory↔task binding, the reference + second employee migrations, and the unified operator read model. ADRs `0004`–`0006`. | Issued · **architecturally complete** — PR-A…PR-G merged to the `#011` integration branch; cutover to `main` + the production migration are CEO-gated | Master Roadmap **D-02**. Branches `directive/012-*`. Completion record: [`directive-012-completion-report.md`](./directive-012-completion-report.md). |
| **013** | RunContext Runtime Contract | The per-employee runtime contract the runner assembles at claim and threads through every invocation: identity, correlation, budget, deadline, cancellation, and the permission/capability hooks the SDK enforces. Graduates Architecture-Freeze contract **#4 (RunContext)** Partial → Established; **settles** the canonical runtime-identity decision deferred from D-01. ADR `0007`. | Issued · **architecturally complete** — implementation + tests on **PR #206** (base `#011` integration branch); RunContext graduated **Partial → Established**, the qualification three-way split resolved to `lead-qualification`; cutover to `main` + the production migration are CEO-gated | Master Roadmap **D-03**. Previously D-04 bundled RunContext with the SDK; Option B split them, runtime contract first. Completion record: [`directive-013-completion-report.md`](./directive-013-completion-report.md). |
| **014** | AI SDK Envelope | The per-employee SDK envelope assembled over the frozen RunContext, reading the existing `ai_employees` scope columns: the `memory`/`events`/`comms` facets + output envelope (Phase A), the permission **doorman** + P4 gate (Phase B), and the typed **tool registry → executor → application** contract (Phase C). Graduates contract **#3 (AI SDK)** Partial → Established. | Issued · **complete** — Phases **A → B → C** merged to the `#011` integration branch (Phase C on **ADR 0009**; C1–C4 PRs #219/#221/#223/#225, atomicity-rule docs #224). Contract **#3** graduated **Partial → Established** (CEO review, 2026-06-28). The executor rollout into the live run loop and the API gateway + cost metering are a deferred future **extension** of the now-established contract, not part of the complete directive. | Master Roadmap **D-04**. The canon's long-standing "AI SDK directive (D-04 / #014)"; the RunContext contract and the identity decision precede it at **#013**. |
| **015** | Capability Registry | One declarative source of truth + resolver consolidating the scattered employee scope/capability data (`tools_allowed`, `permissions`, `memory_scope`, `department`) and the four registration surfaces named by the platform-independence audit. Graduates contract **#8 (Capability Registry)** Reserved → Established. | **In progress (D-05) · R1–R4 established; legacy-removal phase under way in independently-reviewed increments — LR1–LR4 merged; the LR5 Proposal (legacy-removal sequence) reviewed, approved and merged; LR5.1 (retire compatibility writes) merged; LR5.2 (migrate the legacy read paths) merged; LR5.3 (retire the rollback mechanism) merged; LR5.4 (remove the legacy authority columns) authorised as the fourth removal increment** | Master Roadmap **D-05**. Sequenced **last** by the dependency analysis: it consolidates what #013/#014 settle. |
| **016 – 029** | *(reserved)* | Master Roadmap **D-06 … D-19** (see §7). | Planned | Reserved by the Master Roadmap; not yet issued. |

**Next free number beyond the current roadmap: `#030`.** (Within the roadmap, D-02 =
**#012**, D-03 = **#013** and D-04 = **#014** are issued — #012/#013 architecturally
complete, **#014 complete**; the next directive to be *issued* is D-05 = **#015** — the
Capability Registry, which consolidates what #013/#014 settle.)

---

## 4. Retired and reserved numbers (do not reuse)

- **Retired:** `#002` — collapsed into the Shared Memory Engine's canonical `#009`.
- **Skipped / never issued:** `#006`, `#007`, `#008` — these appear only as
  recommendations, directory self-labels, or branch names. They were never issued as
  directives and are **not** backfilled. Numbering proceeds monotonically past them.

The point of recording dead numbers explicitly is that a future reader who finds
"Directive 008" in a branch name can resolve it here instead of assuming a directive
exists.

---

## 5. ADR numbering (separate sequence)

Architecture Decision Records live in [`../decisions/`](../decisions/) and use their
own four-digit sequence `NNNN-title.md`, **independent of directive numbers**. An ADR
records *one* major architectural decision (the "document before you build" rule in
[`../README.md`](../README.md)); a directive may spawn several ADRs.

| ADR | Title | Under directive |
|---|---|---|
| [`0001`](../decisions/0001-approval-engine.md) | The Approval Engine | #010 (The Conversion Arc) |
| [`0002`](../decisions/0002-draft-generation.md) | Draft Generation | #010 |
| [`0003`](../decisions/0003-communication-layer.md) | Communication Layer | #010 |
| [`0004`](../decisions/0004-generic-task-engine.md) | The Generic Task Engine | #012 (D-02), PR-A |
| [`0005`](../decisions/0005-task-engine-spine-emission.md) | Task Engine spine emission (the `task.*` verbs) | #012 (D-02), PR-B |
| [`0006`](../decisions/0006-memory-task-binding.md) | Shared Memory ⇄ Task Engine binding (the `bound_task_id` FK) | #012 (D-02), PR-D |
| [`0007`](../decisions/0007-runcontext-runtime-contract.md) | The RunContext Runtime Contract | #013 (D-03) |
| [`0008`](../decisions/0008-ai-sdk-envelope.md) | The AI SDK Envelope *(Accepted)* | #014 (D-04) |
| [`0009`](../decisions/0009-sdk-executor-apply-on-approval.md) | SDK Executor and Apply-on-Approval Runtime *(Accepted)* | #014 (D-04), Phase C |
| [`0010`](../decisions/0010-capability-registry.md) | The Capability Registry *(Accepted)* | #015 (D-05) |

**Next free ADR number: `0011`.** ADR numbers are also monotonic and never reused. ADR
`0008` is **Accepted** (CEO independent CTO review, 2026-06-27) and ADR `0009` (SDK Executor
and Apply-on-Approval Runtime) is **Accepted** (CEO independent CTO review, 2026-06-28);
Directive #014 shipped under per-phase review gates as Phases **A → B → C**, all **merged**.
Phase C was built in small reviewable increments **C1 → C2 → C3 → C4** (phases not merged
together): **C1** (the typed tool registry contract, PR #219), **C2** (the executor contract,
PR #221), **C3** (the apply-on-approval marker, PR #223) and **C4** (the executor **Reference
Path** validation, PR #225 — plus the Application Atomicity Rule docs #224) are **all merged**
(2026-06-28). **C4 completed Phase C, and Phase C completes Directive #014** (CEO review,
2026-06-28); contract **#3** graduated **Partial → Established**. The executor rollout into the
live run loop and the API gateway + cost metering are a deferred future **extension** of the
now-established contract. On acceptance the CEO set the permanent **Executor Boundary Rule**; on
the **C1** review the **Registry Immutability Rule**; on the **C2** review the **Executor
Idempotency Rule**; on the **C3** review the **Application Atomicity Rule**; and on the **C4**
review the **Reference Implementation Rule** (the completion-and-sequencing complement to the
earlier **Reference Path Rule**) — all homed in the [Kernel Contract Map](./kernel-contract-map.md)
§2.

ADR `0010` (the **Capability Registry**, Directive **#015 / D-05**) is **Accepted** — written under
the strict *document-before-you-build* gate ahead of any #015 code, defining the nine areas the CEO
required (authority ownership · registry boundaries · grant model · inheritance model · migration
strategy · runtime resolution model · interaction with the Tool Registry · interaction with the SDK ·
interaction with the API Gateway), and accepted on independent CTO review with one amendment (the
**Approval Ratchet Rule**). On the #015 architecture review the CEO set the permanent **Single Source
of Authority Rule** as the directive's governing principle; on the **R1 (Registry Schema)** review the
**Migration Parity Rule**; on the **R2 (Backfill + Parity Gate)** review the **Behaviour
Preservation Rule**; on the **R3 (runtime resolver + SDK read integration)** review the **Shadow
Validation Rule**; on the **R4 (runtime authority switch)** review the **Rollback Readiness Rule**;
on the **Legacy Removal Proposal** review the **Evidence Before Deletion Rule**; on the **LR1
(registry-native authoring)** review the **Mirror Integrity Rule**; on the **LR2 (registry-native
memory scope)** review the **Registry Completeness Rule**; on the **LR3 (runtime read-path
migration)** review the **Compatibility Layer Rule**; on the **LR4 (production-confidence
audit)** review the **Retirement Readiness Rule**; on the **LR5 Proposal (the legacy-removal
sequence)** review the **Removal Sequencing Rule**; on the **LR5.1 (retire the capability
mirror)** review the **Read Migration Rule**; and on the **LR5.2 (migrate the legacy read paths)**
review the **Rollback Independence Rule**; and on the **LR5.3 (retire the rollback mechanism)** review
the **Data Removal Rule** (all fourteen homed in
the [Kernel Contract Map](./kernel-contract-map.md) §2). Implementation proceeds
slice by slice, each gated on review of the last — **R1 (Registry Schema), R2 (Backfill + Parity
Gate), R3 (runtime capability resolver + SDK read integration) and R4 (runtime authority switch —
registry authoritative, legacy retained for rollback) are established**. The remaining work is the
**legacy-removal phase**, whose **design proposal** — production-confidence requirements, removal
criteria, rollback-retirement conditions, migration-cleanup sequence, operational safety checks —
has been **reviewed and approved**; the phase now proceeds in **independently-reviewed removal
increments**, each separately authorised and removing nothing until the Evidence Before Deletion
Rule's conditions are met: **LR1 (registry-native authoring)** is **merged** (PR #239); **LR2**
(route every administrative capability write through registry-native authoring; close the direct
legacy authoring paths — the **Mirror Integrity Rule**) is **merged** (PR #241); **LR3** (migrate
the remaining runtime read paths off legacy authority so every dimension is **served** solely by the
registry — the **Registry Completeness Rule**) is **merged** (PR #243); **LR4** (demonstrate
sustained production confidence; continue parity monitoring and rollback readiness; validate the
registry-only runtime under production conditions; prepare compatibility-retirement evidence — the
**Compatibility Layer Rule**) is **merged** (PR #245), banking the production-confidence evidence in
the [LR4 evidence ledger](./directive-015-lr4-production-confidence-evidence.md) via a read-only
confidence audit — removing nothing; and the **LR5 Proposal** (design only: the
compatibility-retirement sequence, the rollback-retirement sequence, the legacy-column removal order,
cleanup validation, and final migration-completion criteria) is **reviewed, approved and merged** (PR
#247). On its review the CEO set the **Removal Sequencing Rule** (the order a teardown must follow —
writes, then rollback, then stored data, then tooling, then completion; PR #248) and authorised the
first removal increment: **LR5.1 (retire the compatibility writes: stop the mirror so
`ai_employees.tools_allowed` / `permissions` go inert, while retaining the columns, the legacy reads,
rollback, the confidence audit and the parity tooling)**, now **merged** (PR #249). On the **LR5.1**
review the CEO set the **Read Migration Rule** (during retirement, write paths migrate before read paths;
no read path is removed until every remaining consumer has been identified, migrated and independently
validated; reader migration is evidence-driven, not assumption-driven) and authorised **LR5.2 (migrate
the remaining legacy read paths — every runtime and administrative consumer of the now-inert columns —
onto the registry, while preserving rollback, parity verification, confidence monitoring and the
compatibility instrumentation)** as the **second removal increment**, now **merged** (PR #251). On the
**LR5.2** review the CEO set the **Rollback Independence Rule** (rollback mechanisms must be removable
independently of the legacy implementation they protect; before rollback infrastructure is retired,
production must demonstrate that continued operation no longer depends on rollback activation; rollback
retirement must itself be independently reviewed and validated) and authorised **LR5.3 (retire the
rollback mechanism — prove stable operation without rollback, then retire the `CAPABILITY_AUTHORITY_SOURCE`
lever and the on-demand legacy-serving path it gates — while preserving confidence auditing, parity
instrumentation, the legacy columns and the migration history)** as the **third removal increment**, now **merged** (PR #253). On the
**LR5.3** review the CEO set the **Data Removal Rule** (data may be physically removed only after all
write paths, all read paths and rollback are retired, production confidence has been demonstrated and
retirement evidence has been independently reviewed; physical deletion is always the final
implementation step) and authorised **LR5.4 (remove the now-inert legacy authority columns — drop
`ai_employees.tools_allowed` / `permissions`, remove the obsolete registry-mirror and compatibility
code, re-point the runtime fail-safe to a default-deny floor — while preserving the migration history,
the production-confidence evidence and the operational audit history, and retaining `memory_scope` and
`department`)** as the **fourth removal increment**. The legacy authority columns come down in LR5.4 as
the final implementation step; the parity tooling and the final migration validation follow, and gate
the directive's completion.
Contract **#8 (Capability Registry)** graduates Reserved → Established only on #015 completion (after
the legacy-removal phase).

---

## 6. Volume numbering (principle only — no mass renumber)

The Bible canon has known internal collisions (two "Volume VII", two "Volume VIII");
`adoption-analysis.md` §2/§4 and Appendix A describe a proposed canonical map. D-01
**approves the governance principle, not a bulk renumber:**

- There is **one** canonical volume map (adoption-analysis Appendix A) that volumes
  migrate **toward** as they are next edited — no flag-day rewrite.
- Until a volume is touched, its existing header stands; a reader resolves collisions
  via Appendix A.
- New volumes follow Appendix A's scheme from creation.

This keeps the cost proportional: the meaning is pinned now; the headers converge
naturally rather than through one high-churn, history-noisy commit.

---

## 7. Master Roadmap mapping (D-01 … D-19 → #011 … #029)

The CrewFlow Version 1.0 Master Roadmap is the live forward plan. Its directives map
to canonical numbers by a fixed offset — **D-_N_ = #(010 + _N_)**:

| Roadmap | Canonical # | Roadmap | Canonical # |
|---|---|---|---|
| D-01 | **#011** *(this directive)* | D-11 | #021 |
| D-02 | #012 | D-12 | #022 |
| D-03 | #013 | D-13 | #023 |
| D-04 | #014 | D-14 | #024 |
| D-05 | #015 | D-15 | #025 |
| D-06 | #016 | D-16 | #026 |
| D-07 | #017 | D-17 | #027 |
| D-08 | #018 | D-18 | #028 |
| D-09 | #019 | D-19 | #029 |
| D-10 | #020 | | |

The earlier `adoption-analysis.md` §9 sequence (#006–#013) was a *recommendation* made
before the roadmap existed; it is **superseded** by the table above for anything not
yet issued. (Its #010 = "Sales Conversion Arc" happens to match what was actually
issued as #010; its #011 = "AI Boardroom" does **not** — actual #011 is this
governance directive.)

**Forward thing-names (approved, not yet issued).** The mapping offset above is
unchanged, but the three next roadmap slots now carry **assigned thing-names**, recorded
in §3: **D-03 / #013 = RunContext Runtime Contract**, **D-04 / #014 = AI SDK Envelope**,
**D-05 / #015 = Capability Registry**. The names and their order were settled by the
CEO-approved [dependency-ordering analysis](./directive-013-dependency-ordering-analysis.md)
(Option B — runtime contract → SDK → registry). No historical directive is renumbered;
only the forward sequence is recorded.

---

## 8. How to issue the next directive

1. Take the **next free integer** (today: D-03 = `#013`; beyond the roadmap: `#030`).
2. Add a row to §3 with the thing-name, scope, and status `Issued · in progress`.
3. Name the branch `directive/NNN-<slug>`; the canonical number and the branch number
   should agree from here on (the historical mismatches above are frozen, not fixed).
4. If the directive makes a major architectural decision, write its ADR(s) under the
   next free `decisions/NNNN-*` number **in the same PR** (the document-before-build
   rule).
5. On merge, update the status here and append a row to the living tracker in
   [`../adoption-analysis.md`](../adoption-analysis.md).

---

*Documentation only. No code, schema, configuration, or git history was changed by
this record. Adopted under CEO Directive #011 (Master Roadmap D-01).*
