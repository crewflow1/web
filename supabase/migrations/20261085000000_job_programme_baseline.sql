-- Job programme baseline — the planned dates every schedule and progress
-- figure on a job can finally be measured against.
--
-- THE GAP THIS CLOSES. lib/job-progress/series.ts states it in its own header:
-- "CrewFlow holds no programme: `jobs` has one `scheduled_date` (a calendar
-- booking, with no matching end date) and a `practical_completion_date` that is
-- the ACTUAL completion recorded after the fact." So the progress panel draws
-- an actual line with no planned line beside it, the customer portal can name
-- no milestone dates, and schedule integrity cannot say "this booking is
-- outside the programme" because there is no programme to be outside of.
--
-- This is the DATE twin of 20261072's job_budgets, and it deliberately
-- transplants that migration's whole shape: composite-FK tenancy, write-once +
-- supersede revisions, a note structurally required to move the plan, an
-- advisory-locked SECURITY INVOKER RPC, and cascade-aware delete guards.
-- A programme baseline is, like a cost baseline, the DENOMINATOR of a
-- judgement about performance: "we said 21 August, we finished 12 October" is
-- a conversation; an UPDATE turns it into "we always said 12 October".
--
-- ── THE COMMERCIAL BOUNDARY (the 20261078 decision-4 line, held again) ──────
-- NO MONEY LIVES HERE, AND NONE MAY. A milestone has a title, dates, an
-- OPTIONAL dimensionless weight (percent of the programme, for the planned
-- S-curve) and a customer-visibility flag — no amount, no valuation, no
-- billing link. Milestone-valued billing is exactly the application-for-payment
-- lane 20261078 kept percent-complete out of; if it is ever built it will be a
-- CEO decision in the commercial domain, not a column that slipped in here.
-- Swept by __tests__/security/job-programme-no-fabrication.test.ts.
--
-- ── WEIGHTS: ALL-OR-NONE AT READ TIME, HONEST BY CONSTRUCTION ───────────────
-- A planned S-curve needs every milestone weighted and the weights to account
-- for the whole job. Rather than forcing weights on day one (a small builder's
-- first programme is a list of dates, and demanding percentages would stop
-- them recording it), weight is NULLABLE per row and the RPC enforces
-- all-or-none-with-Σ=100 per REVISION. lib/job-programme/planned.ts then emits
-- a planned curve ONLY when a current revision is fully weighted — an
-- unweighted programme gets milestones and window facts but NEVER a fabricated
-- straight line (the series.ts "no invented baseline" rule, kept).
--
-- ── REVISIONS: WRITE-ONCE + SUPERSEDE, NOT UPDATE-IN-PLACE ──────────────────
-- Identical mechanism to job_budgets (20261072), for identical reasons:
--   * every revision is a NEW ROW (revision 1, 2, 3 …);
--   * exactly one row per job is CURRENT (superseded_at IS NULL), enforced by
--     a partial unique index;
--   * a written row is immutable for every role except the single act of
--     stamping superseded_at, enforced by trigger;
--   * revision 1 needs no justification; EVERY LATER REVISION STRUCTURALLY
--     REQUIRES A NOTE (a CHECK, not form validation) — a silent re-baseline is
--     the one thing this design exists to prevent.
-- Milestones are children of a REVISION, so they are frozen the moment they
-- are written: there is no UPDATE story for a milestone at all — changing the
-- plan IS recording a new revision. No `superseded_by` column (the PGRST201
-- embed-ambiguity lesson: one FK to users, no new reviewed pair).
--
-- ── TENANCY IS STRUCTURAL ───────────────────────────────────────────────────
-- job_programme_baselines binds its job by COMPOSITE FK — (job_id, org_id) →
-- jobs (id, org_id), the candidate key 20261072 added — and job_milestones
-- bind their revision by (baseline_id, org_id) → job_programme_baselines
-- (id, org_id), so a forged parent id cannot cross tenants even for
-- service_role.
--
-- ON DELETE CASCADE throughout, teardown-safe: a plan for a job that no longer
-- exists is litter, not history. There is NO `ON DELETE RESTRICT`, NO
-- `ON DELETE NO ACTION`, and NO `AFTER DELETE` activity trigger anywhere in
-- this file (the 20261052 org-teardown lesson).
--
-- Additive and reversible. To roll back:
--   drop table public.job_milestones;
--   drop table public.job_programme_baselines;
--   drop function public.tg_job_programme_baseline_immutable();
--   drop function public.tg_job_programme_baseline_no_targeted_delete();
--   drop function public.tg_job_milestone_frozen();
--   drop function public.tg_job_milestone_no_targeted_delete();
--   drop function public.set_job_programme(uuid, uuid, date, date, jsonb, text);
-- Migrate-first safe: the app reads these tables best-effort; absent → no
-- programme, and every surface degrades to exactly today's behaviour.
-- Depends on: jobs_id_org_key (added by 20261072; validated instantly).

-- ── 1. job_programme_baselines — the append-only planned window ──────────────
create table if not exists public.job_programme_baselines (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  job_id        uuid not null,
  revision      int not null default 1 check (revision >= 1),
  -- The planned window. Both required: a programme without dates is not a
  -- programme. Equal dates are legal — a one-day job has a one-day window.
  planned_start date not null,
  planned_end   date not null,
  note          text check (note is null or length(note) <= 2000),
  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  -- NULL = this is the CURRENT baseline. Stamped when a later revision lands.
  superseded_at timestamptz,
  constraint job_programme_baselines_job_fk
    foreign key (job_id, org_id) references public.jobs (id, org_id) on delete cascade,
  -- The window must be a window.
  constraint job_programme_window check (planned_end >= planned_start),
  -- The first baseline needs no defence. Moving it does.
  constraint job_programme_revision_needs_reason check (
    revision = 1 or (note is not null and length(trim(note)) > 0)
  ),
  -- Composite-FK target for the milestone children.
  constraint job_programme_baselines_id_org_key unique (id, org_id)
);

-- Exactly ONE current baseline per job — the job_budgets_one_current mechanism.
create unique index if not exists job_programme_baselines_one_current
  on public.job_programme_baselines (job_id) where superseded_at is null;
-- The revision chain is dense and unambiguous.
create unique index if not exists job_programme_baselines_job_revision_uniq
  on public.job_programme_baselines (job_id, revision);
create index if not exists job_programme_baselines_org_job_idx
  on public.job_programme_baselines (org_id, job_id);

-- ── 2. job_milestones — the frozen children of one revision ─────────────────
create table if not exists public.job_milestones (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  baseline_id      uuid not null,
  title            text not null check (
                     length(trim(title)) >= 1 and char_length(title) <= 200
                   ),
  -- A milestone may be a point (planned_end only) or a bar (start + end).
  planned_start    date,
  planned_end      date not null,
  -- OPTIONAL share of the programme, in percent. Dimensionless — NOT money.
  -- All-or-none-with-Σ=100 is enforced per revision by set_job_programme;
  -- per-row the only structural truth is "a share is positive and ≤ 100".
  weight           numeric(5,2) check (weight is null or (weight > 0 and weight <= 100)),
  -- Whether the CUSTOMER may see this milestone's title and planned end in the
  -- portal. Default false: nothing becomes customer-visible by omission.
  customer_visible boolean not null default false,
  sort             int not null check (sort >= 1),
  constraint job_milestones_baseline_fk
    foreign key (baseline_id, org_id)
      references public.job_programme_baselines (id, org_id) on delete cascade,
  constraint job_milestone_window check (
    planned_start is null or planned_end >= planned_start
  ),
  constraint job_milestones_sort_uniq unique (baseline_id, sort)
);

create index if not exists job_milestones_org_baseline_idx
  on public.job_milestones (org_id, baseline_id);

-- ── 3. baseline history is immutable; only the supersede stamp may be written ─
-- For EVERY role, including service_role — the tg_job_budget_immutable
-- transplant. The single legal UPDATE is setting superseded_at on the current
-- row as the next revision lands.
create or replace function public.tg_job_programme_baseline_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.superseded_at is not null then
    raise exception 'programme revision % is history and cannot be changed', old.revision
      using errcode = 'check_violation';
  end if;
  if new.superseded_at is null
     or new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.job_id is distinct from old.job_id
     or new.revision is distinct from old.revision
     or new.planned_start is distinct from old.planned_start
     or new.planned_end is distinct from old.planned_end
     or new.note is distinct from old.note
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'a programme baseline is immutable — record a new revision instead'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists job_programme_baselines_immutable on public.job_programme_baselines;
create trigger job_programme_baselines_immutable
  before update on public.job_programme_baselines
  for each row execute function public.tg_job_programme_baseline_immutable();

-- ── 4. a targeted baseline delete is refused; every CASCADE still works ─────
-- The 20261047 / 20261064 / 20261072 idiom. During a cascade the PARENT ROW IS
-- ALREADY GONE (PostgreSQL deletes the referenced row, then runs the
-- referential action), so:
--
--   delete from organizations …            → org absent  → allowed (teardown)
--   delete from jobs …                     → job absent  → allowed
--   delete from job_programme_baselines …  → both present → REFUSED, every role
--
-- SECURITY DEFINER is load-bearing (the 20261052 argument): both existence
-- checks must be TRUE facts about the database, not facts about what the
-- caller's RLS lets them see — a caller whose RLS hides the org or the job
-- would make the check say "already gone" and the guard would silently permit
-- the delete it exists to refuse.
create or replace function public.tg_job_programme_baseline_no_targeted_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id)
     and exists (select 1 from public.jobs where id = old.job_id) then
    raise exception 'a programme revision cannot be deleted — the baseline history is the audit trail'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
drop trigger if exists job_programme_baselines_no_targeted_delete on public.job_programme_baselines;
create trigger job_programme_baselines_no_targeted_delete
  before delete on public.job_programme_baselines
  for each row execute function public.tg_job_programme_baseline_no_targeted_delete();

-- ── 5. milestones are FROZEN: no UPDATE ever, for any role ───────────────────
-- A milestone belongs to exactly one written revision. There is nothing on the
-- row that may legally change after insert — changing the plan is recording a
-- new revision through set_job_programme. Stronger than the baseline trigger,
-- and deliberately so: no field-by-field carve-out means no field can ever be
-- quietly added to one.
create or replace function public.tg_job_milestone_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'a programme milestone is immutable — record a new baseline revision instead'
    using errcode = 'check_violation';
end $$;
drop trigger if exists job_milestones_frozen on public.job_milestones;
create trigger job_milestones_frozen before update on public.job_milestones
  for each row execute function public.tg_job_milestone_frozen();

-- ── 6. a targeted milestone delete is refused; cascades pass ─────────────────
-- Cascade-aware on BOTH the org and the parent revision (the 20261052 trap,
-- one level deeper): during org teardown the org row is already gone; during a
-- job or baseline cascade the baseline row is already gone. Only a delete aimed
-- at a milestone while its revision still stands — cherry-picking a milestone
-- out of written history — is refused, for every role.
create or replace function public.tg_job_milestone_no_targeted_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id)
     and exists (select 1 from public.job_programme_baselines where id = old.baseline_id) then
    raise exception 'a programme milestone cannot be deleted — supersede the baseline instead'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
drop trigger if exists job_milestones_no_targeted_delete on public.job_milestones;
create trigger job_milestones_no_targeted_delete before delete on public.job_milestones
  for each row execute function public.tg_job_milestone_no_targeted_delete();

-- ── 7. RLS — members read, admins write (job-level planning configuration) ───
-- The 20261072 posture, DB-enforced: an app-only gate leaves
-- /rest/v1/job_programme_baselines open to any member holding a JWT. There is
-- NO delete policy on either table (refused twice over: no policy, then the
-- trigger) and NO update policy on milestones at all (refused twice over: no
-- policy, then the frozen trigger).
alter table public.job_programme_baselines enable row level security;
alter table public.job_milestones enable row level security;

drop policy if exists "job_programme_baselines: members can select" on public.job_programme_baselines;
create policy "job_programme_baselines: members can select" on public.job_programme_baselines
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_programme_baselines: admins can insert" on public.job_programme_baselines;
create policy "job_programme_baselines: admins can insert" on public.job_programme_baselines
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_programme_baselines: admins can supersede" on public.job_programme_baselines;
create policy "job_programme_baselines: admins can supersede" on public.job_programme_baselines
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "job_milestones: members can select" on public.job_milestones;
create policy "job_milestones: members can select" on public.job_milestones
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_milestones: admins can insert" on public.job_milestones;
create policy "job_milestones: admins can insert" on public.job_milestones
  for insert to authenticated with check (public.is_org_admin(org_id));

-- ── 8. set_job_programme — supersede + header + children, ATOMICALLY ─────────
-- Recording a revision is 2+N statements (stamp the current row, insert the
-- header, insert every milestone). Split across PostgREST round trips they
-- cannot be atomic; a failure mid-way would leave a job with no current
-- baseline or a revision with half its milestones. One function is one
-- transaction, so neither state is reachable.
--
-- SECURITY INVOKER, deliberately: the caller's RLS still applies, so the
-- admins-only insert/update policies above are the real authorisation and this
-- is not a privileged back door around them (the stock-RPC rule, 20261065,
-- held by 20261072).
--
-- A per-job advisory lock serialises two admins re-baselining at once — the
-- loser re-reads the row it must supersede and lands cleanly as the next
-- revision instead of dying at the one-current index with a raw constraint
-- error.
create or replace function public.set_job_programme(
  p_job_id        uuid,
  p_org_id        uuid,
  p_planned_start date,
  p_planned_end   date,
  p_milestones    jsonb,
  p_note          text default null
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_current      public.job_programme_baselines;
  v_revision     int := 1;
  v_id           uuid;
  v_count        int;
  v_idx          int := 0;
  m              jsonb;
  v_title        text;
  v_m_start      date;
  v_m_end        date;
  v_weight       numeric;
  v_weight_count int := 0;
  v_weight_sum   numeric := 0;
begin
  if p_job_id is null or p_org_id is null then
    raise exception 'a job and an organisation are required';
  end if;
  if p_planned_start is null or p_planned_end is null then
    raise exception 'a programme needs a planned start and a planned end';
  end if;
  if p_planned_end < p_planned_start then
    raise exception 'the planned end cannot be before the planned start';
  end if;
  if p_milestones is null
     or jsonb_typeof(p_milestones) <> 'array'
     or jsonb_array_length(p_milestones) = 0 then
    raise exception 'a programme needs at least one milestone';
  end if;
  v_count := jsonb_array_length(p_milestones);

  -- Validate EVERY milestone before touching a row: titles, dates inside the
  -- baseline window, and the all-or-none Σ=100 weight rule. Refusing here, with
  -- a sentence, is friendlier than a CHECK-constraint error mid-insert — and
  -- the window rule exists ONLY here, because it is a rule about the SET
  -- (children vs their header), which a row-level CHECK cannot express.
  for m in select * from jsonb_array_elements(p_milestones) loop
    v_title := btrim(coalesce(m->>'title', ''));
    if v_title = '' or char_length(v_title) > 200 then
      raise exception 'every milestone needs a title of 1-200 characters';
    end if;
    begin
      v_m_end   := (m->>'planned_end')::date;
      v_m_start := nullif(m->>'planned_start', '')::date;
    exception when others then
      raise exception 'milestone "%" has an unreadable date — use YYYY-MM-DD', v_title;
    end;
    if v_m_end is null then
      raise exception 'milestone "%" needs a planned end date', v_title;
    end if;
    if v_m_end < p_planned_start or v_m_end > p_planned_end then
      raise exception 'milestone "%" ends outside the programme window', v_title;
    end if;
    if v_m_start is not null
       and (v_m_start < p_planned_start or v_m_start > v_m_end) then
      raise exception 'milestone "%" starts outside its own window', v_title;
    end if;
    if nullif(btrim(coalesce(m->>'weight', '')), '') is not null then
      begin
        v_weight := (m->>'weight')::numeric;
      exception when others then
        raise exception 'milestone "%" has an unreadable weight', v_title;
      end;
      if v_weight <= 0 or v_weight > 100 then
        raise exception 'a milestone weight must be greater than 0 and at most 100';
      end if;
      v_weight_count := v_weight_count + 1;
      v_weight_sum   := v_weight_sum + v_weight;
    end if;
  end loop;

  if v_weight_count not in (0, v_count) then
    raise exception 'weight every milestone or none of them — a partial weighting cannot draw an honest curve';
  end if;
  if v_weight_count = v_count and abs(v_weight_sum - 100) > 0.01 then
    raise exception 'milestone weights must sum to 100 (these sum to %)', v_weight_sum;
  end if;

  perform pg_advisory_xact_lock(hashtext('job_programme'), hashtext(p_job_id::text));

  select * into v_current
    from public.job_programme_baselines
   where job_id = p_job_id
     and org_id = p_org_id
     and superseded_at is null
   for update;

  if found then
    v_revision := v_current.revision + 1;
  end if;

  -- The friendly form of job_programme_revision_needs_reason — refused here,
  -- with a sentence, before the CHECK refuses it with a constraint name.
  if v_revision >= 2 and (p_note is null or length(btrim(p_note)) = 0) then
    raise exception 'moving the programme needs a note saying why — the baseline history is the audit trail';
  end if;

  if found then
    update public.job_programme_baselines
       set superseded_at = now()
     where id = v_current.id;
  end if;

  insert into public.job_programme_baselines (
    org_id, job_id, revision, planned_start, planned_end, note, created_by
  ) values (
    p_org_id, p_job_id, v_revision, p_planned_start, p_planned_end,
    nullif(btrim(p_note), ''), auth.uid()
  )
  returning id into v_id;

  for m in select * from jsonb_array_elements(p_milestones) loop
    v_idx := v_idx + 1;
    insert into public.job_milestones (
      org_id, baseline_id, title, planned_start, planned_end,
      weight, customer_visible, sort
    ) values (
      p_org_id,
      v_id,
      btrim(m->>'title'),
      nullif(m->>'planned_start', '')::date,
      (m->>'planned_end')::date,
      case
        when nullif(btrim(coalesce(m->>'weight', '')), '') is not null
        then round((m->>'weight')::numeric, 2)
        else null
      end,
      coalesce((m->>'customer_visible')::boolean, false),
      v_idx
    );
  end loop;

  return v_id;
end $$;

revoke all on function public.set_job_programme(uuid, uuid, date, date, jsonb, text)
  from public, anon;
grant execute on function public.set_job_programme(uuid, uuid, date, date, jsonb, text)
  to authenticated;
