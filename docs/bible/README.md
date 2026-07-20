# The CrewFlow Bible

> **Status:** Constitutional document. This directory is the in-repo home of the
> CrewFlow Bible — the single source of truth for every future engineering
> decision, as ratified by the CEO on adoption (2026-06-21).
>
> **The Bible is doctrine, not a backlog.** Nothing here is implemented until an
> explicit CEO directive instructs it. Reading the Bible never authorises building
> from it.

---

## What this is

CrewFlow is building toward an **AI operating system for UK construction
companies** — a platform customers run their business on, an HQ that runs
CrewFlow itself, and a workforce of specialised, permissioned, audited AI
employees. The Bible captures **why the system exists**, not just how it was
implemented. Over time it is intended to grow into a true engineering manual
(1,000+ pages), more valuable than the code because it preserves the reasoning.

This directory holds:

- **[`adoption-analysis.md`](./adoption-analysis.md)** — the inaugural artifact:
  an evidence-grounded study of the Bible against the actual codebase (executive
  summary, contradictions, missing systems, duplications, improvements, a
  volume-by-volume comparison, a percentage-built estimate, the implementation
  dependency graph, the recommended directive sequence, and the decisions to make
  before more code is written).
- **[`decisions/`](./decisions/)** — Architecture Decision Records (the "document
  before you build" rule, below). Three are recorded — `0001` Approval Engine,
  `0002` Draft Generation, `0003` Communication Layer (all under Directive #010);
  the next free number is `0004`. ADR numbering is governed by
  [`governance/numbering.md`](./governance/numbering.md) §5.
- **[`governance/`](./governance/)** — meta-doctrine: the **canonical** directive /
  ADR / volume numbering ledger that resolves the repo's historical numbering
  collisions. Where any branch, commit, tag, comment, or older document disagrees,
  the ledger wins.

The full text of the twelve volumes is the CEO's canonical copy; this directory
analyses and operationalises it, and is where the renumbered canon (Appendix A of
the analysis) will live once ratified.

---

## The volumes (as provided)

The adopted canon has internal numbering collisions (two "Volume VII", two
"Volume VIII"); see `adoption-analysis.md` §2/§4 and Appendix A for the proposed
map, and [`governance/numbering.md`](./governance/numbering.md) §6 for the governing
principle (volumes migrate toward Appendix A as they are next edited — no flag-day
renumber). As provided:

| # | Volume |
|---|---|
| Prelude | Vision 2030 · Philosophy |
| I | Vision 2030 |
| II | Product |
| III | CrewFlow HQ |
| IV | AI Employees / The AI Workforce |
| V | Database Architecture |
| VI | API Architecture (Part 2 — *Part 1 not yet written*) |
| VII | Security Architecture |
| VIII | Design System |
| IX | Engineering Standards |
| X | Marketing |
| XI | Sales |
| XII | Master Roadmap |
| VII* | AI Workforce Architecture *(numbering collision)* |
| VIII* | AI Boardroom Architecture *(numbering collision)* |

---

## The rule: document before you build

Per the CEO mandate — *"Every time you make a major architectural decision,
document it before building it."* This operationalises Directive 004's
living-knowledge-base rule:

1. A **major** architectural decision is recorded as an ADR in
   `docs/bible/decisions/NNNN-title.md` **before** the code that implements it.
2. The ADR states: context, the decision, the alternatives weighed, and the
   consequences.
3. No major architectural change merges without its ADR in the **same** PR.

The Bible grows by accretion of these records. The code follows the doctrine, not
the other way around.

---

## Directive ledger (for orientation)

The Bible is governed by CEO Directives. Issued to date (see
`docs/roadmap.md` for detail):

| # | Title | Status |
|---|---|---|
| 001 | AI Employee Framework / AI Boardroom | framework + seed built |
| 002 | *(retired — early alias of #009)* | — |
| 003 | HQ Sales AI programme | Modules 1–3 shipped |
| 003.5 | Lock the Foundation | issued |
| 004 | Engineering Bible / Event Spine / six-gate CI | Spine core shipped |
| 005 | Company Research AI | shipped |
| 009 | Shared Memory Engine | shipped (prod migration gated) |
| 010 | The Conversion Arc (Approval · Draft · Comms · Outreach) | phases authored; pending merge |
| 011 | Governance, Numbering & Scope Reconciliation | *this directive* |

> **Canonical numbering lives in
> [`governance/numbering.md`](./governance/numbering.md).** The highest issued
> directive is **#010** (The Conversion Arc); the next is issued as **#011** and
> numbering proceeds monotonically from there. `#002` is **retired** — it was an
> early label for the Shared Memory Engine, whose canonical number is **#009**;
> `#006`–`#008` were **never issued** (they survive only as directory self-labels,
> branch names, and an `adoption-analysis.md` §9 recommendation). The earlier
> "begin at #006" guidance is superseded by the canonical ledger.

---

## Relationship to the existing roadmap

`docs/roadmap.md` is the **HQ Sales AI programme** roadmap (narrow: Modules 1–7
of Directive 003 + the Event Spine). It is a **sub-roadmap** of the Bible's
Volume XII master roadmap. When the two are reconciled (decision #8 in the
analysis), this note is where the relationship is recorded.

---

*Adopted 2026-06-21. No implementation proceeds from this document until an
explicit CEO directive instructs it.*
