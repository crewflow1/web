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
- **[`runtime-identity.md`](./runtime-identity.md)** — a **record + resolution** of the
  runtime `actor_id` slugs the 14 seeded employees stamp on the Event Spine, where they
  diverge from the specs and the SDK volume (the qualification three-way split), and the
  canonical identity decision now **settled** by the RunContext Runtime Contract directive
  (D-03 / #013, §7): `lead-qualification` is canonical and history is **frozen, not
  re-stamped**. `design-ai` remains **Reserved**.
- **[`directive-012-completion-report.md`](./directive-012-completion-report.md)** —
  the permanent **engineering record** of a completed directive: CEO Directive
  **#012** (Master Roadmap **D-02**), *The Generic Task Engine*. Records the
  objectives met, deferred work, technical debt, architecture assessment, platform
  maturity, lessons, metrics, risks, and roadmap adjustments. The companion
  migration dashboard lives in the workforce canon
  ([`../workforce/platform-compatibility-matrix.md`](../workforce/platform-compatibility-matrix.md)).
- **[`directive-013-completion-report.md`](./directive-013-completion-report.md)** —
  the permanent **engineering record** of a completed directive: CEO Directive
  **#013** (Master Roadmap **D-03**), *The RunContext Runtime Contract*. Records the
  objectives achieved, objectives intentionally deferred, architectural decisions, the
  runtime-contract summary, implementation + validation summaries, technical debt, risks,
  future recommendations for #014, and lessons learned. RunContext graduates
  Architecture-Freeze contract **#4 Partial → Established**; the canonical runtime identity
  is settled ([`runtime-identity.md`](./runtime-identity.md) §7). Authority: [ADR
  0007](../decisions/0007-runcontext-runtime-contract.md).
- **[`directive-015-completion-report.md`](./directive-015-completion-report.md)** —
  the permanent **engineering record** of a completed directive: CEO Directive
  **#015** (Master Roadmap **D-05**), *The Capability Registry*. Records the full arc — the
  build phase (R1 schema → R2 backfill + parity → R3 pure-resolver shadow → R4 authority switch)
  and the legacy-removal phase (LR1 → … → LR5.4B) — with objectives achieved, deferred work,
  architectural decisions, the runtime-authority summary, implementation + validation summaries,
  technical debt, risks, recommendations for #016, and lessons learned. The Capability Registry
  graduates Architecture-Freeze contract **#8 Reserved → Established** as the permanent production
  authority model; the scattered legacy authority columns (`tools_allowed` / `permissions`) are
  physically removed and the registry is the sole runtime authority. Records the **Final Removal
  Rule** (the 28th §2 standard). Authority: [ADR 0010](../decisions/0010-capability-registry.md).
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
- **[`kernel-contract-map.md`](./kernel-contract-map.md)** — a **permanent engineering
  reference** (not an ADR, not implementation): a single-page overview of the CrewFlow
  Operating System **kernel** — the six frozen contracts every employee inherits (Event
  Spine · Shared Memory · Approval Engine · Generic Task Engine · RunContext · AI SDK),
  each mapped by **Owns / Exposes / Consumes / Explicitly does not own**, plus the four
  boundaries that must not blur. Records the standing **engineering principle** that
  governs them — *kernel contracts grow more stable, employee implementations grow
  easier to change; platform maturity is the stability of the kernel and the simplicity
  of the employees built upon it* — for which [`platform-reuse-index.md`](./platform-reuse-index.md)
  is the metric. Instituted on the completion of Directive #013, before #014
  implementation begins.
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
- **[`directive-014-ai-sdk-envelope-architecture-proposal.md`](./directive-014-ai-sdk-envelope-architecture-proposal.md)** —
  the **architecture proposal** (design only; **held** pending CEO approval; no
  implementation) for **Directive #014 / D-04 — the AI SDK Envelope**. Answers the
  architecture-review questions one-by-one (what the envelope is and what "Partial →
  Established" means · what it owns and deliberately does not · how it **extends** the
  frozen RunContext by addition, not redefinition · the `comms`/`events`/`tools`/`api`
  facets and which already-built subsystem each binds · the P3 output envelope + the
  `TaskHandler` return-type graduation + the evidence-drain · the permission gate where
  **C4 becomes structural** + the **#013 threads · #014 enforces · #015 sources** split ·
  cost metering + the API gateway · the autonomy test P4 + the approval hand-off · audit /
  identity-stamping · what defers to #015 and other directives · the ADR, tests, and
  migrations required · the over-engineering traps). Its thesis: #014 **fills the slots
  #013 froze** — binding built engines (Event Spine #1, Communication Layer #7, Approval
  Engine #6) and activating reserved seams (`cost_micros`), with the **API gateway** the
  one genuinely net-new chokepoint. Recommends **phasing within #014** and surfaces five
  scope forks (notably whether the API gateway splits into its own directive) for the CEO
  to rule on.
- **[`directive-016-dependency-ordering-analysis.md`](./directive-016-dependency-ordering-analysis.md)** —
  a **dependency analysis & recommendation** (not a decision; renumbers nothing) that, with
  **#013/#014/#015 complete** (contracts **#3/#4/#8** all Established), answers **which thing-name
  takes the next free directive number #016 / D-06, and in what order the remaining platform-contract
  frontiers follow**. Every conclusion is `file:line`-backed. The dependency is **asymmetric** again:
  the **Live Executor Rollout** — wiring the already-built, **C4-proven** executor (`server/sdk/executor.ts`,
  unwired into the runner `server/sdk/tasks.ts`) into the live run loop — depends **only** on contracts
  already **Established** (#3 AI SDK · #4 RunContext · #6 Approval · #8 Registry), while every other open
  frontier (**API gateway + cost metering**, **Task-Engine verification**, the **Boardroom write/act**
  interface, the **agent-to-agent protocol**) depends, directly or transitively, on the executor being
  **live**. So it recommends **#016 = the Live Executor Rollout**, then **#017 = API Gateway + Cost
  Metering** (the **split**, per the #013 precedent — *the evidence fixes the order; the packaging into
  one directive or two is the CEO's call*), then Task-Engine completion · Boardroom · Comms Protocol. It
  **informs the #016 subject the CEO must confirm** before the Architecture Proposal is written.

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
