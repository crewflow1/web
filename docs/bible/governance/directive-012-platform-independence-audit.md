# CrewFlow Governance — Directive #012 Platform-Independence Audit

> **Status:** Governance **record** — a one-time **verification audit**, not a
> decision. It answers the four questions the CEO posed on approval of the Directive
> #012 completion report, each supported by repository evidence, **before** platform
> expansion continues into Directive #013. Issued under CEO Directive **#011**
> (*Governance, Numbering & Scope Reconciliation*; Master Roadmap **D-01**) as the
> closing validation of CEO Directive **#012 / D-02** (*The Generic Task Engine*).
>
> **Purpose (CEO's words):** *"to verify true platform independence before continuing
> platform expansion."*
>
> **Headline finding:** the **execution substrate is 100% employee-agnostic** — every
> component an employee actually runs on (engine, SDK, enqueue service, read model,
> verb registry, Event Spine, Shared Memory) names **no** specific employee. The only
> residual coupling lives in **four registration/manifest surfaces** (cron schedule,
> admin nav, CEO dashboard card, migrated-roster test), none of which is load-bearing
> for task execution. True platform independence at the substrate is **verified**; the
> scattered registration is the single named gap and a natural Directive #013 input.

---

## 1. Method — how "would the OS remain unchanged?" is answered with evidence

The audit rests on one partition: **platform code** (the shared substrate *every*
employee inherits) versus **employee code** (a module that belongs to exactly one
employee). The test for independence is mechanical and falsifiable:

> **Grep the platform substrate for any hardcoded reference to a specific employee** —
> the durable task types (`research_company`, `qualify_company`), the slugs
> (`research-ai`, `lead-qualification`), or an employee's service module. Platform
> code that *names* an employee is coupled to it. Platform code that names *none* is
> employee-agnostic.

A reference is only **functional coupling** if removing the employee would change
behaviour. A docstring example or a historical narrative comment that mentions an
employee is **cosmetic** — it is classified as such explicitly below, never silently
counted as clean.

All evidence is `file:line`, reproducible from the integration tip `21a4104`
(Merge #201 into `directive/011-governance-reconciliation`).

---

## 2. The platform / employee partition

| Layer | Files | Owns |
|---|---|---|
| **Platform substrate** *(inherited by all)* | `supabase/migrations/20260802000000_hq_ai_tasks.sql`, `server/services/hq-tasks.ts`, `server/sdk/tasks.ts`, `server/services/hq-task-queue.ts`, `app/admin/tasks/page.tsx`, `lib/events/registry.ts`, `lib/ai-employees/*` | the engine, enqueue, runner SDK, operator read model, frozen verbs, employee stats — keyed by `task_type` / `actor_id` / `subject`, never by a hardcoded employee |
| **Registration surfaces** *(where an employee plugs in)* | `vercel.json`, `app/admin/layout.tsx`, `lib/hq/ceo.ts`, `__tests__/security/employee-migration-parity.test.ts` | manifests that, by design, enumerate the employees that exist |
| **Employee code** *(belongs to one employee)* | `server/services/hq-research.ts`, `server/services/hq-qualification.ts`, `app/admin/research/*`, `app/admin/qualification/*`, `app/api/admin/{research,qualification}/*`, `app/api/cron/{research-drain,qualification-drain}/route.ts`, `supabase/migrations/2026071800…research_ai_employee.sql`, `…lead_qualification_employee.sql`, the per-employee test suites | one employee's own runner, UI, routes, seed, tests |

The audit's four answers all flow from this partition.

---

## 3. Q1 — If **Research AI** were removed entirely, would the OS remain unchanged?

**Answer: the OS *substrate* would remain unchanged byte-for-byte. The OS would not
lose a capability — it would lose a *consumer*. Removal is the deletion of Research
AI's own module plus de-registration from four manifest surfaces.**

**(a) Substrate — provably unchanged.** Every platform component is free of any
*functional* reference to Research AI:

- **Engine** (`hq_ai_tasks.sql`): `task_type` is `text not null`, **free-form — no FK,
  no CHECK** naming `research_company` (line 83; the only CHECKs are `status`/`priority`/
  counts, lines 102–162). The string `research_company` appears once, in a *reuse-audit
  comment* (line 15). Cosmetic.
- **Runner SDK** (`server/sdk/tasks.ts`): the sole mention of `research-ai` is a
  docstring *example* of the `RunnerIdentity` handle (line 64). The SDK takes identity
  as a parameter. Cosmetic.
- **Read model** (`server/services/hq-task-queue.ts` + `app/admin/tasks/page.tsx`):
  groups by durable `task_type`, joins `ai_employees`. `humaniseType()` is a generic
  transform — `taskType.replace(/[_-]+/g, " ")` (page.tsx line 284); `research_company`
  is only the docstring's worked example (line 281). Cosmetic.
- **Verb registry** (`lib/events/registry.ts`): the `task.*` verbs name no employee.
- **Event Spine / Shared Memory / Approval / Comms**: keyed by `actor_id` / `subject`,
  not by a hardcoded employee.

**(b) Employee code — deleted with the employee (expected).**
`server/services/hq-research.ts` (where `RESEARCH_TASK_TYPE = "research_company"`,
line 102, and `RESEARCH_AI_SLUG = "research-ai"`, line 100 are the employee's *own*
constants), `app/admin/research/*`, `app/api/admin/research/*`, the
`research-drain` cron, the `research_ai_employee.sql` seed, and the research test
suites all leave with the employee. The substrate they called *remains*.

**(c) Registration surfaces — would shed Research AI's entries (shallow):**

| File | Line | What de-registers |
|---|---|---|
| `vercel.json` | 37 | remove the `/api/cron/research-drain` schedule entry |
| `app/admin/layout.tsx` | 41 | remove `{ href: "/admin/research", label: "🔬 Research AI" }` |
| `lib/hq/ceo.ts` | 329–345 | remove the bespoke "Research" CEO-dashboard card |
| `__tests__/security/employee-migration-parity.test.ts` | 44–48 | remove the `research-ai` row from the `MIGRATED` roster |

**Net:** the engine, SDK, read model, spine and memory are untouched. The system loses
a workload, not a platform capability — exactly the inheritance property the directive
set out to prove.

---

## 4. Q2 — If **Lead Qualification AI** were removed entirely, would the OS remain unchanged?

**Answer: same shape as Q1, and this is the *stronger* proof — because Lead
Qualification was migration #2, which added _zero net new platform code_
(completion report §8). Its removal is purely subtractive, and it is *cleaner* than
Research at the presentation layer.**

**(a) Substrate — unchanged.** Identical evidence to Q1(a). The only `qualify_company`
mentions in platform files are: the engine reuse-audit comment (line 15, cosmetic) and
the read model's generic grouping (no hardcoded branch). `QUALIFY_TASK_TYPE =
"qualify_company"` (line 77) and `QUALIFICATION_AI_SLUG = "lead-qualification"`
(line 75) live in `server/services/hq-qualification.ts` — the employee's own module.

**(b) Employee code — deleted with the employee.** `hq-qualification.ts`,
`app/admin/qualification/*`, `app/api/admin/qualification/*`, the
`qualification-drain` cron, `lead_qualification_employee.sql` (which seeds into
`ai_employees` and the *legacy* `hq_sales_task_types`), and the qualification suites.

**(c) Registration surfaces — fewer than Research:**

| File | Line | What de-registers |
|---|---|---|
| `vercel.json` | 41 | remove `/api/cron/qualification-drain` |
| `app/admin/layout.tsx` | 42 | remove `{ href: "/admin/qualification", label: "🎯 Qualification AI" }` |
| `__tests__/security/employee-migration-parity.test.ts` | 49–53 | remove the `lead-qualification` roster row |

**Asymmetry worth recording:** Lead Qualification has **no** bespoke CEO-dashboard card
in `lib/hq/ceo.ts` (only Research does — a pre-task-engine sales artifact). The second
migrated employee is therefore *more* employee-agnostic than the first — consistent
with the completion report's "0 net new platform code" health signal: the platform
matured between migration #1 and #2, so #2 plugged in more cleanly.

---

## 5. Q3 — Which platform components still have **hidden coupling** to specific employees?

**Answer: none in the execution substrate. All residual coupling is in four
registration/manifest surfaces — places where an employee must, by design, *announce
itself* to the shell. The coupling is real but shallow, additive, and de-registers
cleanly.**

| # | Component | Coupling | Depth | Evidence |
|---|---|---|---|---|
| 1 | `vercel.json` (cron manifest) | enumerates `/api/cron/research-drain` + `/api/cron/qualification-drain` | shallow — a deploy file lists employee routes (same category as the platform's own `task-reaper`, line 65) | lines 37, 41 |
| 2 | `app/admin/layout.tsx` (admin nav) | two hardcoded employee links | shallow — UI shell menu | lines 41–42 |
| 3 | `lib/hq/ceo.ts` (CEO HQ dashboard) | one bespoke hand-authored "Research" card | shallow — pre-task-engine sales presentation; Qualification has none | lines 329–345 |
| 4 | `__tests__/security/employee-migration-parity.test.ts` | the `MIGRATED` roster array literally lists both employees | **by design** — "Adding the next migrated employee here forces it through the SAME contract" (line 42) | lines 43–54 |

**Cosmetic-only (flagged for honesty — *not* coupling):** docstring examples naming
`research-ai` in `server/sdk/tasks.ts:64`; the engine migration's reuse-audit narrative
comment (`hq_ai_tasks.sql:15`); the `humaniseType` docstring example
(`app/admin/tasks/page.tsx:281`). None changes behaviour if the employee is removed.

**Vestigial legacy data (not load-bearing):** `hq_sales_task_types` still seeds
`research_company` / `qualify_company` rows (`20260714000001…:438`,
`20260721000000…:56`). The **generic engine does not consult this table** — there is no
FK from `hq_ai_tasks.task_type` to it (§3a). It is legacy sales-schema seed data, inert
for the Task Engine.

**The synthesis (the one real finding).** Every residual coupling is a *manifest* — a
nav entry, a cron schedule, a dashboard card, a migrated-roster. None is in the engine,
SDK, read model, spine, or memory. This is the *expected* shape of a plug-in host: a
host has a plug-in registry. But the registrations are **scattered across four files
with no single declarative source**. That scattering is the audit's lone actionable
gap — and a clean Directive #013 candidate: a declarative **Employee Registry /
manifest** that collapses these four points into one, so a new employee is registered
(and an old one de-registered) in exactly one place.

---

## 6. Q4 — Which components are now **completely employee-agnostic**?

**Answer: the entire execution substrate. Each names zero employees functionally;
each is keyed by a durable, employee-independent contract.**

| Component | Why it is employee-agnostic | Evidence |
|---|---|---|
| **Generic Task Engine** (`hq_ai_tasks.sql`) | `task_type` is free-form `text` (no FK/CHECK); subject is polymorphic `(subject_kind, subject_id)`; `assigned_employee_id` is a *nullable FK* — data, not code | lines 83, 87, 102–162 |
| **Runner SDK** (`server/sdk/tasks.ts`) | `registerTaskHandler` / `runReadyTask` / `drainTaskType` are type-parametric; identity is a parameter; only a docstring example names an employee | line 64 (cosmetic) |
| **Enqueue service** (`server/services/hq-tasks.ts`) | names no employee at all | absent from every grep |
| **Operator read model** (`server/services/hq-task-queue.ts` + `app/admin/tasks/page.tsx`) | groups by durable `task_type`, joins `ai_employees`; `humaniseType` is a generic string transform | page.tsx line 284 |
| **Frozen verb registry** (`lib/events/registry.ts`) | `task.*` verbs are generic; names no employee | §4 grep — none |
| **Employee stats/model** (`lib/ai-employees/*`) | data-driven off the `ai_employees` table; names no employee | §8 grep — none |
| **Event Spine / Shared Memory / Approval / Communication** *(inherited from earlier directives)* | keyed by `actor_id` / `subject` / generic FKs | not employee-named |

**Conclusion.** The substrate every AI employee executes on is employee-agnostic with
repository evidence. "Employee #42 inherits exactly the same architecture as employee
#3" is, at the substrate, **literally true today**: there is no `#3`-shaped code for
`#42` to differ from.

---

## 7. Verdict

1. **Q1 / Q2:** removing either live employee leaves the OS *substrate* unchanged; only
   the employee's own module and four manifest entries depart. The OS loses a consumer,
   not a capability.
2. **Q3:** no hidden coupling in the execution substrate; four shallow, by-design
   registration surfaces, scattered across four files.
3. **Q4:** the full substrate — engine, SDK, enqueue, read model, verbs, spine, memory —
   is completely employee-agnostic, each with cited evidence.

**True platform independence is verified.** Platform expansion into Directive #013 may
proceed. The audit additionally *names* the one improvement worth making — a single
declarative Employee Registry to collapse the four scattered registration surfaces —
which the Directive #013 proposal carries forward as design input, not as a blocker.

---

*Documentation only. No contract, schema, migration, or service was changed by this
audit. It records a verification performed at integration tip `21a4104`. Adopted under
CEO Directive #011 (Master Roadmap D-01); closes the validation of CEO Directive #012
(Master Roadmap D-02).*
