-- Asset Management — Milestone 5b: service schedules + idempotent generation.
--
-- Standing preventive-maintenance rules ("service every 6 months", "calibration
-- annually", "MOT one-off on a date") that generate maintenance CASES — a
-- direct clone of the PROVEN M4b-2 model (20260930): the generated record IS a
-- case in status 'scheduled'; the INSERT ... ON CONFLICT DO NOTHING on a TOTAL
-- unique (schedule_id, cycle_key) IS the claim; advancement is a count-gated
-- CAS on next_due; one-offs deactivate after generating. No second scheduler
-- framework — the pure date maths is REUSED from lib/assets/inspection-schedule.
--
-- Deliberately NO pair CHECK tying schedule_id to cycle_key on the cases table:
-- schedule deletion is `on delete set null` on schedule_id only, which a pair
-- CHECK would turn into an un-deletable schedule (the M4b-2 lesson, and the fix
-- for the reviewed design's known bug). Additive + dark.

create table if not exists public.asset_service_schedules (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  asset_id          uuid not null references public.assets(id) on delete cascade,
  maintenance_type  text not null
    check (maintenance_type in ('preventive', 'service', 'calibration')),
  title             text,
  -- Cadence: exactly one of days/months for recurring; BOTH NULL = one-off.
  interval_days     integer
    check (interval_days is null or interval_days between 1 and 3660),
  interval_months   integer
    check (interval_months is null or interval_months between 1 and 120),
  constraint asset_service_schedules_interval_check
    check (interval_days is null or interval_months is null),
  next_due          date not null,
  last_completed_at timestamp with time zone,
  -- Services need booking lead time (parts, fitter, workshop slot).
  lead_time_days    integer not null default 14
    check (lead_time_days between 0 and 365),
  active            boolean not null default true,
  supplier_id       uuid references public.suppliers(id) on delete set null,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

create index if not exists asset_service_schedules_due_idx
  on public.asset_service_schedules (next_due) where active;
create index if not exists asset_service_schedules_asset_idx
  on public.asset_service_schedules (asset_id);
create index if not exists asset_service_schedules_org_idx
  on public.asset_service_schedules (org_id, active);

create or replace function public.tg_asset_service_schedules_guard()
returns trigger language plpgsql as $$
declare
  a_org uuid;
begin
  select org_id into a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.supplier_id is not null
     and not exists (select 1 from public.suppliers where id = new.supplier_id and org_id = new.org_id) then
    raise exception 'supplier % is not in org %', new.supplier_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_service_schedules_guard on public.asset_service_schedules;
create trigger asset_service_schedules_guard
  before insert or update on public.asset_service_schedules
  for each row execute function public.tg_asset_service_schedules_guard();

drop trigger if exists asset_service_schedules_set_updated_at on public.asset_service_schedules;
create trigger asset_service_schedules_set_updated_at
  before update on public.asset_service_schedules
  for each row execute function public.tg_set_updated_at();

-- Standing rules that generate work: admin-only writes, member read
-- (ai_receptionist_setups precedent; matches inspection schedules).
alter table public.asset_service_schedules enable row level security;

create policy asset_service_schedules_select on public.asset_service_schedules
  for select using (org_id in (select public.current_org_ids()));
create policy asset_service_schedules_insert on public.asset_service_schedules
  for insert with check (public.is_org_admin(org_id));
create policy asset_service_schedules_update on public.asset_service_schedules
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
create policy asset_service_schedules_delete on public.asset_service_schedules
  for delete using (public.is_org_admin(org_id));

-- ── Generated-case provenance + THE claim arbiter ────────────────────────────
alter table public.asset_maintenance_cases
  add column if not exists schedule_id uuid
    references public.asset_service_schedules(id) on delete set null,
  add column if not exists cycle_key text;

create unique index if not exists asset_maintenance_cases_schedule_cycle_idx
  on public.asset_maintenance_cases (schedule_id, cycle_key);

-- ── Extend the cases guard (CREATE OR REPLACE; prior arms VERBATIM) ──────────
-- Adds one arm: generated provenance must be a same-org schedule FOR THE SAME
-- ASSET (a schedule generates cases only for its own asset).
create or replace function public.tg_asset_maintenance_cases_guard()
returns trigger language plpgsql as $$
declare
  a_org uuid;
begin
  select org_id into a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.supplier_id is not null
     and not exists (select 1 from public.suppliers where id = new.supplier_id and org_id = new.org_id) then
    raise exception 'supplier % is not in org %', new.supplier_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.source_inspection_id is not null
     and not exists (select 1 from public.asset_inspections
                     where id = new.source_inspection_id and org_id = new.org_id) then
    raise exception 'inspection % is not in org %', new.source_inspection_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.source_assignment_id is not null
     and not exists (select 1 from public.asset_assignments
                     where id = new.source_assignment_id and org_id = new.org_id) then
    raise exception 'assignment % is not in org %', new.source_assignment_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.assigned_to is not null
     and not exists (select 1 from public.memberships
                     where user_id = new.assigned_to and org_id = new.org_id) then
    raise exception 'assignee % is not a member of org %', new.assigned_to, new.org_id
      using errcode = 'check_violation';
  end if;
  -- M5b: generated provenance — same-org schedule for the SAME asset.
  if new.schedule_id is not null
     and not exists (select 1 from public.asset_service_schedules s
                     where s.id = new.schedule_id and s.org_id = new.org_id
                       and s.asset_id = new.asset_id) then
    raise exception 'schedule % is not in org % for asset %', new.schedule_id, new.org_id, new.asset_id
      using errcode = 'check_violation';
  end if;

  if new.status = 'completed'
     and (new.work_performed is null or length(btrim(new.work_performed)) = 0
          or new.completed_at is null) then
    raise exception 'a completed maintenance case requires work evidence (case %)', new.id
      using errcode = 'check_violation';
  end if;

  if new.status = 'ready_for_return_to_service'
     and (tg_op = 'INSERT' or old.status is distinct from 'ready_for_return_to_service')
     and new.source_inspection_id is not null
     and exists (select 1 from public.asset_inspections f
                 where f.id = new.source_inspection_id
                   and f.safety_critical and f.status = 'issued' and f.outcome = 'fail')
     and not public.asset_inspection_fail_is_cleared(new.source_inspection_id) then
    raise exception 'case % has an unresolved safety block and cannot return to service', new.id
      using errcode = 'check_violation';
  end if;

  if new.status = 'cancelled'
     and (new.cancellation_reason is null or length(btrim(new.cancellation_reason)) = 0) then
    raise exception 'a cancelled maintenance case requires a reason (case %)', new.id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and old.status = 'completed'
     and (new.status is distinct from old.status
          or new.work_performed is distinct from old.work_performed
          or new.completed_at is distinct from old.completed_at) then
    raise exception 'a completed maintenance case is frozen (case %)', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists asset_maintenance_cases_guard on public.asset_maintenance_cases;
create trigger asset_maintenance_cases_guard
  before insert or update on public.asset_maintenance_cases
  for each row execute function public.tg_asset_maintenance_cases_guard();
