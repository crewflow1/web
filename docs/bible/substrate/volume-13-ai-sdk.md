# Volume XIII — AI SDK

> **Substrate Block, document 5 of 5 — the capstone.** Architecture only. Read
> `./README.md` first; this volume uses the shared primitives (P1–P7) and the
> four other volumes (IX comms, X memory, XI events, XII tasks), and binds them
> into one interface.
>
> *Provisional numbering "XIII" per the CEO directive (no collision with the
> provided canon, which ends at XII). Tracked in the canonical renumber.*

---

## 1. Purpose & scope

**The job, in one sentence:** be the **single interface — the syscall layer —
that every AI employee uses to touch the substrate**, so that *identity, memory,
permissions, tools, events, tasks, comms, approval, audit, cost and capability*
are implemented **once**, and every employee, present and future, is just a
configured instance of the same blueprint.

This is the volume the directive cares about most: *"the blueprint for every AI
employee… We are designing the operating system they will all run on."* The
other four volumes are subsystems; the SDK is the **ABI** that makes them usable
*safely* by an AI. Crucially, the SDK is the place where the substrate's hardest
guarantee becomes structural: **an AI employee has no other way to act.** It
cannot open a database connection, call an external API, send a message, or spend
money except by asking the SDK, which checks permission, applies the autonomy
test, meters cost, and writes an audit event for every single call. That is how
*"AI never bypasses security"* (C4) stops being a slogan and becomes a property
of the architecture.

CrewFlow already has the raw material: the `ai_employees` roster (identity,
role, department, `permissions` jsonb, `tools_allowed`, `memory_scope`,
`model_provider/name`, `system_prompt`), per-employee metrics
(`ai_employee_task_metrics`), and two employees (Research AI, Lead Qualification
AI) that already run via the proven runner pattern. The SDK **generalises and
unifies** all of that into one typed interface plus a **capability registry** —
and adds the cross-cutting concerns (cost, versioning, health, approval) that the
ad-hoc runners lack.

**In scope:** the 20 dimensions the CEO enumerated, each a section below
(identity, mission, responsibilities, inputs, outputs, memory, permissions,
tools, APIs, events, health checks, metrics, audit logging, approval framework,
security, lifecycle, configuration, versioning, cost tracking, capability
registration); the capability registry; the canonical employee blueprint and a
reference employee.

**Out of scope:** the subsystems themselves (IX–XII own their internals); the
*individual* employees (per the directive, *no new employee is designed until
IX–XIII are complete* — this volume defines the mould, not the castings).

---

## 2. Where it sits — the ABI

```
        ┌──────────────── an AI employee = config + a handler ─────────────┐
        │  identity (who)  · mission (why)  · capabilities (what it can do) │
        │  the ONLY code an employee author writes:  handler(task, ctx)     │
        └───────────────────────────────┬─────────────────────────────────┘
                                         │  uses ONLY:
                  ┌──────────────────────▼──────────────────────┐
                  │                AI SDK (XIII)                  │
                  │  ctx.identity · ctx.memory · ctx.comms ·      │
                  │  ctx.events · ctx.tasks · ctx.tools · ctx.api │
                  │  + permission gate · autonomy test (P4) ·     │
                  │    cost meter · audit emit · health/metrics   │
                  └──┬────────┬────────┬────────┬────────┬────────┘
                     │        │        │        │        │   (every call:
              ┌──────▼─┐ ┌────▼───┐ ┌──▼───┐ ┌──▼────┐ ┌─▼─────┐  permission-checked,
              │ IX     │ │ X      │ │ XI   │ │ XII   │ │ API   │  metered, audited)
              │ comms  │ │ memory │ │ bus  │ │ tasks │ │ gateway│
              └────────┘ └────────┘ └──────┘ └───────┘ └───────┘
   the employee NEVER touches Postgres, an LLM, or an external API directly (P5/C4)
```

- **Depends on:** all four other volumes + `ai_employees` (the roster, identity).
- **Depended on by:** every AI employee; the AI Boardroom (which *uses* the SDK to
  drive employees and compose their tasks — it does not reimplement any subsystem).

---

## 3. Built vs. to-build

| Capability | State | Note |
|------------|-------|------|
| Roster + identity (slug, role, department, sort) | **Built** | `ai_employees`. |
| Per-employee config (provider/model, system_prompt) | **Built (inert)** | columns exist; SDK makes them live. |
| Permissions posture `{can_execute, requires_approval, scopes}` | **Built (inert)** | locked-down default; SDK enforces it. |
| Tool **labels** | **Built (inert)** | `tools_allowed text[]`; SDK turns labels into a typed tool registry. |
| Memory scope (isolated/department/org/global) | **Built** | `ai_employees.memory_scope`; feeds X's permission matrix. |
| Per-employee metrics | **Built** | `ai_employee_task_metrics`. |
| Two reference employees on the runner pattern | **Built** | Research AI, Lead Qualification AI. |
| **Capability registry** (`hq_ai_capabilities`) | **To build** | the routing/assignment source of truth (IX/XII). |
| The unified **`ctx` ABI** (memory/comms/events/tasks/tools/api) | **To build** | one typed surface over IX–XII + gateway. |
| **Cost metering** + budgets | **To build** | `cost_micros` plumbing + the API gateway. |
| **API gateway** (LLM/Twilio/… metered, audited, rate-limited) | **To build** | the only path to an external API. |
| **Approval framework** wiring (P4 at the ABI) | **To build** | `proposeActions()` → XII checkpoint. |
| **Versioning / lifecycle / health** | **To build** | employee versions, register→retire, heartbeat. |

**Net:** identity, config, permissions, tools (as labels), memory scope and
metrics are *shipped but inert or ad-hoc.* The SDK makes them **live, typed,
enforced and uniform**, and adds the four cross-cutting systems the ad-hoc
runners never had: capability registry, cost metering, the API gateway, and the
approval/version/health framework.

---

## 4. The capability registry — `hq_ai_capabilities`

The keystone. It is what lets the workforce **grow as data** (resolving C1: the
Bible's conflicting 13-vs-30 rosters are just different row-sets) and what powers
**by-capability** routing (IX §6) and **by-capability** task assignment (XII §7).

```sql
create table if not exists public.hq_ai_capabilities (
  id              uuid primary key default gen_random_uuid(),
  ai_employee_id  uuid not null references public.ai_employees(id) on delete cascade,

  -- The capability/intent this employee can perform (matches IX intent + XII
  -- task_type.required_capability). DATA — granting a capability is an INSERT.
  capability      text not null check (capability ~ '^[a-z0-9_.]{1,80}$'),

  -- How good it is at this (drives the IX/XII load policy's best-candidate pick).
  confidence      integer not null default 80 check (confidence between 0 and 100),

  -- The permission SCOPE this capability runs under (composed with §8): what
  -- resources + actions it may touch, and whether its actions need approval.
  scopes          text[] not null default '{read}',
  requires_approval boolean not null default true,   -- default-safe (P4)

  -- Cost ceiling per invocation of this capability (XIII §19); null = inherit.
  max_cost_micros bigint,

  -- Lifecycle of the grant itself.
  status          text not null default 'active'
                  check (status in ('active','suspended','deprecated')),
  version         integer not null default 1,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (ai_employee_id, capability)
);
alter table public.hq_ai_capabilities enable row level security;  -- RLS:hq
create index if not exists hq_ai_caps_lookup_idx
  on public.hq_ai_capabilities (capability, status, confidence desc);   -- "who can do X?"
create index if not exists hq_ai_caps_employee_idx
  on public.hq_ai_capabilities (ai_employee_id) where status = 'active';
```

- **Registration is self-describing.** An employee declares its capabilities at
  register/activate time (§17); the registry is the single source for *"who can
  do `research.company`?"* — asked by the message router (IX) and the task
  assigner (XII).
- **Capabilities are data, not code.** Adding a Finance AI that can
  `reconcile.invoice` is: insert the employee row + insert its capability rows.
  No caller changes — callers name the *capability*, never the employee. **This
  is the mechanism that makes a 30-employee workforce a data migration, not a
  rewrite** (C1).
- **Scope-per-capability** is finer than the per-employee `permissions` jsonb:
  the same employee may hold `research.company` (autonomous, read+write-memory)
  and `send.email` (always-approval, write-external). Composed in §8.

---

## 5. Identity *(dimension 1)*

- An employee's identity **is** its `ai_employees` row: `slug` (the stable id
  stamped as `actor_id` on every event/message/task), `name`, `role`,
  `department`, `sort_order`. Plus a substrate **version** (§18) and a service
  identity the SDK uses to authenticate the employee to the entry points.
- **The SDK stamps identity on everything.** Every event (`actor_type=
  'ai_employee'`, `actor_id=slug`), message (`sender_id=slug`), task claim
  (`assigned_employee_id`), and memory write (`owner_employee_id`) is stamped by
  the SDK from the *authenticated* employee context. **An employee cannot act as
  another** — there is no API to set `actor_id` by hand (P5, IX §13 no-spoofing).
- Identity is immutable per version; a renamed/repurposed employee is a new
  version (§18), so history stays coherent.

## 6. Mission *(dimension 2)*

The employee's `system_prompt` (Built column) + a one-line **mission** statement
+ its capability set. The mission is the *why* — the durable purpose that frames
every task ("I qualify inbound construction leads against CrewFlow's ICP"). The
SDK injects mission + assembled memory context (X) into every model call, so the
employee reasons in-character and in-context. Mission is versioned with the
employee.

## 7. Responsibilities *(dimension 3)*

The set of `task_type`s/capabilities the employee owns (the registry, §4) plus
its **scope of authority**: which subjects it may act on, which it must delegate,
and to whom it escalates (its manager, by department/`sort_order`). Responsibility
boundaries are what the IX escalation ladder and XII delegation read.

## 8. Permissions *(dimension 7)* — the gate every call passes

The most important enforcement point. Composed from three layers, evaluated on
**every** SDK call:

1. **Employee posture** (`ai_employees.permissions`, Built): `{can_execute,
   requires_approval, scopes}` — the coarse, default-locked stance.
2. **Capability scope** (`hq_ai_capabilities.scopes` + `requires_approval`, §4):
   the fine, per-capability grant.
3. **The autonomy test (P4)**: applied to each *proposed action* — reversible ∧
   bounded ∧ type-target ∧ in-scope ∧ in-budget.

```
sdk.<call>(action):
  require employee.can_execute for write/execute calls
  require capability_scope(employee, action.capability) allows action.resource×verb
  cost = meter(action)                              # §19
  if autonomy_test(action, scope, cost) all pass:   # P4
       apply(action); emit audit event
  else:
       open approval checkpoint (XII §8); park; emit task.approval_requested
```

The permission check is **in the SDK and re-asserted in the SQL entry point**
(defence in depth): even a buggy SDK can't get an unpermitted write past the
`SECURITY DEFINER` guard (P5). Read calls are scoped too (memory permission
matrix, X §6).

## 9. Inputs *(dimension 4)*

The standard input to an employee's `handler` is a **`RunContext`**, assembled by
the SDK before the handler runs:

```ts
interface RunContext {
  task: Task;                         // the XII task being run (payload = the ask)
  identity: EmployeeIdentity;         // who I am (slug, version, department)
  memory: AssembledContext;           // recalled, ranked, budgeted (X §7/§8)
  inbound?: InboundMessage;           // if triggered by a message (IX)
  correlationId: string;              // the saga (P2) — inherited, not chosen
  budgetMicros: number;               // remaining cost budget for this task (§19)
}
```

The handler never gathers its own inputs from raw tables — the SDK assembles them
(permission-filtered memory, the task payload, any triggering message), so inputs
are uniform, permissioned, and traceable.

## 10. Outputs *(dimension 5)*

**Every** handler returns the **standard AI output envelope (P3)**:
`{summary, reasoning, confidence, evidence[], alternatives[], approvalRequired,
actions[]}`. This is the contract the Task Engine stores in `result`, the
verifier (XII §9) checks, the Approval Framework (§15) inspects, and the
Communication Protocol (IX) carries in a reply. Uniform output is what makes
*any* employee's work explainable and gateable without bespoke handling.

## 11. Memory *(dimension 6)*

`ctx.memory` is the X SDK surface (`recall`/`remember`/`resolve`/`forget`), scoped
automatically to the employee's identity and `memory_scope`. Working memory is
auto-bound to the running task (`bound_task_id`) and auto-expired on completion.
The handler "remembers" experiences (episodic, autonomous) and "proposes"
shared-knowledge writes (which route to approval). Recalled ids auto-populate the
output `evidence[]`.

## 12. Tools *(dimension 8)*

The Built `tools_allowed text[]` (labels) becomes a typed **tool registry**. A
tool is a function with: a typed arg schema, a **permission** (which scope it
needs), a **cost** estimator (§19), and a **reversibility/blast-radius**
classification that feeds the autonomy test (P4). The employee invokes a tool via
`ctx.tools.invoke(name, args)`; the SDK checks the permission, meters the cost,
applies P4 (a `send_email` tool is irreversible → approval; a `search_web` tool
is reversible → autonomous), and audits the invocation. Tools are registered as
data (label → registered implementation), so granting a tool is configuration.

## 13. APIs *(dimension 9)* — the gateway

An employee never calls Anthropic/OpenAI/Twilio/Resend/Companies House directly.
It calls **`ctx.api.<provider>.<method>`**, which routes through the **SDK API
gateway** — the single chokepoint for every external call. The gateway:

- **meters cost** (tokens × price, or per-message price) into the task's
  `cost_micros` and enforces the budget (§19) *before* the call (a call that would
  bust budget is refused → approval/escalation);
- **rate-limits & retries** per provider (centralised, not re-implemented per
  employee);
- **audits** every call as an event (`api.called`, with provider/method/cost,
  never the secret);
- **holds the secrets** — API keys live in the gateway/server env (the repo's
  established integration wiring), never in an employee's reach (P5/C4).

This is also where the inert `model_provider/model_name` (Built) become live: the
gateway resolves the employee's configured model for every reasoning call.

## 14. Events *(dimension 10)*

`ctx.events` is the XI SDK surface (`publish`/`subscribe`/`trace`/`signals`). The
employee publishes domain facts (`lead.qualified`); the SDK validates against the
verb registry, stamps identity + correlation, and emits in-transaction. The
employee subscribes declaratively (a registered consumer + subscription rows).
All audit events the SDK emits on the employee's behalf also flow here — one log
(C5).

## 15. Approval framework *(dimension 14)* — autonomy made mechanical

The operational reconciliation of C2, living at the ABI:

- The handler **never decides its own autonomy.** It produces actions; it calls
  `ctx.proposeActions(actions)` (or returns them in the P3 envelope). The **SDK**
  runs the autonomy test (P4) per action.
- **Pass → apply + audit.** **Fail → park** as a `waiting_approval` task with an
  `hq_ai_task_approvals` row (XII §8), surfaced to a human in HQ; on approval the
  SDK applies the action with the same audit trail, attributing the human
  approver.
- The framework is **uniform across all employees and tools** — there is exactly
  one approval path, so a new employee inherits correct human-in-the-loop
  behaviour for free, and an operator reviews one approval queue.

## 16. Security *(dimension 15)* — where C4 is closed

Restating the substrate's sharpest resolution at the layer that enforces it:

- **No ambient authority.** The employee process holds **no DB handle, no API
  key, no service-role token.** Its only capability is "call the SDK."
- **The SDK is the doorman.** Every SDK method checks permission (§8), applies P4
  (§15), meters cost (§19), then calls a `SECURITY DEFINER` entry point that
  re-checks and writes the audit event. The service-role bypass of RLS is a
  narrow, audited platform seam (P5), never handed to the AI.
- **No spoofing, no escalation.** Identity is stamped by the SDK from the
  authenticated context; scopes are least-privilege and default-locked
  (`can_execute=false`, `requires_approval=true`, `scopes:['read']` — the Built
  default). An employee gains a capability only by an explicit registry grant.
- **Everything is audited** to the one event log (C5). A complete answer to *"what
  did this AI do and was it allowed to?"* is `WHERE actor_id = slug ORDER BY id`.

## 17. Lifecycle *(dimension 16)*

```
register ──▶ configure ──▶ activate ──▶ run (claims & runs tasks) ──▶ pause ──▶ retire
   │           │             │              │  heartbeats (§ health)    │         │
   row in    set config,   capabilities    the XII run-loop;           stop     status=
 ai_employees model, prompt active;        proposeActions for          claiming  'disabled';
             scopes        status='idle'   risky work (§15)            new work  version archived
```

- **register** — insert the `ai_employees` row + `hq_ai_capabilities` rows.
- **configure** — model, prompt, scopes, budgets (§18 config).
- **activate** — capabilities `active`; the employee starts claiming tasks (XII).
- **run** — the canonical run-loop (§21).
- **pause/suspend** — stop claiming (capabilities `suspended`); in-flight tasks
  finish or are reaped.
- **retire** — `status='disabled'`, capabilities `deprecated`; history retained;
  callers naming its capabilities re-route to peers (IX/XII) — a graceful,
  data-driven decommission.

## 18. Configuration & Versioning *(dimensions 17 & 18)*

- **Configuration** — a `config jsonb` on the employee (added additively):
  model params, concurrency cap, per-task budget, escalation/manager, feature
  flags. Plus the Built `model_provider/model_name`, `system_prompt`,
  `permissions`, `memory_scope`.
- **Versioning** — an employee, its prompt, and each capability carry a
  **version**. The version is **stamped on every output** (in the P3 envelope's
  provenance) so any past decision is attributable to the exact employee/prompt/
  capability version that made it. Rollout is a new version activated alongside
  the old; **rollback** is re-activating the prior version (config is data, so
  this is a row update, not a deploy). This makes the workforce *auditable across
  time* and changes *reversible*.

## 19. Cost tracking *(dimension 19)*

- **Every** external call (LLM tokens, SMS, email, embedding) is metered by the
  gateway (§13) into the running task's `cost_micros`, against a budget resolved
  as `task.cost_budget_micros → capability.max_cost_micros → employee config →
  global default`.
- **Budgets are enforced pre-call** (a call that would exceed budget is refused →
  the action fails P4's "in-budget" condition → approval/escalation), so cost
  can't run away silently.
- **Roll-ups**: per-task, per-employee, per-capability, per-day cost on the golden
  signals + The Pulse. Cost is a first-class operational signal, not a
  month-end surprise — the answer to *"what is the workforce costing, by whom,
  doing what?"*

## 20. Health checks & Metrics *(dimensions 11 & 12)*

- **Health** — the Built `ai_employees.status` (idle/working/waiting_approval/
  blocked/error/disabled) + `last_activity_at`, driven by the SDK: a running
  runner heartbeats (XII §10), a stalled/crashed one is reaped and flips to
  `error`. A liveness/readiness probe answers *"is this employee healthy and
  claiming work?"* The reaper + heartbeat make a dead employee *visible*, not
  silently absent.
- **Metrics** — the Built `ai_employee_task_metrics` (tasks done, success rate,
  latency) + cost (§19) + comms responsiveness (IX RTT). These feed the IX/XII
  **load policy** (route work to healthy, fast, in-budget, low-failure
  employees) and the operator dashboards.

## 21. Audit logging *(dimension 13)* & the canonical run-loop

**Audit** — every SDK call emits an `hq_events` row (the system of record, C5);
`activity_log` and timelines are projections of it (XI). Nothing an AI does is
un-logged: reads (`memory.read`), writes (`memory.written`), messages
(`ai.message.*`), task transitions (`task.*`), tool/API calls (`tool.invoked`,
`api.called`), approvals. The audit is uniform because it is emitted by the SDK,
not by each employee.

**The canonical run-loop** — the one shape every employee runs (the generalised,
hardened version of the Research AI / Lead Qualification AI runner pattern):

```ts
sdk.runEmployee({
  slug: 'research-ai',
  capabilities: ['research.company', 'enrich.company'],
  handler: async (task, ctx) => {
    // 1. inputs are already assembled (task payload + permission-filtered memory)
    const context = ctx.memory;                       // X, budgeted (§9)
    // 2. reason (model call via the gateway — metered, audited, in-character)
    const draft = await ctx.api.anthropic.reason({ mission: ctx.identity.mission,
                                                    context, task });
    // 3. produce the standard output envelope (P3)
    const out: AIOutputEnvelope = shape(draft);
    // 4. remember the experience (episodic, autonomous)
    await ctx.memory.remember({ class: 'episodic', type: 'research',
                                title: ..., body: out.summary, boundTask: task.id });
    // 5. propose actions — the SDK applies the autonomy test (§15) per action:
    //    write report to memory (reversible→auto); anything external→approval
    await ctx.proposeActions(out.actions);
    return out;                                        // → XII verify/complete
  },
});
// the SDK owns: claim, lease+heartbeat, context assembly, permission checks,
// P4, cost metering, audit emit, checkpoint, verify hand-off, completion.
// The author wrote ONLY the handler. That is the blueprint.
```

---

## 22. The reference employee (the blueprint, proven)

Re-casting the **already-shipped Lead Qualification AI** as an SDK instance shows
every dimension is real, not aspirational:

| Dimension | Lead Qualification AI, via the SDK |
|-----------|------------------------------------|
| Identity | `lead-qualification-ai` (Built row); stamped on every action. |
| Mission | "Decide qualified / disqualified / needs-review for inbound construction leads against CrewFlow's ICP." |
| Capabilities (§4) | `qualify.lead` (confidence 90, scopes `[read, write:memory, write:hq_status]`, `requires_approval=false` — reversible). |
| Inputs (§9) | the qualify task payload + recalled memory (the Research AI report, by reference, IX §7 → X). |
| Outputs (§10) | P3 envelope: verdict + reasoning + fit score as confidence + the report as evidence. |
| Memory (§11) | reads the research report (permissioned); remembers the verdict (episodic). |
| Permissions/Approval (§8/§15) | verdict + HQ status move are reversible/bounded → **autonomous** (why it ships autonomous today, principled by P4). |
| Tools/APIs (§12/§13) | the reasoning model via the gateway, metered. |
| Events (§14) | emits `lead.qualified` / `lead.disqualified` → unblocks downstream tasks (XII). |
| Cost (§19) | the qualification model call metered to the task. |
| Audit (§21) | every read/decision/status-move an `hq_events` row. |
| Versioning (§18) | the scoring prompt is versioned; a tuning change is a new version, rollback-able. |

The *current* employee already does the domain work; the SDK is what makes the
**next** ten employees cost a configuration, not a project (C1) — and makes this
one's autonomy, cost, and audit uniform with all of them.

---

## 23. Observability, Security recap, Testing

**Observability** — an SDK golden-signals view aggregates the four subsystems per
employee: tasks (throughput/latency/failure), comms (RTT/escalations), memory
(recall latency/denials), cost (spend vs budget), health (heartbeat). One pane:
*"is the workforce healthy, fast, in-budget, and behaving?"*

**Security recap (P5/C4)** — no ambient authority; SDK-as-doorman; least-
privilege default-locked scopes; no spoofing; everything audited to one log;
service-role bypass is a narrow audited seam, never the AI's.

**Testing (six gates)** —

| Gate | What it proves |
|------|----------------|
| 3 unit | permission composition (§8), the autonomy classifier (P4), cost metering & budget enforcement, capability resolution, version stamping — pure `lib/*`. |
| 4 integration (real Postgres) | a handler cannot write outside its scope (the entry point refuses even if the SDK is bypassed); an irreversible action parks for approval and applies exactly once on approve; cost over budget refuses pre-call; capability grant → routable; retire re-routes callers. |
| 5 security | no-spoofing; default-locked posture; entry-point grants; secrets never reach the employee; pinned in source. |
| 6 e2e | the HQ employee/approval/cost surfaces behind the auth wall (anonymous → 307 → /login, never paints — the established pattern). |

---

## 24. Conflicts resolved & open questions

**Resolves (the SDK is where the AI-workforce conflicts close):**
- **C1 (conflicting rosters / numbering)** — the roster is `ai_employees` rows and
  the capability registry is `hq_ai_capabilities` rows; 13 or 30 employees are
  just different data. Callers name capabilities, never employees. Growth is a
  migration, not a rewrite.
- **C2 (humans always decide vs autonomy)** — the approval framework (§15) applies
  P4 uniformly at the ABI; reversible/bounded acts autonomously, risky acts
  human-gate, per action, for every employee.
- **C4 (AI never bypasses security)** — closed structurally (§16): the AI has no
  ambient authority; the SDK is the only door, and it checks, meters and audits
  every call.
- **C5 (parallel audit logs)** — the SDK emits one event log; other logs are
  projections.

**Open questions for a future directive:**
1. **Employee runtime topology.** Do employees run as (a) per-tick serverless
   invocations claiming tasks (matches today's cron-driven runners, cheapest), or
   (b) long-lived workers heartbeating continuously (lower latency, more infra)?
   The SDK run-loop supports both; the deployment choice is a directive. *Default
   recommendation: serverless task-claim now; long-lived only where latency
   demands it.*
2. **Model/provider strategy.** Per-employee model choice is config; a portfolio
   policy (which model for which capability, cost/quality trade-offs) is a
   product decision the gateway will enforce once set.
3. **Inter-employee trust & delegation limits.** How far may an employee delegate/
   spend on another's behalf? The capability scopes + budgets express it; the
   *policy* (e.g. a junior may not spend more than £X without manager approval) is
   a future governance decision the framework already has the hooks for.

---

## 25. Closing — what "complete" means

With Volumes IX–XIII specified, the AI substrate is fully **designed**: the bus
every fact flows through (XI), the memory every employee shares and keeps (X), the
protocol they converse over (IX), the engine that runs their work with human
checkpoints and crash recovery (XII), and the single safe interface that binds it
all and makes every employee a configured instance of one blueprint (XIII). Per
the directive, **no individual AI employee is designed until this block is
complete** — and now the mould exists. When a future CEO Directive authorises
implementation, this block tells a new engineering team *what* to build, *in what
order* (XI → X → IX/XII → XIII, per the README dependency graph), and *how each
piece reuses what is already shipped* — without ambiguity, and without rewriting
the working product.

The three-question gate for everything that follows: **Does it align with the
Bible? Does it fit the substrate? Can every future AI employee reuse it?** This
block is the substrate the third question now has a concrete answer against.

---

*Volume XIII of the AI Substrate — the capstone. Architecture only — no code, no
production change, no PR. This completes the Substrate Block (Volumes IX–XIII).*
