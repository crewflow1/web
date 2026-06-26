# Volume XII — Task Engine

> **Substrate Block, document 4 of 5.** Architecture only. Read `./README.md`
> first; this volume uses the shared primitives (P1–P7) and does not redefine
> them.
>
> **For the *built* engine, read the companion.** This volume is the full intended
> design. The part that is **shipped** (the generic table, the guard, and the
> seven entry points — CEO Directive #012 / D-02, PR-A) is described, reconciled
> with the code and without SQL, in
> [`task-engine-lifecycle.md`](./task-engine-lifecycle.md) — the canonical
> engineering reference for how a task lives and dies today. The decision is
> [ADR 0004](../decisions/0004-generic-task-engine.md).
>
> *Provisional numbering "XII" per the CEO directive; collides with the existing
> Master Roadmap volume. Tracked in the canonical renumber.*

---

## 1. Purpose & scope

**The job, in one sentence:** be the substrate's **process scheduler** — the
universal, durable unit of AI work, with a full lifecycle, dependencies,
priorities, approval checkpoints, verification, crash recovery, and retry, that
every AI employee runs *through* and every other subsystem hangs work *on*.

A "task" is the atom of the workforce. *Research this company. Qualify this lead.
Embed this memory. Sweep these SLAs. Get human approval for this email.* Every
one is a task. CrewFlow already shipped the **AI Task Queue** foundation
(`hq_sales_ai_tasks`, `20260714000001`): a durable, claimable, prioritised,
retrying, dedupable queue with `payload`/`result` — and two employees already
claim and run tasks off it (Research AI, Lead Qualification AI) using a proven
runner pattern. But it is **sales-scoped** (`company_id`/`contact_id` columns,
`hq_sales_task_types`), flat (no dependencies), and has no built-in approval or
verification stage.

This volume generalises that proven queue into **`hq_ai_tasks`** — the
employee-agnostic engine — and adds the four things a workforce scheduler needs
that the sales queue lacks: **dependencies (a task DAG)**, **approval
checkpoints** (the home of the autonomy test, P4), a **verification stage**, and
**lease/heartbeat crash recovery**. It keeps the sales queue running untouched
(protecting production) and defines the migration path.

**In scope:** task schema; the lifecycle FSM; assignment; scheduling & recurring
tasks; dependencies / parent-child / DAG; priority & escalation; approval
checkpoints; verification; completion; retry & failure recovery; the claim
protocol; the SQL + SDK interface.

**Out of scope (owned elsewhere):** *what* the work does (the employee's logic,
XIII); the *events* a task emits/consumes (XI); the *context* a task reads/writes
(X working memory); *who* may run a task (XIII permissions/capabilities).

---

## 2. Where it sits

```
   triggers (events, IX escalations, X embed/consolidate, schedules)
        │  create()
        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                  Task Engine (XII)                            │
   │  hq_ai_tasks: FSM, DAG deps, lease+heartbeat, approval,       │
   │  verification, retry/recovery, priority dequeue               │
   └───┬───────────────┬───────────────┬───────────────┬──────────┘
       │ claim()       │ checkpoint()   │ approve()      │ complete()
       ▼               ▼                ▼                ▼
   AI employee      working memory   human in HQ      emits task.* events
   runner (XIII)    (X)              (P4 checkpoint)  (XI) → drives more tasks
```

- **Depends on:** Event Bus (XI) — tasks emit `task.*` and *the scheduler is the
  thing that drives the bus drain tick* (C3); Shared Memory (X) — working memory
  bound to a task; SDK (XIII) — the runner contract, capabilities for assignment,
  the autonomy test for approval; Communication Protocol (IX) — escalations open
  tasks, tasks can send messages.
- **Depended on by:** every AI employee (an employee *is* a thing that claims and
  runs tasks); the AI Boardroom (orchestration = composing tasks across
  employees); every other volume's recurring jobs (sweeps, embeds, drains).

---

## 3. Built vs. to-build

| Capability | State | Note |
|------------|-------|------|
| Durable, claimable task row with payload/result | **Built** | `hq_sales_ai_tasks` — the template. |
| Priority + index-ordered dequeue | **Built** | `priority`, generated `priority_rank`, `hq_sales_ai_tasks_queue_idx`. |
| Retry counter + max retries | **Built** | `retry_count`, `max_retries`. |
| Scheduling (run-after) | **Built** | `scheduled_at` (null = ASAP). |
| Idempotent dedupe of live work | **Built** | `dedupe_key` + partial unique on `('pending','running')`. |
| Task types as **data** | **Built** | `hq_sales_task_types` lookup (new type = a row). |
| The **runner pattern** (atomic claim, checkpoint, mirror, idempotent) | **Built** | Research AI + Lead Qualification AI runners — the ADR pattern. |
| Per-employee task **metrics** | **Built** | `ai_employee_task_metrics`. |
| **Employee-generic** task table (`hq_ai_tasks`) | **To build** | generalise off `company_id`/`contact_id` → polymorphic subject. |
| **Dependencies / DAG** (parent-child, depends_on) | **To build** | new columns + a readiness rule. |
| **Approval checkpoints** (the autonomy test home) | **To build** | new states + `hq_ai_task_approvals`. |
| **Verification stage** | **To build** | new state + verify hook. |
| **Lease + heartbeat** crash recovery | **To build** | new columns + a reaper. |
| Recurring/cron tasks (drive sweeps, drains) | **To build** | `hq_ai_schedules` + a tick. |

**Net:** the *durable queue, priority, retry, dedupe, the proven runner pattern,
and metrics are shipped.* This volume generalises the subject, and adds DAG,
approval, verification, and lease recovery — the four scheduler features a
*workforce* needs that a *sales pipeline* didn't.

---

## 4. Data model

### 4.1 `hq_ai_tasks` — the general task (generalises `hq_sales_ai_tasks`)

```sql
create table if not exists public.hq_ai_tasks (
  id              uuid primary key default gen_random_uuid(),

  -- POLYMORPHIC SUBJECT (replaces sales' company_id/contact_id). A task may be
  -- about anything, or nothing (a global task like 'scan for new leads').
  subject_kind    text check (subject_kind in
                    ('company','contact','memory','message','thread','employee',
                     'event','none')),
  subject_id      text,

  task_type       text not null references public.hq_ai_task_types(slug),

  -- The superset FSM of both existing enums (ai_employee_tasks +
  -- hq_sales_ai_tasks) plus the new approval/verify/blocked states (§5).
  status          text not null default 'pending'
                  check (status in (
                    'pending',          -- created, not yet ready/claimed
                    'blocked',          -- waiting on dependencies (§6)
                    'scheduled',        -- ready, waiting for scheduled_at
                    'claimed',          -- a runner has leased it
                    'running',          -- executing
                    'waiting_approval', -- proposed actions need a human (P4)
                    'verifying',        -- result produced, under verification (§9)
                    'completed',        -- done + verified
                    'failed',           -- exhausted retries / unrecoverable
                    'cancelled'         -- superseded / withdrawn
                  )),

  priority        text not null default 'normal'
                  check (priority in ('low','normal','high','urgent')),
  priority_rank   integer generated always as (
                    case priority when 'urgent' then 0 when 'high' then 1
                                  when 'normal' then 2 when 'low' then 3 else 2 end
                  ) stored,

  -- DEPENDENCIES (§6). parent_task_id builds the tree; depends_on builds the DAG.
  parent_task_id  uuid references public.hq_ai_tasks(id) on delete cascade,
  depends_on      uuid[] not null default '{}',   -- all must be 'completed' to unblock
  -- Join policy for a parent waiting on children.
  join_policy     text not null default 'all'
                  check (join_policy in ('all','any','n_of_m')),
  join_threshold  integer,                          -- for 'n_of_m'

  -- ASSIGNMENT (§7).
  assigned_employee_id uuid references public.ai_employees(id) on delete set null,
  required_capability  text,    -- intent/capability slug for capability-routing

  -- LEASE + HEARTBEAT (§10 crash recovery). A claim sets lease_owner +
  -- lease_expires_at; the runner heartbeats; a reaper reclaims expired leases.
  lease_owner       text,                    -- a runner instance id
  lease_expires_at  timestamptz,
  heartbeat_at      timestamptz,

  -- RETRY.
  retry_count     integer not null default 0 check (retry_count >= 0),
  max_retries     integer not null default 3 check (max_retries >= 0),

  -- APPROVAL (§8). Set when a proposed action fails the autonomy test (P4).
  approval_status text check (approval_status in
                    ('not_required','pending','approved','rejected')),

  -- TIMING.
  scheduled_at    timestamptz,   -- null = ASAP
  claimed_at      timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  deadline_at     timestamptz,   -- SLA; breach → escalation (§8.4)

  -- I/O. payload = input spec; result = the P3 AI output envelope.
  payload         jsonb,
  result          jsonb,
  verification    jsonb,         -- the verify stage's verdict (§9)
  error_message   text check (error_message is null or char_length(error_message) <= 4000),

  -- COST (XIII). Metered micros spent running this task; budget guard.
  cost_micros     bigint not null default 0,
  cost_budget_micros bigint,     -- null = inherit employee/global budget

  -- Trace (P2) + dedupe (Built pattern) + provenance.
  correlation_id  uuid not null,
  causation_id    bigint,
  dedupe_key      text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  origin          text not null default 'system'
                  check (origin in ('human','ai_employee','system','schedule','event')),
  created_by      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.hq_ai_tasks enable row level security; -- RLS:hq (P5)

-- The dequeue index (mirrors the proven sales index): ready work, hottest first.
create index if not exists hq_ai_tasks_queue_idx
  on public.hq_ai_tasks (status, priority_rank, scheduled_at nulls first, created_at);
create index if not exists hq_ai_tasks_subject_idx on public.hq_ai_tasks (subject_kind, subject_id)
  where subject_id is not null;
create index if not exists hq_ai_tasks_parent_idx  on public.hq_ai_tasks (parent_task_id)
  where parent_task_id is not null;
create index if not exists hq_ai_tasks_assigned_idx on public.hq_ai_tasks (assigned_employee_id)
  where assigned_employee_id is not null;
create index if not exists hq_ai_tasks_corr_idx    on public.hq_ai_tasks (correlation_id);
-- The lease reaper reads exactly this: running tasks whose lease has expired.
create index if not exists hq_ai_tasks_lease_idx   on public.hq_ai_tasks (lease_expires_at)
  where status in ('claimed','running');
-- The SLA sweep: live tasks past their deadline.
create index if not exists hq_ai_tasks_deadline_idx on public.hq_ai_tasks (deadline_at)
  where status in ('pending','blocked','scheduled','claimed','running','waiting_approval') and deadline_at is not null;
-- One LIVE task per dedupe_key (re-queue after completion allowed) — Built pattern.
create unique index if not exists hq_ai_tasks_dedupe_idx
  on public.hq_ai_tasks (dedupe_key)
  where dedupe_key is not null and status in
    ('pending','blocked','scheduled','claimed','running','waiting_approval','verifying');
```

### 4.2 `hq_ai_task_types` — task kinds as **data** (generalises `hq_sales_task_types`)

```sql
create table if not exists public.hq_ai_task_types (
  slug                 text primary key check (slug ~ '^[a-z0-9_]{1,60}$'),
  label                text not null,
  category             text not null default 'other',  -- research|outreach|memory|admin|approval|system|...
  -- The capability an employee must hold to run this type (links to XIII registry).
  required_capability  text,
  -- Default lifecycle knobs for tasks of this type.
  default_priority     text not null default 'normal',
  default_max_retries  integer not null default 3,
  requires_verification boolean not null default false,  -- §9
  is_active            boolean not null default true,
  sort_order           integer not null default 100,
  created_at           timestamptz not null default now()
);
alter table public.hq_ai_task_types enable row level security;
```

### 4.3 `hq_ai_task_approvals` — approval checkpoints (§8)

```sql
create table if not exists public.hq_ai_task_approvals (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.hq_ai_tasks(id) on delete cascade,
  -- The proposed action(s) from the P3 envelope that failed the autonomy test.
  proposed_actions jsonb not null,
  reason        text not null,            -- which P4 condition failed
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','expired')),
  decided_by_email text,                  -- the human who decided
  decided_at    timestamptz,
  decision_note text,
  expires_at    timestamptz,              -- unactioned → escalate/abandon
  created_at    timestamptz not null default now()
);
alter table public.hq_ai_task_approvals enable row level security;
create index if not exists hq_ai_task_approvals_pending_idx
  on public.hq_ai_task_approvals (status, created_at) where status = 'pending';
```

### 4.4 `hq_ai_schedules` — recurring tasks (§5.3)

```sql
create table if not exists public.hq_ai_schedules (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  task_type     text not null references public.hq_ai_task_types(slug),
  cron          text not null,            -- standard cron expression
  payload       jsonb,
  is_active     boolean not null default true,
  last_run_at   timestamptz,
  next_run_at   timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.hq_ai_schedules enable row level security;
```

`hq_ai_tasks.task_type`s the recurring jobs of the whole substrate (the bus drain
tick, the IX SLA sweep, the X expiry/consolidation sweeps, the lease reaper) are
all rows here — *one* scheduler, not 13 pollers (C3).

---

## 5. Lifecycle FSM

### 5.1 The state machine

```
            create()
              │
              ▼
  ┌────────(pending)───────┐ has unmet depends_on? ──yes──▶ (blocked)
  │                        │                                   │ all deps completed (§6)
  │   scheduled_at future? └──no──────────────┐                ▼
  │        │ yes                               │           (re-evaluate)
  │        ▼                                   ▼
  │   (scheduled) ──scheduled_at reached──▶  ready ──claim()──▶ (claimed)
  │                                                               │ start()
  │                                                               ▼
  │                                                           (running)
  │                          proposes actions; autonomy test (P4):       │
  │              ┌──all pass──────────────────────────────────────────┐  │
  │              │                                                     ▼  ▼
  │         (running) ◀──approved── (waiting_approval) ◀──any fail── apply?
  │              │         human approve()        │ reject()
  │              │                                ▼
  │   requires_verification?                  (cancelled/failed)
  │     │ yes                  │ no
  │     ▼                      ▼
  │ (verifying) ──pass──▶ (completed)
  │     │ fail                  ▲
  │     ▼                       │
  │  retry or escalate          └── emits task.completed (XI) → unblocks dependents
  │
  └─ any running/claimed: lease expires → reaper → back to ready (retry, §10)
     any state: error past max_retries → (failed);  withdrawn → (cancelled)
```

### 5.2 Transition table (the guards)

| From | Event | To | Guard |
|------|-------|----|----|
| — | `create` | pending | valid type; dedupe ok |
| pending | evaluate | blocked | `depends_on` not all completed |
| pending | evaluate | scheduled | `scheduled_at` in future |
| pending/scheduled/blocked | ready | (claimable) | deps met ∧ `scheduled_at ≤ now` |
| ready | `claim` | claimed | atomic compare-and-set + lease (§10) |
| claimed | `start` | running | runner began; `started_at=now` |
| running | propose actions | waiting_approval | **any** action fails P4 |
| running | propose actions | running | all actions pass P4 → apply inline |
| waiting_approval | `approve` | running | human approved; apply actions |
| waiting_approval | `reject` | cancelled/failed | human rejected |
| running | result ready, type needs verify | verifying | `requires_verification` |
| running | result ready, no verify | completed | — |
| verifying | `verify_pass` | completed | verifier accepted |
| verifying | `verify_fail` | (retry)→running / escalate | per retry budget (§9) |
| claimed/running | lease expired | ready | reaper; `retry_count++` (§10) |
| any non-terminal | error, retries left | ready | backoff |
| any non-terminal | error, retries exhausted | failed | emit `task.failed` |
| any non-terminal | `cancel` | cancelled | superseded/withdrawn |
| completed | — (parent watches) | — | emit `task.completed` → re-evaluate dependents (§6) |

Every transition emits its `task.*` event (XI) in the same transaction as the
status write (P1). Terminal: `completed`, `failed`, `cancelled`.

### 5.3 Scheduling

- **`scheduled_at`** (Built) — run-after; the dequeue index already orders
  `nulls first` so ASAP work leads.
- **Recurring** (`hq_ai_schedules`, new) — a cron tick (itself a recurring task)
  materialises due schedules into concrete `hq_ai_tasks`, idempotently
  (dedupe_key = `slug:bucket`), so a double tick can't double-spawn.
- **Fairness / starvation** — priority dequeue with **ageing**: a task's
  effective rank improves with wait time, so a flood of `urgent` work can't
  starve `normal` forever. Per-employee concurrency caps keep one employee from
  monopolising runners.

---

## 6. Dependencies / parent-child / the DAG

The single biggest capability over the flat sales queue.

- **`parent_task_id`** builds a **tree**: a parent task fans out child subtasks
  ("research company" → children "fetch Companies House", "crawl website",
  "score"). Cascade-delete keeps orphans out.
- **`depends_on uuid[]`** builds a **DAG**: a task is `blocked` until *every* id
  in `depends_on` is `completed` (the default `join_policy='all'`; `any` and
  `n_of_m` supported for fan-in). When a task completes, the engine re-evaluates
  tasks that list it in `depends_on` and unblocks the now-ready ones (driven by a
  `task.completed` consumer — event-driven, not polled).
- **Parent completion (the join).** A parent with children completes per its
  `join_policy`: `all` children completed (the default), `any` one, or `n_of_m`.
  A parent's `result` aggregates its children's (the engine assembles a combined
  P3 envelope, or the parent's runner does).
- **Cycle detection.** `depends_on` must be acyclic; `create()`/`addDependency()`
  rejects an edge that would close a cycle (a bounded reachability check over the
  pending/blocked sub-DAG). A cycle is a programming error, refused at build time,
  never a deadlock at run time.
- **Failure propagation.** A failed dependency, by default, fails its blocked
  dependents (`fail_fast`); a per-task `on_dep_failure` policy can instead leave
  them blocked for human triage. Cancelling a parent cancels its incomplete
  subtree.

This is what lets the AI Boardroom *orchestrate*: a complex objective is a DAG of
tasks across many employees, and the engine — not the Boardroom — owns the
readiness, join, and failure semantics (the directive's "the Boardroom consumes
the substrate, it does not reimplement it").

---

## 7. Assignment

How a ready task gets an employee to run it. Four mechanisms, resolved in order:

1. **Explicit** — `assigned_employee_id` is set at creation. Run by that employee.
2. **By capability** — `required_capability` is set (or inherited from the task
   type). The engine asks the **capability registry** (`hq_ai_capabilities`,
   XIII): *who can do this?* and picks the best-scoring capable, live, in-budget
   employee (the IX §6.4 load policy: capability confidence − current load −
   recent failures). This is the default for a growing workforce — tasks name a
   *capability*, not a name (C1).
3. **Load-balanced** — when several employees share the capability, distribute by
   live task count + metrics (`ai_employee_task_metrics`) so work spreads and
   erroring employees are avoided.
4. **Delegation** — a manager employee (or the Boardroom) may explicitly assign a
   child task to a subordinate; recorded with `causation_id` so the delegation
   chain is traceable.

An unassignable task (no capable employee) does **not** silently stall: after a
bound it escalates (§8.4) — open a human task ("no employee can do X"), exactly
like the IX "nobody can handle this" condition. Capability gaps are surfaced.

---

## 8. Approval checkpoints (the home of the autonomy test)

This is where P4 lives operationally — the reconciliation of "humans always
decide" with shipped autonomy (C2).

1. A running task's runner produces a **P3 output envelope** whose `actions[]`
   are *proposed*, not applied.
2. For **each** action the engine applies the **autonomy test (P4)**: reversible
   ∧ low-blast-radius ∧ type-bounded target ∧ within capability scope ∧ within
   cost budget.
3. **All pass** → the actions apply inline (the task proceeds to verify/complete).
   This is why internal research/scoring/memory-writes run autonomously.
4. **Any fails** → the engine writes an `hq_ai_task_approvals` row with the
   proposed actions + the failed condition, moves the task to **`waiting_approval`**,
   and emits `task.approval_requested` (XI) — which surfaces in HQ (and can notify
   via IX/notifications). The runner *suspends* (it does not block a worker — the
   task is parked, the lease released).
5. A **human** approves or rejects in HQ. `approve()` → the task resumes
   (`running`), the approved actions apply, fully audited (who approved, when,
   why). `reject()` → the task fails/cancels with the human's note.
6. **Approval SLA.** An approval unactioned past `expires_at` escalates (§8.4):
   nudge → escalate to a manager/another approver → and ultimately the task is
   `failed` with a loud `critical` event. Approvals never rot silently.

Anything irreversible/external (send email, spend money, write customer-facing
state, delete) **always** lands here — by construction it fails P4. This makes
"the AI proposes, a human disposes, on exactly the risky actions" a mechanical
guarantee, not a hope.

### 8.4 Escalation

A task breaching `deadline_at`, or an approval breaching its SLA, or an
unassignable task, escalates on a ladder mirroring IX §8.3: retry → reassign to a
peer → escalate to a manager employee → open a human task → (last resort) fail
with a `critical` event. The SLA sweep that drives this is itself a recurring
task reading `hq_ai_tasks_deadline_idx` — idempotent.

---

## 9. Verification

Trust, but verify. For task types flagged `requires_verification`, a produced
result passes through a **`verifying`** state before `completed`:

- The **verifier** is a check appropriate to the task type: a *rule* check
  (schema/constraints on the result — e.g. a fit score is 0–100, required fields
  present), a *consistency* check (the result agrees with cited `evidence[]`), or
  a *second-opinion* check (a different employee/capability reviews high-stakes
  output, via IX). The verifier itself returns a verdict written to
  `verification`.
- **Pass** → `completed`. **Fail** → retry the task (if budget remains) or
  escalate (§8.4). A repeatedly-unverifiable result is a `failed` task with the
  verifier's reason — never a silently-accepted bad answer.
- Verification is opt-in **per task type** so cheap reversible tasks aren't
  taxed; high-stakes ones (scoring that gates outreach, anything feeding a
  customer) are. Cost-aware: the verify step is metered too.

---

## 10. The claim protocol & crash recovery

The proven runner pattern (Research AI, Lead Qualification AI), generalised and
hardened with leases.

### 10.1 Atomic claim (Built pattern, generalised)

```
claim(employee, runner_instance):
  UPDATE hq_ai_tasks
     SET status='claimed', assigned_employee_id=employee,
         lease_owner=runner_instance,
         lease_expires_at = now() + lease_ttl,
         heartbeat_at = now(), claimed_at = now()
   WHERE id = (
     SELECT id FROM hq_ai_tasks
      WHERE status IN ('pending','scheduled')          -- ready
        AND (scheduled_at IS NULL OR scheduled_at <= now())
        AND deps_satisfied(depends_on)                  -- not blocked
        AND (required_capability IS NULL OR employee_has_capability(employee, required_capability))
      ORDER BY priority_rank, scheduled_at NULLS FIRST, created_at
      FOR UPDATE SKIP LOCKED                            -- single-claimer, no contention
      LIMIT 1)
   RETURNING *;
```

`FOR UPDATE SKIP LOCKED` (the spine's exact concurrency primitive) means two
runners never claim the same task — one wins, the other skips to the next. The
conditional update *is* the claim; it is atomic and idempotent.

### 10.2 Heartbeat + lease reaper (new — crash recovery)

- While running, the runner **heartbeats** (`heartbeat_at = now()`, extends
  `lease_expires_at`) every interval. A long task stays leased; a crashed runner
  stops heartbeating.
- A **reaper** (a recurring task reading `hq_ai_tasks_lease_idx`) finds
  `claimed`/`running` tasks whose `lease_expires_at < now()` (the runner died),
  **increments `retry_count`**, and returns them to `ready` (or `failed` if
  retries are exhausted). This is the crash-recovery guarantee: **no task is lost
  to a dead worker** — it is reclaimed and retried, at-least-once, idempotently.
- **Idempotent steps + checkpointing (Built pattern).** A runner checkpoints
  partial progress into `result` per step (the Research AI pattern), so a
  reclaimed task resumes without redoing committed work, and re-running a step is
  a no-op. Side effects that already applied are guarded by their own idempotency
  (e.g. a memory write keyed by dedupe, a message by `message.id`).

### 10.3 Compensation (sagas)

For a task that applied several side effects then failed, a `failed` task may
carry a **compensation plan** (recorded in `result`): the inverse actions to undo
what committed (e.g. archive a memory it wrote, retract a message it sent). The
engine runs compensations as child tasks. This is the saga pattern for the rare
multi-step task with partial external effects; most tasks are single-effect and
need none.

---

## 11. Interfaces

### 11.1 SQL entry points (P5)

```
hq_ai_task_create(p_type text, p_subject_kind text, p_subject_id text,
                  p_payload jsonb, p_priority text, p_scheduled_at timestamptz,
                  p_parent uuid, p_depends_on uuid[], p_required_capability text,
                  p_assigned_employee uuid, p_correlation_id uuid,
                  p_causation_id bigint, p_dedupe_key text, p_deadline timestamptz)
    returns uuid                       -- create + emit task.created; dedupe-guarded

hq_ai_task_claim(p_employee uuid, p_runner_instance text, p_capabilities text[])
    returns hq_ai_tasks                -- the atomic claim (§10.1)

hq_ai_task_heartbeat(p_task uuid, p_runner_instance text) returns void  -- extend lease
hq_ai_task_checkpoint(p_task uuid, p_result jsonb) returns void          -- partial progress
hq_ai_task_request_approval(p_task uuid, p_actions jsonb, p_reason text) returns uuid -- §8
hq_ai_task_decide(p_approval uuid, p_decision text, p_email text, p_note text) returns void
hq_ai_task_verify(p_task uuid, p_verdict jsonb, p_pass boolean) returns void  -- §9
hq_ai_task_complete(p_task uuid, p_result jsonb) returns void   -- + emit task.completed → unblock deps
hq_ai_task_fail(p_task uuid, p_error text) returns void          -- retry-or-fail
hq_ai_task_reap(p_now timestamptz, p_limit int) returns jsonb    -- lease reaper (§10.2)
hq_ai_task_sla_sweep(p_now timestamptz, p_limit int) returns jsonb -- deadline/approval escalation
hq_ai_schedule_tick(p_now timestamptz) returns jsonb             -- materialise recurring (§5.3)
hq_ai_task_golden_signals() returns jsonb
```

All: `SECURITY DEFINER`, `search_path=''`, `EXECUTE` revoked from JWT roles,
granted to `service_role` (P5). The atomic, ordering-sensitive logic (claim,
unblock, complete-and-cascade) lives in SQL — exactly where the spine put its
drainer — because supabase-js has no multi-statement transaction (CEO decision
D1).

### 11.2 TypeScript SDK surface — the runner contract (XIII)

```ts
interface Tasks {
  create(spec: TaskSpec): Promise<TaskId>;          // any subsystem enqueues work
  // The runner loop an AI employee runs (the generalised ADR pattern):
  run(opts: {
    capabilities: string[];                          // what this runner can claim
    handler: (task: Task, ctx: RunContext) => Promise<AIOutputEnvelope>;
  }): Promise<void>;
  // ctx gives the handler: memory.recall/remember (X, working bound to this task),
  // comms.send (IX), events.publish (XI), checkpoint(result), heartbeat (auto),
  // and proposeActions() which applies the autonomy test (P4) and either applies
  // inline or parks for approval — the handler never decides autonomy itself.
  approve(approvalId: ApprovalId, decision: 'approve'|'reject', note?: string): Promise<void>;
}
```

The `run` loop **is** the canonical AI-employee shape: claim → assemble context
(X) → reason → produce a P3 envelope → propose actions (engine applies P4) →
checkpoint → verify → complete, heartbeating throughout, every step audited as a
`task.*` event. An employee author writes only the `handler`; the substrate owns
everything around it.

That division is governed by the **runner/handler contract — five enforced rules**
(XIII §21): no employee claims from SQL, none implements its own runner, none
completes or fails its own task; the runner owns the whole lifecycle mechanism,
handlers own business logic only. PR-C ships the first slice of this `Tasks` surface
(`create` + the `run` loop + `checkpoint`; `complete`/`fail` stay runner-internal by
rule 3) over the seven entry points above.

---

## 12. Worked flow — an orchestrated objective

```
Boardroom: "win Acme Builders" → create parent task P (correlation_id = C)
  P fans out children (a DAG):
    A research.company(Acme)            [no deps]
    B qualify.lead(Acme)                [depends_on A]
    C prepare.outreach(Acme)            [depends_on B]  ← action: draft email (reversible→auto)
    D send.outreach(Acme)               [depends_on C]  ← action: SEND email (irreversible→approval)
1. A is ready → research-ai claims (lease), runs, writes report to Memory (X),
   completes → task.completed → engine unblocks B.
2. B claims (lead-qualification-ai), reads A's report (X), scores 78, all actions
   reversible → autonomous → completes → unblocks C.
3. C drafts the email (a memory write — reversible, auto) → completes → unblocks D.
4. D proposes action SEND email → autonomy test FAILS (irreversible, external) →
   waiting_approval + hq_ai_task_approvals row → a human in HQ approves → D resumes,
   sends, verifies delivery, completes.
5. P's join_policy='all' satisfied → P completes → Boardroom sees the objective done.
   The entire saga shares correlation_id C; every step is a task.* event.
```

One DAG; autonomous where safe; a single human checkpoint exactly at the
irreversible step; fully recoverable (any runner crash reaps and retries); fully
auditable.

---

## 13. Observability

`hq_ai_task_golden_signals()`: queue depth by status/priority; oldest pending;
**claimed-but-stale** (heartbeat overdue — the crash canary); approval backlog +
oldest pending approval; deadline breaches; failure rate by task type; DAG
fan-in stalls (long-blocked tasks); per-employee throughput & cost. On The Pulse.

---

## 14. Security (P5 applied)

- **No direct table access.** Employees claim/checkpoint/complete only through the
  SDK → audited entry points. The autonomy test is enforced **by the engine**,
  not trusted to the handler (a handler cannot self-approve an irreversible
  action — `proposeActions` always runs P4).
- **Approval is human-gated** and recorded (who/when/why). RLS:hq throughout; no
  customer JWT can see or touch tasks (P5). Production sales queue untouched.

---

## 15. Testing (the six gates)

| Gate | What it proves |
|------|----------------|
| 3 unit | the FSM transition guards, the DAG readiness/join/cycle-detection, the autonomy-test classifier, ageing/fairness, the load-assignment policy — pure `lib/*`. |
| 4 integration (real Postgres) | atomic claim under concurrency (two runners, one task, `SKIP LOCKED`), lease reaper reclaims a crashed task and retries idempotently, dependency unblock on completion, approval park→approve→resume applies the action exactly once, verification fail→retry, dedupe of live work, recurring-tick idempotency. |
| 5 security | RLS:hq; entry-point grants; the engine (not the handler) enforces P4; an irreversible action cannot complete without an approval row — pinned in source. |
| 6 e2e | the HQ task/approval surface behind the auth wall (mirrors qualification.spec: anonymous → 307 → /login, never paints). |

---

## 16. Conflicts resolved & open questions

**Resolves:**
- **C2 ("humans always decide" vs autonomy)** — the autonomy test (P4) lives here
  as the approval-checkpoint mechanism; reversible/bounded work is autonomous,
  risky work is human-gated, *mechanically and per-action*.
- **C3 ("nothing polls")** — the recurring-task scheduler (`hq_ai_schedules` +
  tick) is the *one* thing that drives every sweep/drain/reaper; the 13 sales
  pollers become scheduled tasks/consumers over time (reclassified, production
  intact).
- Contributes to **C1** — capability-based assignment means tasks name a
  capability, not an employee, so the workforce can grow without rewiring callers.

**Open questions for a future directive:**
1. **Migration of `hq_sales_ai_tasks`.** Do existing sales tasks *migrate* into
   `hq_ai_tasks`, or do the sales runners keep their table while *new* employees
   use the general one and they converge later? *Recommendation: leave sales
   running, build new employees on `hq_ai_tasks`, converge via a view + a backfill
   when proven — protect production first.*
2. **Lease TTL & heartbeat interval defaults.** Need tuning against real runner
   durations (a long research task vs a quick score). Per-task-type override is in
   the schema; the defaults are a decision.
3. **Verifier-as-employee vs. verifier-as-rule.** For high-stakes second-opinion
   verification, is the verifier a distinct AI employee (cost, latency) or a rule
   set? *Recommendation: rules by default; employee review only for the highest-
   stakes types, behind a flag.*

---

*Volume XII of the AI Substrate. Architecture only — no code, no production
change, no PR. Continues into Volume XIII (AI SDK), the interface through which
every employee claims and runs the tasks defined here.*
