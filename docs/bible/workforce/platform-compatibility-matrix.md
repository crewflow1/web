# CrewFlow — Platform Compatibility Matrix (the AI-workforce migration dashboard)

> **Status:** Governance **dashboard** — the canonical, living record of *which
> platform capabilities each AI employee currently inherits*. It is the migration
> frontier made legible: how many of the 42 specified employees actually run on the
> shared substrate today, what each one inherits, and what a newly migrated employee
> gets **for free** the moment it enqueues its first task.
>
> Established under CEO Directive **#012** (Master Roadmap **D-02**) as a permanent
> artifact of *The Generic Task Engine*. **Update this matrix as the first artifact
> of every employee migration — before code.**

---

## 1. Why this exists

CrewFlow's thesis is one sentence: **employee #42 inherits exactly the same
architecture as employee #3.** That is only true if "inherit" is *checkable* rather
than aspirational. This matrix makes it checkable. It answers, at a glance:

- **What does the platform provide?** The capabilities every employee may inherit,
  and each one's honest build status.
- **Who actually inherits them today?** Only **2 of 42** specified employees execute
  on the engine. This document refuses to flatter that number.
- **What does a migration cost?** For an employee already on the engine, the answer
  is *zero new platform code* — the capabilities below arrive by being on the queue,
  not by being re-built. That is the architectural-health metric (Volume XIII) in
  table form.

It complements `relationships.md` (the whole-org *static* design) with the
whole-org *as-built* state. Where the spec describes what an employee *should*
inherit, this matrix records what it *does*.

---

## 2. The legend

| Mark | Meaning |
|---|---|
| ✅ **Inherited** | Wired and load-bearing for this employee in running code today. |
| ⚙️ **Available** | The capability is **built and shipped**; this employee may opt in by configuration + a handler, with **no new platform code**. |
| 🧩 **Seam** | The platform **reserves** the capability (typed seam) but it is **not yet activated** for anyone; first use requires an ADR + architectural review (Architecture Freeze §2). |
| 🔒 **Reserved** | Specified in the Bible, **not yet built** in code. |
| — **n/a** | Not applicable to this employee's role. |

Capability build-statuses below are the canonical ones from
[`../governance/architecture-freeze.md`](../governance/architecture-freeze.md) §4.

---

## 3. The platform capabilities (the columns)

The inheritable substrate, after Directive #012, with each capability's
platform-wide build status. These are the mechanisms the workforce README §2
("inherit, don't re-invent") promises are provided **once, for everyone**.

| # | Capability | Platform status | Where it lives | What "inherit" means |
|---|------------|-----------------|----------------|----------------------|
| C1 | **Generic Task Engine** — durable queue: claim · lease · heartbeat · retry | **Established (core)** | `hq_ai_tasks` + 7 SECURITY DEFINER entry points; ADR 0004 | Enqueue a `task_type`; the engine owns the work's lifecycle |
| C2 | **Runner SDK** — `registerTaskHandler` · `runReadyTask` · `drainTaskType` | **Established** | `server/sdk/tasks.ts` | One way to execute; no bespoke run-loop |
| C3 | **Crash recovery** — leases + reaper (no bespoke wall clock) | **Established** | `hq_ai_task_reap` + lease columns; reaper cron | Stuck work is reclaimed uniformly; `STUCK_RUNNING_MS` retired |
| C4 | **Event Spine audit** — `task.*` lifecycle verbs | **Established** | `hq_events` + registry; ADR 0005 | Every transition is audited automatically; the employee writes nothing |
| C5 | **Operator visibility** — the unified read model | **Established** | `server/services/hq-task-queue.ts` → `/admin/tasks` | Appears on the workforce screen the moment it enqueues — no per-employee wiring |
| C6 | **Shared Memory** — `ctx.memory`, bound to work | **Established** *(prod gated)* | `server/sdk/memory.ts`; `bound_task_id` FK (ADR 0006) | May read/write the company brain; writes attributable to the task that made them |
| C7 | **Approval Engine** — human-gated actions | **Established** | `server/services/hq-approvals.ts`; ADR 0001 | May gate an action on approval; **engine-level** approval-gated *tasks* are a seam (C10) |
| C8 | **Communication Layer** — gated outbound delivery | **Established** | `server/services/hq-comms.ts`; ADR 0003 | May deliver to humans through one audited substrate |
| C9 | **3-layer permission gate** — least-privilege scopes | **Partial** | enforced ad hoc per surface; XIII §8 | Scopes/limits enforced; a central Capability Registry is reserved (C11) |
| C10 | **Engine seams** — DAG (`depends_on`) · approval-gated tasks · verification | **🧩 Seam** | typed but inert in `hq_ai_tasks` | Reserved; first activation by ADR |
| C11 | **Capability Registry** — `hq_ai_capabilities` routing | **🔒 Reserved** | spec only (XIII §4) | Callers name a capability, not an employee — not yet built |
| C12 | **RunContext / SDK envelope** — the per-employee SDK | **🔒 Reserved** | intent only; D-04 / #014 | The unified employee SDK; memory + tasks are its first two facets |

---

## 4. The live employees (what they inherit today)

Two employees execute on the engine. This is the fully-populated core of the
matrix — every other row is the migration frontier (§5).

| Employee | Slug | Durable `task_type` | C1 Engine | C2 SDK | C3 Recovery | C4 Spine | C5 Visibility | C6 Memory | C7 Approval | C10 Seams | C11–C12 |
|---|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Company Research AI** (ref.) | `research-ai` | `research_company` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️¹ | 🧩 | 🔒 |
| **Lead Qualification AI** | `lead-qualification` | `qualify_company` | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️² | 🧩 | 🔒 |

¹ Research AI holds outbound artifacts for human approval (`requires_approval =
true`) via its own service logic; it does **not** yet use the engine-level
approval-gated-task seam (C10). ² Lead Qualification is deliberately **autonomous**
(`requires_approval = false`) — a bounded, reversible, status-guarded classification
(roadmap decision #6); approval is intentionally not wired.

**Reading the row:** both employees inherit C1–C5 **identically and automatically**
— that is the machine-checked indistinguishability proven in
`__tests__/integration/tasks/task-queue-read-model.test.ts` and
`__tests__/security/employee-migration-parity.test.ts`. C6–C9 are available and
configured per role. C10–C12 are reserved for the whole platform, so they read the
same for everyone — *no employee is special*.

---

## 5. The migration frontier (the whole workforce)

The 42-employee workforce model (`README.md` §7) against the as-built engine. The
honest denominator: **2 of 42 live; 40 not yet migrated.** Order and slugs follow
the spec roster; the two live rows are bolded.

| # | Employee (spec) | spec slug | Division | Engine status |
|---|---|---|---|---|
| 13 | **Research AI** | `research-ai` | Revenue | ✅ **Live** — `research_company` |
| 14 | **Qualification AI** | `qualification-ai` ³ | Revenue | ✅ **Live** — `qualify_company` |
| 1 | CEO AI | `ceo-ai` | Executive | Not yet migrated (framework seed exists) |
| 2 | COO AI | `coo-ai` | Executive | Not yet migrated |
| 3 | CTO AI | `cto-ai` | Executive | Not yet migrated (framework seed exists) |
| 4 | CFO AI | `cfo-ai` | Executive | Not yet migrated |
| 5 | Product AI | `product-ai` | Technology | Not yet migrated (framework seed exists) |
| 6 | Engineering Manager AI | `engineering-manager-ai` | Technology | Not yet migrated |
| 7 | QA AI | `qa-ai` | Technology | Not yet migrated (framework seed exists) |
| 8 | Security AI | `security-ai` | Technology | Not yet migrated |
| 9 | DevOps AI | `devops-ai` | Technology | Not yet migrated |
| 10 | Documentation AI | `documentation-ai` | Technology | Not yet migrated (framework seed exists) |
| 11 | Database AI | `database-ai` | Technology | Not yet migrated |
| 12 | API AI | `api-ai` | Technology | Not yet migrated |
| 15 | Outreach AI | `outreach-ai` | Revenue | Not yet migrated (seeded #010 Ph.1, draft-only) |
| 16 | Sales AI | `sales-ai` | Revenue | Not yet migrated (framework seed exists) |
| 17 | Marketing AI | `marketing-ai` | Revenue | Not yet migrated (framework seed exists) |
| 18 | Customer Success AI | `customer-success-ai` | Customer | Not yet migrated |
| 19 | Support AI | `support-ai` | Customer | Not yet migrated (framework seed exists) |
| 20 | Onboarding AI | `onboarding-ai` | Customer | Not yet migrated |
| 21 | Finance AI | `finance-ai` | Finance | Not yet migrated (framework seed exists) |
| 22 | Analytics AI | `analytics-ai` | Finance | Not yet migrated |
| 23 | Operations AI | `operations-ai` | Operations | Not yet migrated (framework seed exists) |
| 24 | HR AI | `hr-ai` | People & Compliance | Not yet migrated |
| 25 | Legal & Compliance AI | `legal-compliance-ai` | People & Compliance | Not yet migrated |
| 26 | Voice Receptionist AI | `voice-receptionist-ai` | Customer | Not yet migrated |
| 27 | WhatsApp AI | `whatsapp-ai` | Customer | Not yet migrated |
| 28 | Email AI | `email-ai` | Customer | Not yet migrated |
| 29 | Scheduler AI | `scheduler-ai` | Operations | Not yet migrated |
| 30 | Quote Writer AI | `quote-writer-ai` | Finance | Not yet migrated |
| 31 | Cashflow AI | `cashflow-ai` | Finance | Not yet migrated |
| 32 | Payroll AI | `payroll-ai` | Finance | Not yet migrated |
| 33 | Business Coach AI | `business-coach-ai` | People & Compliance | Not yet migrated |
| 34 | Site Manager AI | `site-manager-ai` | Operations | Not yet migrated |
| 35 | Blueprint AI | `blueprint-ai` | Operations | Not yet migrated |
| 36 | Procurement AI | `procurement-ai` | Operations | Not yet migrated |
| 37 | Intelligence AI | `intelligence-ai` | AI Platform | Not yet migrated |
| 38 | Memory Manager AI | `memory-manager-ai` | AI Platform | Not yet migrated |
| 39 | Workflow AI | `workflow-ai` | AI Platform | Not yet migrated |
| 40 | Notification AI | `notification-ai` | AI Platform | Not yet migrated |
| 41 | Monitoring & Incident AI | `monitoring-incident-ai` | AI Platform | Not yet migrated |
| 42 | AI Boardroom Orchestrator | `ai-boardroom-orchestrator` | Executive | Not yet migrated |

³ **Slug drift (tracked debt):** the spec roster names #14 `qualification-ai`; the
*running* employee's slug is **`lead-qualification`**. The engine joins on
`assigned_employee_id`, so behaviour is unaffected; the spec/runtime reconciliation
is owed to D-04 / #014 (see `../governance/runtime-identity.md` and the Completion
Report §3). "Framework seed exists" rows are drawn from the roadmap's seeded-14
list; none execute on the engine — *seeded ≠ migrated*.

**Frontier summary:** **2 Live · 40 Not yet migrated** (≈ **5%** of the specified
workforce on the engine). The number is small on purpose — the directive's job was
to make the *path* to 100% a data migration + a handler, not a number.

---

## 6. What a migration inherits — for free

When employee #N is migrated onto the engine, it inherits **C1–C5 automatically**
(by being on the queue) and **C6–C9 on demand** (built capabilities it configures).
The cost is what the second migration already demonstrated:

| Migration | New migrations | New SDK / lib modules | Net new **platform** code |
|---|---|---|---|
| `research-ai` (reference) | 0 | 0 | 0 |
| `lead-qualification` (#2) | 0 | 0 | **0** |
| *expected for #3 … #42* | **0** | **0** | **0** |

A migration that needs new infrastructure is a **platform gap, not an exceptional
employee** (the Reference Employee Rule). If a future migration cannot be expressed
as *a `task_type` + a handler + configuration*, the correct response is to widen the
platform once, for everyone — and to record why here.

---

## 7. Maintenance rule

1. **Update before code.** The migrating directive updates this matrix as its
   **first** artifact: add the employee's live row (§4/§5), its `task_type`, and any
   newly-activated capability column.
2. **Activating a seam updates the column, not just a cell.** Turning a 🧩 Seam
   (C10) or 🔒 Reserved (C11/C12) into ✅/⚙️ is a platform event — it lands with its
   ADR and flips the capability's status in §3 **and** in
   `../governance/architecture-freeze.md` §4.
3. **Keep the denominator honest.** The frontier summary (§5) is the headline; never
   round it up. "2 of 42" today; the trend line is the platform thesis.
4. **One source of truth.** Capability build-statuses are owned by the Architecture
   Freeze; employee identity by `ai_employees` + `runtime-identity.md`; this matrix
   *joins* them — it does not redefine either.

---

*Governance dashboard under CEO Directive #012 (Master Roadmap D-02). Documentation
only — no code, schema, or configuration changed. Companion to the
[Directive #012 Completion Report](../governance/directive-012-completion-report.md)
and the static org design in [`relationships.md`](./relationships.md).*
