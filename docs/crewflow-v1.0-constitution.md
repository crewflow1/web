# The CrewFlow Version 1.0 Constitution

> **Status:** Planning deliverable. This document answers **one question** —
> *"What must exist before CrewFlow **Version 1.0** can be declared complete?"* — and
> nothing else. It is the **finish line**, written down.
>
> **It is deliberately separate from the three other planning instruments and does
> not duplicate them:**
> - the **Bible** (`docs/bible/`) says *what the system is and why* — doctrine;
> - the **ADRs** (`docs/bible/decisions/`) record *individual architectural
>   decisions* as they are made;
> - the **Roadmap** (`docs/roadmap.md` + Bible Volume XII) says *in what order* we
>   build.
>
> This Constitution says *when we are **done***. It is an **acceptance contract**, not
> a backlog and not a design. Reading it authorises nothing; it sets the bar that a
> future CEO declaration is measured against. Issued under CEO Directive **#011**
> (*Governance, Numbering & Scope Reconciliation*; Master Roadmap **D-01**).
>
> **Open thresholds.** Where a specific number or scope line is a genuine product
> decision not yet made, this document marks it **‹to be ratified by the CEO›** rather
> than inventing it. The Constitution fixes the **shape** of each criterion now; the
> CEO fills the open values as the relevant directive lands.

---

## 0. The two meanings of "V1.0" (read this first)

"V1.0" is used at **two different scales**, and conflating them is the single most
likely way to mis-declare done. This Constitution governs the larger one.

| Scale | Name & tag form | What it means | Who declares it |
|---|---|---|---|
| **Component** | `crewflow-‹component›-v1.0` (e.g. `crewflow-shared-memory-v1.0`, `crewflow-event-spine-v1.0`) | A single substrate contract has reached a stable, frozen, documented 1.0 — its own little finish line. | The owning directive, recorded as a git tag + ADR. |
| **Platform** | **CrewFlow OS V1.0** (no component segment) | The **whole operating system** clears every section of this Constitution at once. The product a customer runs their business on, and the HQ that runs CrewFlow, are both real. | **The CEO**, by explicit declaration, measured against §§2–9 below. |

**Rule:** a component `*-v1.0` tag is **necessary but never sufficient**. Shipping
`crewflow-shared-memory-v1.0` does not move the platform declaration one inch closer
on its own — it only ticks one box in §4. **CrewFlow OS V1.0** is declared only when
**every** section below is satisfied together. No section may be waived to hit a date.

---

## 1. Platform capabilities — what V1.0 must *do*

CrewFlow OS V1.0 is complete only when the platform demonstrably delivers all of:

1. **A customer runs their construction business on it.** The customer-facing
   product (see §6) supports a real UK construction company's day-to-day operation
   end to end — not a demo path.
2. **CrewFlow runs *itself* on it (the HQ).** The internal HQ — the AI Boardroom and
   workforce — operates CrewFlow's own business functions through the same substrate
   the product is built on. Eating our own cooking is a release gate, not a nicety.
3. **Every action is permissioned and audited.** No employee acts outside its scope;
   every event, message, and task an employee emits is on the append-only Event Spine
   with a correct `actor_id` (see [`bible/governance/runtime-identity.md`](./bible/governance/runtime-identity.md)).
4. **The inheritance promise is demonstrable.** A brand-new employee can be stood up
   **purely by inheriting the shared SDK/substrate, with zero bespoke plumbing** —
   the literal test of *"employee #42 inherits exactly the same architecture as
   employee #3."* If standing up a new employee requires hand-written substrate, V1.0
   is not done.

---

## 2. The AI Operating System

The OS is the spine that makes 1–4 above true for *every* employee identically. V1.0
requires the **frozen platform contracts** of
[`bible/governance/architecture-freeze.md`](./bible/governance/architecture-freeze.md)
to be **Established** — not Partial, not Reserved:

| Contract | Freeze status today | Required for OS V1.0 |
|---|---|---|
| Event Spine | Established | Established ✔ |
| Shared Memory | Established *(prod migration gated)* | Established **and ungated in prod** |
| Approval Engine | Established | Established ✔ |
| Communication Layer | Established *(PR pending merge)* | Established **and merged** |
| Draft Generation | Established | Established ✔ |
| **AI SDK** | **Partial** (memory facet only) | **Established** (full envelope) |
| **RunContext** | **Reserved** (embryonic) | **Established** |
| **Task Engine** (generic) | **Reserved** | **Established** |
| **Capability Registry** | **Reserved** | **Established** |
| **Boardroom interfaces** | **Partial** (read-only) | **Established** (can act, not only observe) |
| **Shared Communication Protocol** | **Reserved** | **Established** *(or explicitly deferred past V1.0 by CEO ADR)* |

Each line above is the place a `crewflow-‹component›-v1.0` tag is earned. The OS is
"V1.0-ready" only when the **whole column** on the right is satisfied.

---

## 3. The SDK

The SDK is the envelope every employee inherits; it is the mechanism behind the
inheritance promise. For V1.0 the SDK must:

- expose the **full per-employee envelope** (today only the **Memory facet** exists
  in `server/sdk/memory.ts`);
- carry a real **`RunContext`** that threads identity, scope, memory, and the output
  envelope through every employee invocation (today `RunContext` exists only as
  comments/intent);
- be the **single** way an employee touches the substrate — no employee reaches
  around the SDK to the database or the Spine directly;
- be **versioned**: the SDK earns `crewflow-ai-sdk-v1.0` only when its surface is
  stable and frozen under the Architecture Freeze.

The canonical **SDK envelope** is owned by the **AI SDK directive (D-04 / #014)**;
the canonical **runtime-identity** design is settled by the **RunContext Runtime
Contract directive (D-03 / #013)**. This Constitution sets the acceptance bar both
must clear.

---

## 4. AI Workforce scope

The Bible specifies **42 employees** (`docs/bible/workforce/employees/01…42`). V1.0
does **not** require all 42 to be live; it requires a **defined, sufficient subset**
operating entirely through the substrate, and an honest record of the rest.

For each employee, V1.0 records a tier:

- **Live** — executes real work through the SDK, permissioned and audited.
- **Framework** — seeded and inheritable, not yet executing.
- **Reserved** — acknowledged, unbuilt (e.g. `design-ai`; see
  [`bible/governance/runtime-identity.md`](./bible/governance/runtime-identity.md) §5).

**V1.0 requires:**
- the **minimum Live roster** that makes §1.1 (customer) and §1.2 (HQ) real —
  **‹which specific employees, to be ratified by the CEO›**;
- **runtime identity reconciled** for every Live employee: runtime slug = spec slug =
  SDK identity, per the rule settled by D-03 / #013 (the qualification three-way
  split resolved, not merely recorded);
- **every Live employee stood up by inheritance only** (the §1.4 test), proving the
  roster scales from #3 to #42 without substrate forks.

> **Protected platform capability (added under D-02 / #012).** Every AI employee
> created after D-02 **inherits the Generic Task Engine**
> ([ADR 0004](./bible/decisions/0004-generic-task-engine.md);
> [`bible/governance/architecture-freeze.md`](./bible/governance/architecture-freeze.md)
> contract #5). **No employee may introduce a custom task runner. No parallel queue
> implementations are permitted.** Any exception requires an ADR, an architectural
> review, **and** CEO approval. This is what "without substrate forks" means for work
> execution: the one inherited queue — or a CEO-approved, ADR-recorded exception —
> never a quiet second runner. The Task Engine is the work-execution mechanism behind
> the §1.4 inheritance promise.

---

## 5. Construction platform scope

The customer-facing product is an **AI-native operating system for UK construction
companies**. V1.0 requires the product to carry a real company's core operation. The
**specific in-scope construction workflows for V1.0** are **‹to be ratified by the
CEO›**, drawn from the Product volume; each must be:

- backed by the same substrate (Event Spine, Approval, Comms, Memory) as the HQ —
  **no parallel, product-only plumbing**;
- permissioned and audited to the same standard as internal employees;
- usable by a non-technical construction operator without CrewFlow hand-holding.

Anything the product needs that the HQ already has **must be the same component**, not
a second implementation — the "one source of truth / no duplicated infrastructure"
rule is a V1.0 release gate, not a preference.

---

## 6. Validation requirements

CrewFlow OS V1.0 may not be declared unless, on the release commit:

1. **All six CI gates are green** — typecheck, lint, unit, integration (real
   Postgres), security, e2e (`.github/workflows/ci.yml`).
2. **The Event Spine is provably append-only in production** — enforcer triggers
   live, no path writes events around `hq_emit_event`.
3. **Every frozen contract that is "Established" has a passing security test** —
   scope/permission enforcement is tested at the database layer, not only in TS.
4. **The inheritance test (§1.4) is an automated check**, not a manual demo: a
   fixture employee is created through the SDK alone and is correctly wired to Spine,
   Memory, Approval, and Comms with zero bespoke code.
5. **Prod migrations are applied and reversible-by-design** — including the
   currently-gated Shared Memory migration (#009).

---

## 7. Documentation requirements

The Bible's own rule — *document before you build* — extends to the V1.0 declaration:

1. **Every frozen contract has a current Bible volume** describing its built (not
   aspirational) shape, reconciled with the code.
2. **Every Established contract that changed to reach V1.0 has its ADR(s)** in
   `docs/bible/decisions/` (numbering per
   [`bible/governance/numbering.md`](./bible/governance/numbering.md) §5).
3. **The living tracker** ([`bible/adoption-analysis.md`](./bible/adoption-analysis.md)
   §"Living engineering tracker") reflects the release census — migrations, employees,
   ADRs — with no stale baseline figures presented as current.
4. **Runbooks exist** for the operational substrate (backup/recovery, retention,
   connection-pooling already live under `docs/`); each Live customer-facing workflow
   has an operator-facing description.
5. **This Constitution is itself reconciled** — every §§2–5 status line matches the
   code at the release commit.

---

## 8. Success criteria — the single bar

CrewFlow OS V1.0 is **declared complete by the CEO** when, and only when, **all** hold
simultaneously on one release commit:

- [ ] **§1** — all four platform capabilities demonstrated (customer runs on it; HQ
      runs on it; everything permissioned + audited; new employee by inheritance).
- [ ] **§2** — every frozen platform contract is **Established** (or explicitly
      CEO-deferred past V1.0 by ADR), with its `crewflow-*-v1.0` tag earned.
- [ ] **§3** — the SDK exposes the full envelope incl. a real `RunContext`, is the
      sole substrate path, and is frozen at `crewflow-ai-sdk-v1.0`.
- [ ] **§4** — the ratified minimum Live roster is live, identity-reconciled, and each
      member was stood up by inheritance only.
- [ ] **§5** — the ratified construction workflows carry a real UK company end to end
      on the shared substrate, with no product-only duplication.
- [ ] **§6** — all six CI gates green; append-only proven; inheritance test automated;
      prod migrations applied.
- [ ] **§7** — Bible volumes, ADRs, living tracker, runbooks, and this Constitution
      all reconciled with the release commit.

**No partial credit.** A single unchecked box means CrewFlow is at a component
milestone, not at **CrewFlow OS V1.0**. The long-term objective this bar serves is
unchanged: *the world's first AI-native operating system for construction companies.*

---

## 9. What this document is not

- **Not the Bible.** It cites doctrine; it does not author it.
- **Not an ADR.** It records no decision; it sets the acceptance bar decisions are
  measured against.
- **Not the Roadmap.** It says *done*, not *next*. Sequence lives in
  [`roadmap.md`](./roadmap.md) and Volume XII.
- **Not authorisation to build.** Like the Bible, reading it builds nothing; only an
  explicit CEO directive does.

---

*Planning deliverable. Documentation only — no code, schema, or configuration is
changed by this Constitution. Open thresholds remain ‹to be ratified by the CEO›.
Issued under CEO Directive #011 (Master Roadmap D-01).*
