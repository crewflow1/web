-- CrewFlow HQ — Shared Memory ⇄ Task Engine binding FK (CEO Directive #012 / D-02, PR-D).
--
-- The last reserved seam of the Generic Task Engine's memory contract. Shared Memory
-- (#009) already ships everything this binding needs EXCEPT the referential check:
--   • the column  — `hq_memories.bound_task_id uuid` (20260722000000), nullable;
--   • the index   — partial `hq_memories_bound_task_idx` on the non-null rows;
--   • the write   — `hq_memory_write(... p_bound_task_id uuid ...)` (20260723000000)
--                   already accepts and stores it;
--   • the binder  — the SDK `remember()` auto-binds working/episodic memory to the
--                   running task (`identity.currentTaskId`, server/sdk/memory.ts).
-- All of that landed BEFORE `hq_ai_tasks` existed, so the column was deliberately
-- created WITHOUT a foreign key — PR-A's header records the constraint as "PR-D", and
-- 20260722000000 comments it inline ("the FK is added then"). The task table now
-- exists (PR-A, 20260802000000). This migration adds the one missing constraint, and
-- nothing else. ADR-0006.
--
-- WHY `on delete set null`. A memory OUTLIVES the task it was bound to. The binding is
-- a lifecycle convenience — it lets a future lifecycle worker expire a working
-- scratchpad when its task ends (Volume X §11; XII `task.finished`) — not an ownership
-- edge. Deleting a task (e.g. a reaper sweep, or test teardown) must RELEASE the
-- binding, never delete knowledge; the memory's own `expires_at` TTL remains its hard
-- backstop. This mirrors the engine's existing SET NULL edges: `hq_ai_tasks.parent_
-- task_id` (self) and `hq_memories.consolidated_into` (self).
--
-- DIRECTION. Shared Memory references the Task Engine, never the reverse: the task is
-- the anchor, the memory the optional satellite. The Task Engine stays employee- and
-- memory-AGNOSTIC (it has no column pointing at `hq_memories`), so it remains the
-- generic substrate every employee inherits unchanged.
--
-- BLAST RADIUS. Additive + reversible: one constraint on `hq_memories`; no column,
-- data, default, or behaviour change; `hq_ai_tasks` is untouched. `drop constraint
-- hq_memories_bound_task_id_fkey` reverts it completely. In practice ZERO existing
-- rows are affected — the engine has no employee writers yet, so `bound_task_id` is
-- empty in every environment.

-- 1. Defensive hygiene. Release any binding that points at a task that does not exist,
--    so the constraint validates cleanly. Expected to touch zero rows (see above); the
--    partial bound-task index keeps the scan trivial regardless.
update public.hq_memories m
   set bound_task_id = null
 where m.bound_task_id is not null
   and not exists (
     select 1 from public.hq_ai_tasks t where t.id = m.bound_task_id
   );

-- 2. Add the foreign key, idempotently (re-runnable — skip if it is already present).
--    The explicit name matches PostgreSQL's own default, so a later reader (and the
--    revert) can address it predictably.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'hq_memories_bound_task_id_fkey'
       and conrelid = 'public.hq_memories'::regclass
  ) then
    alter table public.hq_memories
      add constraint hq_memories_bound_task_id_fkey
      foreign key (bound_task_id)
      references public.hq_ai_tasks(id)
      on delete set null;
  end if;
end
$$;
