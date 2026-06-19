# Chapter 07 — AI Employee Framework

## Purpose

This chapter specifies the OS's **process model**: how an AI employee is defined, scheduled, run, gated, recorded, and held to account. It is the chapter that earns the CEO's distinction — *"I do not want AI assistants. I want AI employees."* An assistant answers a prompt and forgets. An employee has an identity, a manager, a budget, capabilities it holds, memory it carries between shifts, a queue of work, a performance record, and an immutable audit trail — and every consequential thing it does crosses a human-approval gate. This chapter is the runtime that makes those properties real and uniform across all twelve employees, so that adding the thirteenth is *configuration*, not a new executor.

The framework already half-exists. The six-dimension SDK (`lib/ai-employees/framework/`) defines employees as data; eleven are seeded as `foundation:true` (inert config), and one — Research AI — actually executes through a bespoke path (`hq-research.ts` + `research-llm.ts`). The OS's job is to **generalise that one live path into a single runtime every employee shares**, and to wire it to the spine (Ch.04), the approval gate (Ch.13), the capability chokepoint (Ch.14), and the memory graph (Ch.12). Nothing here replaces the SDK; it animates it.

## Goals

- **One runtime, every employee.** A single `runEmployee()` execution path. No per-employee bespoke executor ever again; Research AI's path is refactored *into* this runtime, not duplicated.
- **A precise lifecycle.** The run is a finite-state machine — `perceive → plan → gate → act → record → reflect` — with explicit, persisted states (`ai_employee_runs.state`, Ch.03 §03.3) so any run is resumable and any stall is visible.
- **The tool registry.** Every capability an employee can exercise is a typed tool that declares the `required_capability` it spends; the registry is the AI's syscall table, gated by `authorize()` (Ch.14) and, for danger, by approvals (Ch.13).
- **Cost is a first-class metric (P9).** Tokens and dollars are metered per run, per employee, per day, with budgets and a circuit breaker. An employee that overspends is *suspended*, not silently allowed to bankrupt a department.
- **Observable by construction (P3).** Every transition emits an `ai.*` event; the Runtime/Performance/Audit dimensions are *projections* of `ai_employee_runs`/`_tool_calls` and the spine — never separately maintained truth.
- **Safe by default (P4/P5).** `foundation:true` until `permissions.can_execute`; least privilege; human-in-the-loop for every side-effect above an employee's autonomous decision limit.

**Non-goals:** the per-employee dossiers — identity, KPIs, escalation, budgets per head (Ch.08); the approval *workflow and inbox* UI (Ch.13); the capability *catalogue and `authorize()` internals* (Ch.14); memory *internals* — embeddings, edges, recall (Ch.12); Mission Control's workforce view (Ch.09). This chapter owns the **engine**; those chapters own what plugs into it.

---

## Architecture

### The process metaphor, made literal

| OS concept | CrewFlow employee | Realised by |
|---|---|---|
| Program image (static) | Identity + Configuration | ♻️ `defineEmployee()` / `AIEmployeeDefinition` |
| Process (running) | A **run** | `ai_employee_runs` row (Ch.03 §03.3) |
| PID / process table | The employee + its active runs | `ai_employees` ♻️ + the runs partial index |
| Scheduler | Triggers (schedule/event/manual/delegation) | `ai_employee_schedules` + the spine + the queue |
| Syscall | A **tool call** | `ai_employee_tool_calls` (Ch.03 §03.4) |
| Protection ring | The **gate** (`authorize()` + approvals) | Ch.14 + Ch.13 |
| Memory (shared) | The memory graph | ♻️ `hq_memories` + edges (Ch.12) |
| Accounting (cgroups) | The budget governor | `cost_usd`/token columns + circuit breaker |
| dmesg / audit | `ai.*` events + `admin_activity_log` | Ch.04 + Ch.15 |

### The six dimensions: which are image, which are projection

The SDK's six dimensions (♻️ `dimensions.ts`) split cleanly into **static image** and **live projection**, and the OS makes that split load-bearing:

- **Identity, Configuration** — the *image*. Authored as code (`employees/*.ts`), pure, server/client-safe, version-controlled. This is "config not code": the model, system prompt, knowledge sources, declared tools, and `permissions`. Changing what an employee *is* is a code review, not a runtime mutation.
- **Runtime, Performance, Audit** — *projections*. Computed from `ai_employee_runs`, `ai_employee_tool_calls`, `ai_employee_tasks`, and the spine. The employee page renders these live; they are never a second source of truth (P1). `getEmployeeProfile(slug)` composes the image with these projections.
- **Memory** — *shared state*. Read from / written to `hq_memories` via the graph (Ch.12), scoped by the employee's `memorySources`.

This is why an employee can be improved (Configuration edit, shipped behind a flag) without losing its history (Audit/Performance persist in the spine), and why a brand-new employee starts with an honest empty record rather than invented figures — exactly the `foundation` discipline the SDK already enforces.

### The run loop — the heart of the framework

A **run** is one execution attempt: the atomic unit of AI work, cost, and trace (the glossary's "Run", Ch.01). Every run is the same six phases, regardless of employee or trigger:

```
            ┌─────────────────────────── one run (correlation_id) ───────────────────────────┐
 trigger ─▶ PERCEIVE ─▶ PLAN ─▶ GATE ─▶ ACT ─▶ RECORD ─▶ REFLECT ─▶ done
            (gather)    (LLM)   (auth/   (tools) (events)  (memory)
                                approval)   ▲                          
                                  │         │ loop: a multi-step plan revisits PLAN→GATE→ACT
                                  │         └──────────────────────────────────┘
                                  ▼
                          awaiting_approval ──(granted)──▶ ACT
                                  └────────────(rejected/expired)──▶ done (no side-effect)
```

1. **Perceive.** Assemble the run's *context*: the triggering event/task, relevant rows under service-role, and a bounded **memory recall** (Ch.12 — semantic + recent episodic, scoped to the employee). Perception is read-only and cheap; it never mutates state. The context is capped (token budget) so a noisy world cannot blow the prompt.
2. **Plan.** One LLM call (the employee's configured `model`/`systemPrompt`, ♻️ `research-llm.ts` pattern: dynamic-import the provider SDK, primary Anthropic, fallback OpenAI). The model returns either a final answer or a **tool-call request** (name + args). Plans are structured (typed tool schema), never free-text shell-outs. Emits `ai.planned`.
3. **Gate.** *Before any side-effect*, the requested tool's `required_capability` is checked at the single chokepoint `authorize(principal, capability, context)` (Ch.14). If the action exceeds the employee's autonomous **decision limit** (e.g. a refund over its monetary threshold), the run **pauses** into `awaiting_approval`: an `hq_approval` row is created (Ch.13), `approval.requested` is emitted, and the run yields. It resumes only on `approval.granted`. This is P4 made mechanical — autonomy is *granted, capability by capability*, never assumed.
4. **Act.** Execute the tool through the registry. The tool is the *only* way an employee touches the world; there is no ambient capability. Each call is recorded in `ai_employee_tool_calls` with its args, result summary, the capability it spent, and any approval id. Emits `ai.tool_called`.
5. **Record.** Write the run's outcome as spine events (`ai.run_completed` / `ai.run_failed`), update `ai_employee_runs` (tokens, `cost_usd`, latency, state), and append to the immutable audit (`admin_activity_log`, ♻️). State and narrative commit together (P1) — a run's effects and its story are inseparable.
6. **Reflect.** Optionally distil durable knowledge into the memory graph (Ch.12) — `memory.asserted`, with provenance pointing at this run. Reflection is what makes an employee *learn its job* across shifts rather than restart cold each time.

A simple run (e.g. "draft a summary") is one pass: perceive → plan → record (no side-effect, no gate). A consequential run (the dunning flow of Ch.02) loops PLAN→GATE→ACT until the plan is complete, pausing at the gate for the human. Multi-step is bounded by a **max-steps** ceiling and the budget governor (below).

### The lifecycle FSM

`ai_employee_runs.state` persists the phase so a run survives a crash and is resumable (P8). The legal transitions:

```
 triggered ─▶ perceiving ─▶ planning ─▶ gating ─┬─▶ acting ─▶ recording ─▶ reflecting ─▶ done
     │            │            ▲                 │              │
     │            │            └──── (more steps)│              │
     │            │                              ▼              │
     │            │                        awaiting_approval    │
     │            │                         │   │               │
     │            │              (granted)──┘   └──(rejected/   │
     │            │                  │              expired)──▶ recording ─▶ done
     ▼            ▼                  ▼
  failed       failed             suspended  (budget breaker / manual halt)
```

- **Resting/terminal states:** `done`, `failed`. **Parked:** `idle` (created but not yet started — the queue's pre-flight). The partial index `where state not in ('idle','done','failed')` (Ch.03 §03.3) is precisely the set of runs **needing attention** — in-flight, awaiting approval, or suspended — which is what Mission Control's "what is happening" panel reads (Ch.09).
- **`awaiting_approval`** is non-terminal and durable: the run is persisted, the worker releases, and a later `approval.granted` event re-enters the run at ACT. A run can wait hours for a human without holding a process open.
- **`suspended`** is the circuit breaker tripping (budget, error-rate, or manual). It emits `ai.suspended`; resuming is a human action.
- Every transition is idempotent on `(run_id, target_state)` so a redelivered wakeup never double-advances.

### Triggers — the scheduler

Four ways a run is born (`ai_employee_runs.trigger`):

| Trigger | Source | Mechanism |
|---|---|---|
| `schedule` | Recurring shift | `ai_employee_schedules.cron` → the Vercel cron drainer enqueues due employees (♻️ the `research-drain` cron pattern) |
| `event` | The spine | An employee *subscribes* to verbs; the event consumer enqueues a run with `causation_id` = the triggering event |
| `manual` | An operator | Mission Control "run now" / "ask" → `enqueueTask()` |
| `delegation` | Another employee | A manager employee calls the `delegate` tool → a child run, same `correlation_id`, `causation_id` = the parent's run-started event |

Every trigger lands the same way: a row in `ai_employee_tasks` (♻️, now with the additive `state`/`priority`/`budget_usd`/`deadline`/`correlation_id`/`requested_by` columns, Ch.03 §03.6) and an `ai.triggered` event. The runtime drains the queue; the spine and cron together guarantee a due run is never lost (the cron is the dead-worker safety net, exactly as today).

### Components & where they live

| Component | Location | Responsibility |
|---|---|---|
| Employee definitions (image) | ♻️ `lib/ai-employees/framework/employees/*.ts` | What each employee *is* (pure config) |
| The SDK base + dimensions | ♻️ `framework/base.ts`, `dimensions.ts`, `registry.ts` | Typed contract, composition, the roster |
| The runtime | `server/ai/runtime.ts` *(new)* | `runEmployee()`, the FSM driver, `server-only` |
| The tool registry | `server/ai/tools/*` *(new)* | Typed tools, each binding a `required_capability` |
| The model adapter | ♻️ generalise `research-llm.ts` → `server/ai/model.ts` | Provider dynamic-import, fallback, token metering |
| The budget governor | `server/ai/budget.ts` *(new)* | Per-run/employee/day ceilings + breaker |
| The scheduler/queue | ♻️ `ai_employee_tasks` + cron drainer | Trigger → enqueue → drain |
| Projections | `server/services/hq-employees.ts` *(extend)* | Compose image + Runtime/Performance/Audit |

Pure logic (FSM transition table, budget arithmetic, tool schemas) lives in `lib/ai/*` so it is unit-testable without a database; the `server/ai/*` layer is the `import "server-only"` shell that touches Supabase under service-role (♻️ the existing services discipline, Ch.05).

---

## Database design

Owned tables are catalogued in **Ch.03** and not redefined here:

- **`ai_employee_runs`** (§03.3) — one row per run: trigger, `state` (the FSM), `model`, `input_tokens`/`output_tokens`, `cost_usd`, `latency_ms`, `correlation_id`, timing, `error`. Indexed by `(employee_slug, created_at desc)` and the in-flight partial index.
- **`ai_employee_tool_calls`** (§03.4) — one row per tool invocation: `tool`, `args`, `result_summary`, `required_capability`, `approval_id`, `ok`. The AI's syscall log.
- **`ai_employee_schedules`** (§03.5) — recurring triggers (`cron`, `enabled`, `next_run_at`).
- **`ai_employee_tasks`** (♻️ + §03.6 additive columns) — the work queue and the unit of delegation.

**Read (♻️, never altered):** `ai_employees` (the roster row — slug, status, config snapshot), `ai_employee_memory` and the `hq_memories` graph (Ch.12). **Writes elsewhere:** `hq_events` (the spine, via `emitEvent` in the same transaction as the run-state change), `hq_approvals` (when the gate pauses), `admin_activity_log` (the immutable audit). **Access pattern:** all reads/writes are service-role (`RLS:hq`); a JWT client never sees a run. The hot query — "what is each employee doing now" — is the in-flight partial index, O(active-runs), independent of company count.

---

## APIs

### The runtime entry point

```ts
// server/ai/runtime.ts — server-only. The one way a run happens.
async function runEmployee(input: {
  slug: EmployeeSlug;                       // typed against the registry
  trigger: 'schedule' | 'event' | 'manual' | 'delegation';
  correlationId: string;                    // new for manual/schedule; inherited for event/delegation
  causationId?: number;                     // the spine event that caused this run
  task?: TaskRef;                           // the ai_employee_tasks row, if any
  input?: Json;                             // trigger-specific payload (the event, the question)
}): Promise<RunResult>;

type RunResult =
  | { state: 'done'; output: Json; costUsd: number; tokens: number; runId: string }
  | { state: 'awaiting_approval'; approvalId: string; runId: string }
  | { state: 'failed'; error: string; runId: string }
  | { state: 'suspended'; reason: 'budget' | 'error_rate' | 'manual'; runId: string };
```

`runEmployee` is the FSM driver: it creates the `ai_employee_runs` row, emits `ai.run_started`, and walks perceive→…→reflect, persisting `state` at each boundary and emitting the matching `ai.*` event. It is **idempotent per run**: re-invoking for a run already past a phase resumes from the persisted state, never repeats a committed side-effect.

### The tool contract

```ts
// A tool is the ONLY way an employee touches the world.
type ToolDef<Args, Result> = {
  name: string;                              // 'email.send' | 'billing.refund' | 'customer.read'
  description: string;                       // shown to the model; the tool's "man page"
  schema: ZodSchema<Args>;                   // typed args — malformed calls are rejected pre-execution
  requiredCapability: CapabilityKey;         // spent at the gate (Ch.14)
  riskTier: 'low' | 'medium' | 'high' | 'critical';  // routes the approval policy (Ch.13)
  run: (args: Args, ctx: ToolContext) => Promise<Result>;  // executes under service-role
};

function defineTool<A, R>(def: ToolDef<A, R>): ToolDef<A, R>;   // registry registrant
```

- **`requiredCapability` is mandatory** — a tool with no capability cannot be registered. This is what makes the gate total: there is no path to a side-effect that skips `authorize()`.
- **`riskTier`** + the employee + the args (e.g. monetary amount) feed `hq_approval_policies` to decide `auto` / `require_human` / `dual_control` (Ch.13).
- Tools are **pure-ish**: side-effects only through other service functions (Ch.05), so a tool is testable with a fake `ToolContext`. Read tools (`customer.read`) and write tools (`email.send`) are the same shape; the capability and risk tier carry the asymmetry.

### Triggering & scheduling

```ts
async function enqueueTask(t: {                      // manual/delegation ingress
  slug: EmployeeSlug; title: string; priority?: number;
  budgetUsd?: number; deadline?: string; requestedBy: string;
  correlationId: string; payload?: Json;
}): Promise<{ taskId: string }>;

function subscribesTo(slug: EmployeeSlug): Verb[];    // which spine verbs wake this employee
```

The event consumer (Ch.04 `drain`) reads new spine events, asks each subscribed employee's `subscribesTo`, and calls `enqueueTask` — so "Finance AI wakes on `invoice.payment_failed`" is *declared*, not hard-wired. **Versioning:** `runEmployee`/`ToolDef` are internal server contracts (no external API); they evolve with the code. The *stable* contracts are the `ai.*` **verbs** (Ch.04) and the **capability keys** (Ch.14) — those are versioned like schema and changed only by ADR.

### Error shapes

A run never throws past `runEmployee`; it resolves to a `RunResult`. Internally, a `ToolError { capability, retryable, cause }` distinguishes a denied gate (terminal — emits `ai.run_failed` with `reason:'unauthorized'`) from a transient provider error (retried with backoff, ♻️ the research path's resilience). A malformed model tool-call (schema mismatch) is fed back to the model once as a correction before the run fails.

---

## UI behaviour

The operator surface is the **employee page** (♻️ the six-dimension profile already designed) made live, plus the **workforce panel** in Mission Control (Ch.09). What the operator sees and does:

- **The roster** — every employee as a card: avatar/accent (♻️), status (`idle`/working/`awaiting_approval`/`suspended`), the current task, today's cost vs budget, and a live pulse dot that is *real* (driven by the broadcast of `ai.*` events, Ch.06) — not the cosmetic LiveDot of today.
- **The run view** — for an in-flight run: the FSM state, the plan, the tool calls as they happen (streamed via broadcast), the running cost meter, and — if `awaiting_approval` — a prominent card with the *exact projected effect* ("Refund £240 to Acme") and Approve/Reject (Ch.13).
- **The six dimensions** — Identity/Configuration (static), Runtime (now), Memory (what it knows), Performance (KPIs), Audit (everything it did). Each is the projection described above; nothing is invented.
- **States.** *Loading:* skeletons over the last-known snapshot (SSR-first, ♻️). *Empty:* an honest "no runs yet — foundation" badge for an employee not yet executing. *Error:* the run's `error` and a "retry" that enqueues a fresh run (never silently). *Live:* prepend-on-broadcast; the page never needs a manual refresh (P10).
- **Operator actions:** "Run now" (manual trigger), "Ask" (a manual run with a question), "Pause employee" (suspend — a guarded action), "Adjust budget" (a settings change, audited). Keyboard: `⌘K` to jump to an employee (Ch.10); `a`/`r` to approve/reject a focused approval.
- **Accessibility:** state changes announced via ARIA live regions; the pulse dot is not the *only* signal (status is also text); colour-accent is paired with an icon and label (♻️ the 007 design-system discipline).

---

## Permissions

- **Every tool spends a capability.** `ToolDef.requiredCapability` is checked at the single chokepoint `authorize(principal, capability, ctx)` (Ch.14) before ACT. No capability ⇒ no registration ⇒ no side-effect path. This is P5 (least privilege) enforced structurally.
- **Employees hold capabilities via roles.** An employee is a principal in `hq_principal_roles` (`principal_type='ai_employee'`, `principal_id=slug`); its role grants a *minimal* capability set (Ch.08 lists each employee's exact set). The default for a new employee is **read/analyse/draft only** — exactly the SDK's `locked([...])` default (♻️ `finance.ts` ships `locked(["read","analyze","draft"])`).
- **`foundation` until executable.** The SDK's `foundation:true` holds until `permissions.can_execute`; the runtime refuses to ACT for a foundation employee — it may perceive/plan/draft, but every write tool is gated closed. Granting execution is a deliberate, audited capability grant (`permission.role_granted`), per employee, reversible by flag (P7).
- **Decision limits & approvals.** Below an employee's autonomous threshold and `auto` policy → the gate passes and the tool runs. Above it, or any `high`/`critical` risk tier → `require_human` (or `dual_control` for the most dangerous), pausing the run (Ch.13). The thresholds are per-employee data (Ch.08), not code.
- **The principal is never the employee's "opinion."** The gate authorises the *capability*, not the model's confidence. A confident model with no capability is denied; a cautious model with capability and an `auto` policy proceeds. Authority is data, not vibes.

---

## Failure handling

- **LLM provider down / rate-limited.** The model adapter fails over Anthropic → OpenAI (♻️ exactly `research-llm.ts`), then retries with backoff; persistent failure resolves the run `failed` with `ai.run_failed`, leaving no partial side-effect (the failure is before or between gated tools, each of which is individually recorded).
- **Tool failure.** A `retryable` tool error backs off and retries within the run's step budget; a terminal error fails the run. Because each tool call is its own `ai_employee_tool_calls` row committed with its event, a multi-step run that fails at step 3 has steps 1–2 durably recorded and *not* rolled back — the audit is truthful about what actually happened.
- **Budget exceeded.** The governor checks the ceiling before each LLM/tool call; crossing the warn line emits `ai.budget_warned`, crossing the hard line emits `ai.budget_exceeded`, trips the breaker, and moves the run (and optionally the employee) to `suspended`. No silent overspend (P9).
- **Run crash mid-flight** (serverless timeout/redeploy). The persisted `state` is the recovery point: the cron drainer finds in-flight runs older than a threshold and resumes `runEmployee`, which picks up from the last committed phase. Idempotent transitions mean no double side-effect.
- **Approval never answered.** `hq_approvals.expires_at` lapses → `approval.expired` → the run resumes at RECORD with *no* side-effect and a `done` state annotated "expired". The world is never changed by a stale approval.
- **Poison task.** A task that fails N times is dead-lettered (♻️ the spine's `dead_events` discipline, Ch.04) with `ai.run_failed` and a `system.alert_raised`; one bad task never wedges an employee's queue.

## Edge cases

- **Concurrent runs for one employee.** Allowed, but bounded by a per-employee concurrency cap (a queue lease). Two runs that would touch the same aggregate serialise on the queue, not in the model — the spine's per-aggregate ordering (Ch.04) keeps their *events* coherent.
- **A run that triggers itself** (employee subscribes to a verb it also emits). Guarded by a **loop breaker**: a run won't enqueue a child whose `(slug, verb)` already appears in its own `correlation_id` chain within a window. Causation references a strictly smaller event id (Ch.04), so true cycles are impossible; the breaker stops *amplification*.
- **Delegation cycle** (A delegates to B delegates to A). Bounded by a delegation **depth limit** on the `correlation_id` chain; exceeding it fails the child run with `ai.escalated` to a human.
- **Model returns a tool not in the registry / malformed args.** Rejected by the schema before ACT; the model is given one structured correction; a second failure fails the run (never executes an unvalidated call).
- **Two approvers act simultaneously** on one approval. The decision is a single-row compare-and-set on `hq_approvals.status`; the loser gets "already decided" (Ch.13). The run resumes once.
- **Config changed mid-run** (an employee redeployed while a run is in flight). The run holds the *snapshot* it started with (captured at PERCEIVE); the new config applies to the next run. No run ever straddles two definitions.

## Performance

- **Run latency budget.** Perceive < 200 ms (indexed reads + bounded recall), Plan = the LLM call (the dominant term; streamed), Gate < 50 ms (one `authorize` + maybe one insert), Act = the tool's own budget. A no-side-effect run is "one LLM call + two indexed writes".
- **Token budget.** Context is capped at PERCEIVE (recall is bounded, Ch.12); the system prompt is small; tool schemas are compact. This bounds both cost and latency at the source rather than hoping prompts stay small.
- **Queue depth & concurrency.** Work is levelled by the queue; a burst (e.g. a bulk import emitting thousands of `invoice.*` events) enqueues thousands of tasks that drain at a controlled rate within per-employee concurrency caps — the workforce degrades to *slower*, never to *overloaded* or *overspent*.
- **At 1M companies.** The workforce does **not** scale by running more model calls per company; it scales by (a) **budgets** that bound spend per employee/day, (b) **queue back-pressure** that bounds concurrency, (c) **event-driven triggers** so employees act on *what changed*, not by polling every org, and (d) **bounded recall/context** so a single run's cost is independent of total company count. The honest answer to the Golden Rule: an AI workforce is only viable at a million companies if its marginal cost is *governed* — which is why the budget governor is core, not an add-on. When queue volume outgrows `ai_employee_tasks`, it graduates to `pgmq` behind the same `enqueueTask` contract (Ch.17) — no caller changes.

## Security

The AI runtime is the OS's highest-stakes trust boundary: it takes **untrusted input** (tenant data, customer emails, web content) and feeds it to a model that can request **privileged actions**. The defences (full treatment in Ch.16):

- **Prompt injection is assumed, not hoped against.** Tenant/customer/web text is *data*, never instructions. The system prompt is fixed config (the image); retrieved content is clearly delimited and never grants capability. Crucially, **injection cannot escalate authority**: the gate authorises the *capability the tool declares*, regardless of what the model was talked into wanting. A customer email saying "issue yourself a refund" produces, at most, a `billing.refund` tool *request* that the gate denies (Support AI lacks it) or routes to a human (Finance AI's policy). The blast radius of a successful injection is bounded by the employee's capabilities and approval gates — least privilege is the containment.
- **No ambient authority.** There is no shell, no arbitrary HTTP, no raw SQL tool. Every action is a typed, capability-bound tool. The model cannot reach what no tool exposes.
- **No secrets in prompts.** Provider keys, service-role keys, and tenant secrets never enter a model context. Tools call services that hold secrets server-side; the model sees results, not credentials.
- **Output is data too.** A model's text output is rendered as content, never executed; tool *args* are schema-validated; nothing the model emits is `eval`'d.
- **Tenant isolation preserved.** Tools read under service-role but *scope by the run's context*; cross-tenant reads require an explicit capability and are audited. The runtime never widens tenant boundaries — it operates on the HQ side of them.

## Testing

- **FSM transition tests.** Property tests asserting only legal transitions occur; a crash-and-resume at every state yields exactly-one set of side-effects (idempotency).
- **Tool contract tests.** Each tool: schema rejects malformed args; `requiredCapability` is present; a denied gate prevents `run()` from being called at all (the gate is *before* execution, proven by a spy).
- **Budget breaker tests.** A run scripted to exceed the ceiling trips at the boundary, emits `ai.budget_exceeded`, and executes **no** further tool — asserted, not assumed.
- **AI evals (golden tasks).** Per employee, a fixture set of representative inputs with rubric-scored expected behaviour (did it choose the right tool? respect its decision limit? escalate when it should?). Evals run in CI as a quality gate before any autonomy is widened — the "performance review" made executable (Ch.08).
- **Injection red-team.** A corpus of adversarial inputs (refund-yourself, exfiltrate-data, ignore-instructions) asserting the gate denies/escalates and no capability is escalated. A regression here blocks release.
- **RLS tests.** `ai_employee_runs`/`_tool_calls` unreadable by anon/JWT; readable only by service-role (♻️ the existing pattern).
- **Event-contract tests.** Every `ai.*` verb's payload shape pinned (Ch.04), so a runtime change that drifts an event fails CI.

## Monitoring

- **Events emitted (Ch.04):** `ai.triggered`, `ai.run_started`, `ai.planned`, `ai.tool_called`, `ai.run_completed`, `ai.run_failed`, `ai.budget_warned`, `ai.budget_exceeded`, `ai.suspended`, `ai.escalated`. Every phase is observable from the spine alone.
- **Metrics (Ch.15):** runs/min (per employee, per trigger), **cost $/day per employee** and vs budget (the P9 headline), success rate, p50/p95 run latency, tool-call error rate, approval rate (auto vs human) and approval latency, escalation rate, queue depth & lag, suspended-employee count.
- **Golden signals:** *cost burn-rate* (is any employee trending to blow its daily budget?), *escalation rate* (is an employee over its head — a config/eval problem?), *queue lag* (is the workforce falling behind events?), *failure rate* (provider or tool trouble). Each has an alert and an SLO; budget burn and a non-zero suspended count page the operator.
- **Audit:** every run and tool call is in `admin_activity_log` (♻️, immutable) in addition to the spine — the dual record the dossier's "Audit history" field requires (Ch.08).

## Future expansion

- **Wider agentic loops.** The run loop already supports PLAN→GATE→ACT iteration; the seam for richer multi-step planning (sub-goals, scratchpad memory) is the loop bound + step budget — raise them per employee as evals justify, behind a flag.
- **Learned autonomy.** A measured **trust score** (from evals + approval history) can raise an employee's `auto` thresholds *within* policy — autonomy granted on *evidence*, never assumed (P4). The `hq_approval_policies` table is the dial; the eval suite is the evidence.
- **Employee-to-employee org chart.** Delegation is already first-class (`trigger='delegation'`, shared `correlation_id`); the manager/reports edges (Ch.08) become a real routing graph as more employees execute.
- **Queue graduation.** `ai_employee_tasks` → `pgmq` (visibility timeouts, DLQ, fairness) when measured depth demands it (Ch.17) — same `enqueueTask` contract.
- **Provider portability.** The model adapter abstracts the provider; adding a model/provider is a config change in the image, not a runtime change — the framework is deliberately model-agnostic so the workforce outlives any one vendor.
