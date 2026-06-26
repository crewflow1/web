# CrewFlow Governance

> **Status:** Governance records. This directory holds the **meta-doctrine** — the
> rules about how CrewFlow's own decisions are numbered, recorded, and frozen. It is
> created under CEO Directive **#011** (*Governance, Numbering & Scope
> Reconciliation*; Master Roadmap **D-01**).

These records sit one level above the Bible volumes: the volumes describe *what* the
system is, the governance records describe *how decisions about it are tracked*.

## Contents

- **[`numbering.md`](./numbering.md)** — the **canonical** source of truth for
  directive numbers, ADR numbers, and volume numbering. Resolves the five
  conflicting numbering schemes; where any branch, commit, tag, comment, or older
  doc disagrees, this file wins.
- **[`architecture-freeze.md`](./architecture-freeze.md)** — the platform contracts
  that are **architectural foundations** (Event Spine, Shared Memory, AI SDK,
  RunContext, Task Engine, Approval Engine, Communication Layer, Capability Registry,
  Boardroom interfaces, Shared Communication Protocol), each honestly status-tagged
  (Established / Partial / Reserved), and the rule that **changing any of them
  requires an ADR + an architectural review** in the same PR.
- **[`runtime-identity.md`](./runtime-identity.md)** — a **record** (not a decision)
  of the current runtime `actor_id` slugs the 14 seeded employees stamp on the Event
  Spine, where they diverge from the specs and the SDK volume (the qualification
  three-way split), and why the canonical identity decision is **deferred** to the
  AI SDK directive (D-04 / #014). `design-ai` is recorded as **Reserved**.
- **[`directive-012-completion-report.md`](./directive-012-completion-report.md)** —
  the permanent **engineering record** of a completed directive: CEO Directive
  **#012** (Master Roadmap **D-02**), *The Generic Task Engine*. Records the
  objectives met, deferred work, technical debt, architecture assessment, platform
  maturity, lessons, metrics, risks, and roadmap adjustments. The companion
  migration dashboard lives in the workforce canon
  ([`../workforce/platform-compatibility-matrix.md`](../workforce/platform-compatibility-matrix.md)).
- **[`directive-012-platform-independence-audit.md`](./directive-012-platform-independence-audit.md)** —
  the closing **verification audit** of Directive **#012**: a four-question check,
  each backed by `file:line` repository evidence, proving the Task Engine substrate is
  employee-agnostic (removing either live employee leaves the OS substrate unchanged)
  before platform expansion continues into Directive #013. Names the one residual gap:
  four scattered registration surfaces with no single declarative Employee Registry.
- **[`platform-reuse-index.md`](./platform-reuse-index.md)** — a **standing
  architectural-health metric**, appended to for every future directive. Records five
  components per directive (platform capabilities added · existing capabilities reused ·
  employee-specific code added · infrastructure removed · platform-vs-employee trend) to
  make the CEO's thesis — *platform capability grows, employee complexity shrinks* —
  visible and auditable over time. Inaugurated with the Directive #012 entry.
- **[`directive-013-dependency-ordering-analysis.md`](./directive-013-dependency-ordering-analysis.md)** —
  a **dependency analysis & recommendation** (not a decision; renumbers nothing)
  answering whether a **Capability Registry can be designed before the `RunContext`
  contract**. Across the eight named dimensions (identity · capability/permission
  propagation · cancellation · deadlines · budget · correlation · SDK contracts) the
  dependency is **asymmetric** — the registry depends on the runtime contract, not the
  reverse — so it recommends **Option B**: `RunContext` contract → AI SDK → Capability
  Registry, and recommends the CEO update the roadmap before any #013 implementation.
- **[`directive-013-runcontext-architecture-proposal.md`](./directive-013-runcontext-architecture-proposal.md)** —
  the **architecture proposal** (design only; **held** pending CEO approval; no
  implementation) for **Directive #013 / D-03 — the RunContext Runtime Contract**.
  Answers the CEO's review questions one-by-one (what RunContext is · the fields it owns
  and deliberately does not · its relation to the Task Engine, the AI SDK, identity, and
  permissions/capabilities · how it propagates correlation, budget, deadlines, and
  cancellation · its interaction with Shared Memory · what defers to #014/#015 · the ADR,
  tests, and migrations required · what would make it over-engineered). Its thesis: #013
  is mostly **binding inert seams the Task Engine already reserved** (`deadline_at`, the
  `cancelled` status/transition, `required_capability`, `correlation_id`, `cost_budget_micros`),
  so the schema delta is **one `SECURITY DEFINER` cancel function and zero new columns**.

## Related, outside this directory

- **[`../../crewflow-v1.0-constitution.md`](../../crewflow-v1.0-constitution.md)** —
  the **CrewFlow Version 1.0 Constitution**: the acceptance contract answering *"what
  must exist before CrewFlow OS V1.0 can be declared complete?"* It is **not** part of
  the Bible, the ADRs, or the Roadmap — it is the finish line they are all measured
  against — so it lives at the `docs/` root, not under `governance/`. The Architecture
  Freeze feeds it: a contract earns its `crewflow-*-v1.0` tag here, the platform earns
  **CrewFlow OS V1.0** there.

---

*Documentation only. Nothing here changes code, schema, or configuration.*
