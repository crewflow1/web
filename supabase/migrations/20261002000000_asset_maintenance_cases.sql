-- Asset Management — Milestone 5a: maintenance cases + state machine + costs.
--
-- One shared repair flow for every entry point (breakdown report, failed
-- inspection, damaged return, planned service): a maintenance case with an
-- explicit, server-validated state machine. The app owns transition LEGALITY
-- (pure module, house pattern); the DB hard-enforces the INVARIANTS:
--
--   G1  a COMPLETED case requires work evidence (work_performed + completed_at);
--   G2  READY_FOR_RETURN_TO_SERVICE requires the linked safety fail (if any) to
--       be CLEARED — via the SAME shared predicate the custody guard uses
--       (asset_inspection_fail_is_cleared, 20261001), so the two can never
--       drift. The custody guard remains the final enforcement boundary.
--   G3  a CANCELLED case requires a reason;
--   G4  a COMPLETED case is FROZEN (evidence can never be reopened/rewritten —
--       even by service role; triggers fire for every role);
--   G0  every reference (asset, supplier, source inspection, source assignment,
--       assignee) is same-org.
--
-- COSTS live in a SATELLITE table with ADMIN-ONLY RLS on ALL FOUR VERBS —
-- row-level security cannot hide columns, so supplier rates / labour costs are
-- invisible to members AT THE DATABASE (the P4 staff/private split discipline).
-- Costs stay editable after completion (external invoices arrive late) — one
-- more reason they live off the frozen case.
--
-- Operational availability: `out_of_service` is a member-visible flag surfaced
-- in UI — DELIBERATELY NOT a custody-guard block (decision B3): moving a broken
-- asset to the fitter IS an open assignment (`sent_for_repair`), and a
-- dangerous asset is recorded as a failed safety inspection, which engages the
-- full M4c/M4d machinery. Schedule provenance (schedule_id + cycle_key) arrives
-- with the M5b schedules table. Additive + dark.

create table if not exists public.asset_maintenance_cases (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references public.organizations(id) on delete cascade,
  asset_id              uuid not null references public.assets(id) on delete cascade,
  case_type             text not null
    check (case_type in ('breakdown', 'corrective', 'preventive',
                         'service', 'calibration', 'warranty')),
  priority              text not null default 'medium'
    check (priority in ('low', 'medium', 'high')),
  status                text not null default 'reported'
    check (status in ('reported', 'triaged', 'scheduled', 'awaiting_parts',
                      'in_progress', 'awaiting_supplier', 'ready_for_reinspection',
                      'ready_for_return_to_service', 'completed', 'cancelled')),
  title                 text not null,
  description           text,
  -- Provenance (typed FK reuse; same-org-guarded below).
  source_inspection_id  uuid references public.asset_inspections(id) on delete set null,
  source_assignment_id  uuid references public.asset_assignments(id) on delete set null,
  -- Execution.
  supplier_id           uuid references public.suppliers(id) on delete set null,
  assigned_to           uuid references public.users(id) on delete set null,
  scheduled_for         date,
  work_performed        text,          -- THE completion evidence
  parts_used            text,
  -- Operational availability (member-visible; NOT custody — see header).
  out_of_service        boolean not null default false,
  downtime_start        timestamp with time zone,
  downtime_end          timestamp with time zone,
  reinspection_required boolean not null default false,
  -- Lifecycle stamps.
  reported_by           uuid references public.users(id) on delete set null,
  completed_at          timestamp with time zone,
  completed_by          uuid references public.users(id) on delete set null,
  cancelled_at          timestamp with time zone,
  cancelled_by          uuid references public.users(id) on delete set null,
  cancellation_reason   text,
  created_at            timestamp with time zone not null default now(),
  updated_at            timestamp with time zone not null default now(),
  constraint asset_maintenance_cases_downtime_check
    check (downtime_end is null
           or (downtime_start is not null and downtime_end >= downtime_start))
);

create index if not exists asset_maintenance_cases_asset_idx
  on public.asset_maintenance_cases (asset_id, created_at desc);
create index if not exists asset_maintenance_cases_org_active_idx
  on public.asset_maintenance_cases (org_id, status)
  where status not in ('completed', 'cancelled');
create index if not exists asset_maintenance_cases_planner_idx
  on public.asset_maintenance_cases (scheduled_for)
  where scheduled_for is not null and status not in ('completed', 'cancelled');

-- ── Guard: same-org refs (G0) + the DB-hard invariants (G1–G4) ───────────────
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

  -- G1: completed requires work evidence.
  if new.status = 'completed'
     and (new.work_performed is null or length(btrim(new.work_performed)) = 0
          or new.completed_at is null) then
    raise exception 'a completed maintenance case requires work evidence (case %)', new.id
      using errcode = 'check_violation';
  end if;

  -- G2: return-to-service requires the LINKED safety fail (if any) to be
  -- cleared — linked pass | later pass | active override, the shared predicate.
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

  -- G3: cancelled requires a reason.
  if new.status = 'cancelled'
     and (new.cancellation_reason is null or length(btrim(new.cancellation_reason)) = 0) then
    raise exception 'a cancelled maintenance case requires a reason (case %)', new.id
      using errcode = 'check_violation';
  end if;

  -- G4: completed is terminal at the DB — evidence can never be rewritten.
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

drop trigger if exists asset_maintenance_cases_set_updated_at on public.asset_maintenance_cases;
create trigger asset_maintenance_cases_set_updated_at
  before update on public.asset_maintenance_cases
  for each row execute function public.tg_set_updated_at();

-- ── RLS (cases): member CRUD, admin delete — maintenance is org history ──────
alter table public.asset_maintenance_cases enable row level security;

create policy asset_maintenance_cases_select on public.asset_maintenance_cases
  for select using (org_id in (select public.current_org_ids()));
create policy asset_maintenance_cases_insert on public.asset_maintenance_cases
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_maintenance_cases_update on public.asset_maintenance_cases
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy asset_maintenance_cases_delete on public.asset_maintenance_cases
  for delete using (public.is_org_admin(org_id));

-- ── Costs satellite: ADMIN-ONLY at the DB on all four verbs ──────────────────
create table if not exists public.asset_maintenance_case_costs (
  case_id       uuid primary key references public.asset_maintenance_cases(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  cost_parts    numeric(12, 2) not null default 0 check (cost_parts >= 0),
  cost_labour   numeric(12, 2) not null default 0 check (cost_labour >= 0),
  cost_external numeric(12, 2) not null default 0 check (cost_external >= 0),
  cost_notes    text,
  updated_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

create or replace function public.tg_asset_maintenance_case_costs_guard()
returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.asset_maintenance_cases
                 where id = new.case_id and org_id = new.org_id) then
    raise exception 'case % is not in org %', new.case_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_maintenance_case_costs_guard on public.asset_maintenance_case_costs;
create trigger asset_maintenance_case_costs_guard
  before insert or update on public.asset_maintenance_case_costs
  for each row execute function public.tg_asset_maintenance_case_costs_guard();

drop trigger if exists asset_maintenance_case_costs_set_updated_at on public.asset_maintenance_case_costs;
create trigger asset_maintenance_case_costs_set_updated_at
  before update on public.asset_maintenance_case_costs
  for each row execute function public.tg_set_updated_at();

alter table public.asset_maintenance_case_costs enable row level security;

-- Supplier rates / labour costs are commercially sensitive: invisible to
-- members AT THE DATABASE. Admin-only on every verb (deliberate deviation from
-- member-CRUD, mirrored by the action-layer role gate).
create policy asset_maintenance_case_costs_select on public.asset_maintenance_case_costs
  for select using (public.is_org_admin(org_id));
create policy asset_maintenance_case_costs_insert on public.asset_maintenance_case_costs
  for insert with check (public.is_org_admin(org_id));
create policy asset_maintenance_case_costs_update on public.asset_maintenance_case_costs
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
create policy asset_maintenance_case_costs_delete on public.asset_maintenance_case_costs
  for delete using (public.is_org_admin(org_id));

-- ── Attachments: widen the universal CHECK to accept 'asset_maintenance_cases'
-- Introspect + rebuild, preserving EVERY prior target (authority: 20260927,
-- 14 targets — inspected, never reconstructed from memory).
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets', 'asset_assignments', 'asset_inspections',
                          'asset_maintenance_cases'));
