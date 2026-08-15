-- Milestone dependencies + critical path — turns the flat milestone list
-- (20261085) into a network with predecessor links, so the app can derive which
-- milestones drive the completion date (the critical path) and which have float.
--
-- THE GAP THIS CLOSES. job_milestones is a flat, sorted stage list: it says
-- "first fix, plaster, second fix" in an order but records no DEPENDENCY — that
-- plaster cannot start until first fix finishes. Without the link the app cannot
-- compute a critical path or a milestone's slack, so a slipping first-fix reads
-- as one late stage rather than "the whole job moves".
--
-- ── AN EDGE MEANS "milestone_id DEPENDS ON depends_on_milestone_id" ───────────
-- i.e. depends_on (the predecessor) must finish before milestone_id (the
-- successor) starts. The critical-path maths lives in lib/jobs/critical-path.ts
-- (pure, unit-tested); this table is only the persisted edge set.
--
-- ── EDGES BELONG TO ONE BASELINE ─────────────────────────────────────────────
-- Milestones are children of a baseline REVISION and are FROZEN; re-baselining
-- creates a NEW milestone set. So a dependency is meaningful only WITHIN one
-- baseline's milestones. Both endpoints bind by composite FK to
-- job_milestones(id, org_id), and the baseline is carried explicitly so the
-- replace-all RPC and the reads can scope by it. When a job is re-baselined the
-- new baseline simply has no edges until they are set again — a dependency
-- cannot dangle onto a superseded revision's milestone.
--
-- Unlike the frozen milestones, EDGES ARE MUTABLE (replace-all via the RPC):
-- linking up a plan is iterative, and an edge carries no history worth freezing.
--
-- ── TENANCY IS STRUCTURAL ────────────────────────────────────────────────────
-- job_milestones gains a unique (id, org_id) so both endpoints can bind by
-- composite FK — a forged milestone id cannot cross tenants. ON DELETE CASCADE
-- throughout; deleting a baseline (cascade from a job/org teardown) removes its
-- edges too.
--
-- Additive and reversible. To roll back:
--   drop table public.job_milestone_dependencies;
--   alter table public.job_milestones drop constraint job_milestones_id_org_key;
--   drop function public.set_milestone_dependencies(uuid, uuid, jsonb);
-- Depends on: job_milestones (20261085).

-- Composite-FK target on the (frozen) milestone table. Additive; does not touch
-- any milestone row or the frozen/immutable triggers.
alter table public.job_milestones
  add constraint job_milestones_id_org_key unique (id, org_id);

create table if not exists public.job_milestone_dependencies (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id) on delete cascade,
  baseline_id              uuid not null,
  milestone_id             uuid not null,   -- the successor
  depends_on_milestone_id  uuid not null,   -- the predecessor
  created_by               uuid references public.users(id) on delete set null,
  created_at               timestamptz not null default now(),
  constraint job_milestone_deps_baseline_fk
    foreign key (baseline_id, org_id)
      references public.job_programme_baselines (id, org_id) on delete cascade,
  constraint job_milestone_deps_successor_fk
    foreign key (milestone_id, org_id)
      references public.job_milestones (id, org_id) on delete cascade,
  constraint job_milestone_deps_predecessor_fk
    foreign key (depends_on_milestone_id, org_id)
      references public.job_milestones (id, org_id) on delete cascade,
  -- A milestone cannot depend on itself.
  constraint job_milestone_deps_no_self check (milestone_id <> depends_on_milestone_id),
  -- One edge per ordered pair.
  constraint job_milestone_deps_uniq unique (milestone_id, depends_on_milestone_id)
);

create index if not exists job_milestone_deps_org_baseline_idx
  on public.job_milestone_dependencies (org_id, baseline_id);

-- ── RLS — members read, admins write (programme configuration, like baselines) ─
alter table public.job_milestone_dependencies enable row level security;

drop policy if exists "job_milestone_deps: members can select" on public.job_milestone_dependencies;
create policy "job_milestone_deps: members can select" on public.job_milestone_dependencies
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_milestone_deps: admins can insert" on public.job_milestone_dependencies;
create policy "job_milestone_deps: admins can insert" on public.job_milestone_dependencies
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_milestone_deps: admins can delete" on public.job_milestone_dependencies;
create policy "job_milestone_deps: admins can delete" on public.job_milestone_dependencies
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── set_milestone_dependencies — replace the whole edge set, atomically ───────
-- Recording dependencies is delete-all + insert-N; split across PostgREST round
-- trips it could not be atomic. One function is one transaction under a per-
-- baseline advisory lock. SECURITY INVOKER: admin-only RLS is the real gate.
--
-- Refuses, with a sentence, every unsafe edge BEFORE writing:
--   * both endpoints must belong to THIS baseline (so no cross-baseline or
--     cross-tenant milestone can be linked);
--   * no self-dependency;
--   * NO CYCLE — a recursive walk over the proposed edge set proves the graph
--     is acyclic, because a cyclic programme has no critical path and no
--     schedulable order. This is the one rule a row CHECK cannot express (it is
--     a property of the whole SET), so it lives here.
create or replace function public.set_milestone_dependencies(
  p_baseline_id uuid,
  p_org_id      uuid,
  p_edges       jsonb
)
returns int language plpgsql security invoker set search_path = public as $$
declare
  e            jsonb;
  v_succ       uuid;
  v_pred       uuid;
  v_valid_ids  uuid[];
  v_count      int := 0;
  v_has_cycle  boolean;
begin
  if p_baseline_id is null or p_org_id is null then
    raise exception 'a baseline and an organisation are required';
  end if;
  if not exists (
    select 1 from public.job_programme_baselines
     where id = p_baseline_id and org_id = p_org_id
  ) then
    raise exception 'that baseline is not in this workspace';
  end if;

  -- The milestone ids that legitimately belong to this baseline.
  select array_agg(id) into v_valid_ids
    from public.job_milestones
   where baseline_id = p_baseline_id and org_id = p_org_id;

  perform pg_advisory_xact_lock(hashtext('job_milestone_deps'), hashtext(p_baseline_id::text));

  delete from public.job_milestone_dependencies
   where baseline_id = p_baseline_id and org_id = p_org_id;

  if p_edges is null or jsonb_typeof(p_edges) <> 'array' or jsonb_array_length(p_edges) = 0 then
    return 0; -- clearing all edges is legal
  end if;

  -- Stage the proposed edges in a temp table so we can validate + cycle-check
  -- the whole set before committing it.
  create temporary table _proposed_edges (succ uuid, pred uuid) on commit drop;

  for e in select * from jsonb_array_elements(p_edges) loop
    begin
      v_succ := (e->>'milestone_id')::uuid;
      v_pred := (e->>'depends_on_milestone_id')::uuid;
    exception when others then
      raise exception 'a dependency has an unreadable milestone reference';
    end;
    if v_succ is null or v_pred is null then
      raise exception 'a dependency needs both a milestone and its predecessor';
    end if;
    if v_succ = v_pred then
      raise exception 'a milestone cannot depend on itself';
    end if;
    if not (v_succ = any(v_valid_ids)) or not (v_pred = any(v_valid_ids)) then
      raise exception 'a dependency references a milestone outside this baseline';
    end if;
    insert into _proposed_edges (succ, pred) values (v_succ, v_pred);
  end loop;

  -- Cycle check: a path from a node back to itself over pred → succ edges.
  -- (pred must finish before succ, so following pred→succ is the schedule order;
  -- a cycle there is an unschedulable plan.)
  with recursive walk(start_node, node, depth) as (
    select pred, succ, 1 from _proposed_edges
    union all
    select w.start_node, pe.succ, w.depth + 1
      from walk w
      join _proposed_edges pe on pe.pred = w.node
     where w.depth < 10000
  )
  select exists (select 1 from walk where node = start_node) into v_has_cycle;

  if v_has_cycle then
    raise exception 'these dependencies form a loop — a milestone cannot (directly or indirectly) depend on itself';
  end if;

  insert into public.job_milestone_dependencies
    (org_id, baseline_id, milestone_id, depends_on_milestone_id, created_by)
  select p_org_id, p_baseline_id, succ, pred, auth.uid()
    from _proposed_edges
  on conflict (milestone_id, depends_on_milestone_id) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.set_milestone_dependencies(uuid, uuid, jsonb) from public, anon;
grant execute on function public.set_milestone_dependencies(uuid, uuid, jsonb) to authenticated;
