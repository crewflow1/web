# ADR 0006 — Shared Memory ⇄ Task Engine binding (the `bound_task_id` FK)

> **Status:** Accepted · **Date:** 2026-06-26 · **Directive:** CEO Directive #012 /
> D-02 (Generic Task Engine), PR-D · **Supersedes:** none · **Superseded by:** none ·
> **Builds on:** [ADR 0004](./0004-generic-task-engine.md),
> [ADR 0005](./0005-task-engine-spine-emission.md)
>
> Sixth ADR under the [`../README.md`](../README.md) *document-before-you-build* rule,
> recorded in the same PR as the code. This is **PR-D** of D-02: it closes the last
> reserved seam of the Task Engine's memory contract by adding the foreign key
> `hq_memories.bound_task_id → hq_ai_tasks(id)`. It is a **single referential
> constraint** — no schema column, no data, no behaviour, and no TypeScript changes.
> The Task Engine freeze status is unchanged (**Partial**) until the workload
> migrations land (PR-E–G).

---

## Context

Two substrates were built in the wrong order for one edge between them. The **Shared
Memory Engine** (#009) shipped first and, anticipating the Task Engine, gave
`hq_memories` a `bound_task_id uuid` column so a *working* or *episodic* memory could
record the task it was produced under — the hook a lifecycle worker will later use to
expire a scratchpad when its task ends (Volume X §11; XII `task.finished`). At #009
the referent did not yet exist, so the column was created **deliberately FK-less**:

> *"Intentionally NOT FK-constrained yet: the task table does not exist until Module
> 4. The FK is added then."* — `20260722000000_memory_classes_lifecycle.sql`

The Task Engine (#012, PR-A) then created `public.hq_ai_tasks`, and its header recorded
the open edge as the work of this PR: *"The bound_task_id FK from Shared Memory is
PR-D."* Everything ELSE on the write path already exists and is exercised today:

- the column `hq_memories.bound_task_id` and its partial index `hq_memories_bound_task_idx`;
- `hq_memory_write(… p_bound_task_id uuid …)` (20260723000000) accepts and stores it;
- the SDK `remember()` (`server/sdk/memory.ts`) auto-binds working/episodic memory to
  `identity.currentTaskId`, so a handler never threads the task id by hand.

What is missing is only the **referential check**. A bare `uuid` is an un-enforced
invariant: nothing stops a binding to a task that never existed or has since been
removed, and the lifecycle worker that will read these bindings would then chase
ghosts. PR-D adds the constraint, and nothing else.

## Decision

**1. Add the foreign key** in
[`20260804000000_hq_memories_bound_task_fk.sql`](../../../supabase/migrations/20260804000000_hq_memories_bound_task_fk.sql):

```
hq_memories.bound_task_id  →  hq_ai_tasks(id)   ON DELETE SET NULL
```

named `hq_memories_bound_task_id_fkey` (PostgreSQL's own default, so the revert and any
later reader can address it predictably). The migration first NULLs any binding whose
task is absent — expected to touch **zero** rows, since the engine has no employee
writers yet — so the constraint validates cleanly, then adds it inside an idempotent
`pg_constraint` guard (re-runnable).

**2. `ON DELETE SET NULL`, because a memory outlives its task.** The binding is a
lifecycle *convenience*, not an ownership edge. When a task row is removed — a reaper
sweep, an operator cleanup, a test teardown — the memory must survive and simply lose
its binding; its own `expires_at` TTL remains the hard backstop. Cascade-deleting
knowledge because a transient work item was cleaned up would be a data-loss footgun.
This mirrors the engine's two existing SET NULL edges — `hq_ai_tasks.parent_task_id`
(self) and `hq_memories.consolidated_into` (self) — so the platform reads one way.

**3. The dependency points one direction: Memory → Task, never the reverse.** The task
is the anchor; the memory is the optional satellite that *may* reference it. The Task
Engine gains **no** column pointing at `hq_memories` and no knowledge of the memory
system — it stays the generic, employee- and memory-agnostic substrate every employee
inherits unchanged (ADR 0004's defining posture). The coupling is carried entirely by
the satellite.

**4. No behaviour is wired here — and the auto-expire consumer is explicitly deferred.**
PR-D makes the link *referentially sound*; it does **not** add the consumer that
expires working memory when `task.finished` fires. That consumer (a lifecycle-worker
extension keyed on `bound_task_id`) is a later concern with its own change; PR-D is its
structural prerequisite. Shipping the FK alone keeps this PR a single reviewable fact.
No TypeScript changes: the write path and SDK binding already landed at #009.

## Alternatives weighed

- **`ON DELETE CASCADE`.** Rejected: it deletes knowledge when a task is removed. A
  working memory is a scratchpad, but episodic memory bound to a task is *experience*
  worth keeping; and even a scratchpad should expire on its own TTL, not vanish the
  instant a reaper prunes a finished task. Cascade makes task cleanup a silent memory
  wipe — the opposite of an append-only company brain.
- **`ON DELETE RESTRICT` / `NO ACTION`.** Rejected: it makes a mere scratchpad link
  *block* task deletion, so the reaper or an operator could not remove a task while any
  memory still pointed at it. The lifecycle of the anchor must not be hostage to the
  satellite.
- **Leave the column FK-less (status quo).** Rejected: an un-enforced `uuid` lets
  orphaned and dangling bindings accumulate invisibly, and the future lifecycle worker
  would have to defensively re-validate every binding it reads. Enforce the invariant
  in the one place that cannot be bypassed — the database.
- **Add the consumer that expires working memory in this same PR.** Rejected as scope
  creep: it is a behavioural change with its own test surface and failure modes. The
  FK is the prerequisite and stands cleanly alone; the consumer lands when it is built.

## Consequences

**What the workforce inherits.** Every employee's working/episodic memory that binds to
a task is now *guaranteed* to point at a real task or at nothing — referential
integrity the lifecycle worker can rely on, for free, by inheriting the substrate. No
employee writes or enforces this; the database does.

**Blast radius.** Additive and reversible: one constraint on `hq_memories`; `hq_ai_tasks`
is untouched; `drop constraint hq_memories_bound_task_id_fkey` reverts it completely.
**Zero** existing rows are affected in any environment — the engine has no employee
writers yet, so `bound_task_id` is empty. The only ongoing cost is the FK check on the
(rare today) memory write that carries a binding, plus the SET-NULL lookup on the (rare)
task delete — both covered by the existing partial index.

**Enforcement.** The [security suite](../../../__tests__/security/memory-task-binding.test.ts)
pins the migration's source: the constraint references `hq_ai_tasks(id)`, is `ON DELETE
SET NULL` (never cascade/restrict), and the change is additive (it touches only
`hq_memories`, alters no `hq_ai_tasks` definition). The
[integration suite](../../../__tests__/integration/memory/bound-task-fk.test.ts) proves,
against real Postgres, that a binding to a non-existent task is rejected, that a binding
to a real task is accepted, and that deleting that task NULLs the binding while the
memory survives.

**Freeze status.** Unchanged: the Task Engine remains **Partial**. PR-D closes the
*memory-binding* seam; the migration of the two live sales workloads (PR-E/PR-F) and the
operator read-view (PR-G) remain before the engine can be declared Established.

**Numbering.** Registered in [`../governance/numbering.md`](../governance/numbering.md);
the next free ADR number is **0007**.
