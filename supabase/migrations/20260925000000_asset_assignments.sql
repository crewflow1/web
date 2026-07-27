-- Asset Management — Milestone 2: assignment, custody & transfer.
--
-- Custody history for every asset: who has it, on which job/vehicle, at which
-- depot, in what condition, due back when. The DEFINING risk of this milestone
-- is conflicting custody, so the invariant is enforced at the DATABASE, never
-- the frontend:
--
--   1. AT MOST ONE OPEN ASSIGNMENT PER ASSET — a PARTIAL UNIQUE INDEX. Two
--      concurrent check-outs => exactly one wins; the loser gets a unique
--      violation the action translates to "already assigned". No app-level
--      "check-then-insert" race window.
--   2. SAME-ORG references + ELIGIBILITY — a BEFORE trigger: the asset, and any
--      job / assignee / vehicle destination, must belong to the row's org; and a
--      NEW OPEN assignment is rejected unless the asset's lifecycle status is
--      'active' (retired/sold/lost/stolen/written_off can't be issued).
--
-- Custody is a SEPARATE concern from the asset's lifecycle status (on `assets`)
-- and from operational availability — this table records custody + history only.
-- Additive + reversible. Reuses jobs / users / assets(vehicle) / suppliers via
-- typed FKs, and tenant_attachments for issue/return evidence.

create table if not exists public.asset_assignments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  asset_id           uuid not null references public.assets(id) on delete cascade,
  assignment_type    text not null
    check (assignment_type in ('issued_to_staff', 'allocated_to_job',
                               'stored_at_depot', 'loaded_on_vehicle',
                               'sent_for_repair', 'returned_to_supplier')),
  -- Typed destinations — the relevant one is set per assignment_type. `location`
  -- carries a depot/yard name or a justified free-text location.
  job_id             uuid references public.jobs(id) on delete set null,
  assignee_id        uuid references public.users(id) on delete set null,
  vehicle_asset_id   uuid references public.assets(id) on delete set null,
  location           text,
  assigned_by        uuid references public.users(id) on delete set null,
  assigned_at        timestamp with time zone not null default now(),
  expected_return_at date,
  actual_return_at   timestamp with time zone,
  returned_by        uuid references public.users(id) on delete set null,
  issue_condition    text
    check (issue_condition is null or issue_condition in
      ('excellent', 'good', 'fair', 'damaged', 'unsafe', 'incomplete', 'unknown')),
  return_condition   text
    check (return_condition is null or return_condition in
      ('excellent', 'good', 'fair', 'damaged', 'unsafe', 'incomplete', 'unknown')),
  issue_notes        text,
  return_notes       text,
  issue_meter_reading  numeric(12, 1),
  return_meter_reading numeric(12, 1),
  status             text not null default 'open'
    check (status in ('open', 'closed', 'cancelled')),
  -- Transfer lineage: the assignment this one succeeded (set atomically on transfer).
  transferred_from_id uuid references public.asset_assignments(id) on delete set null,
  created_at         timestamp with time zone not null default now(),
  updated_at         timestamp with time zone not null default now()
);

-- THE INVARIANT: at most one open assignment per asset.
create unique index if not exists asset_assignments_one_open_idx
  on public.asset_assignments (asset_id) where status = 'open';

-- Current custody + history lookups (indexed, no full scans).
create index if not exists asset_assignments_asset_idx
  on public.asset_assignments (asset_id, assigned_at desc);
create index if not exists asset_assignments_org_open_idx
  on public.asset_assignments (org_id) where status = 'open';
create index if not exists asset_assignments_job_idx
  on public.asset_assignments (job_id) where job_id is not null;
create index if not exists asset_assignments_assignee_idx
  on public.asset_assignments (assignee_id) where assignee_id is not null;
create index if not exists asset_assignments_overdue_idx
  on public.asset_assignments (expected_return_at)
  where status = 'open' and expected_return_at is not null;

alter table public.asset_assignments enable row level security;

create policy asset_assignments_select on public.asset_assignments
  for select using (org_id in (select public.current_org_ids()));
create policy asset_assignments_insert on public.asset_assignments
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_assignments_update on public.asset_assignments
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
-- Custody is evidence — hard delete admin-only; members cancel/close instead.
create policy asset_assignments_delete on public.asset_assignments
  for delete using (public.is_org_admin(org_id));

drop trigger if exists asset_assignments_set_updated_at on public.asset_assignments;
create trigger asset_assignments_set_updated_at before update on public.asset_assignments
  for each row execute function public.tg_set_updated_at();

-- Same-org references + eligibility, enforced at the DB (belt to the app's
-- braces). RLS scopes the ROW's org; this scopes what the row POINTS AT.
create or replace function public.tg_asset_assignments_guard()
returns trigger language plpgsql as $$
declare
  a_status text;
  a_org uuid;
begin
  select status, org_id into a_status, a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  -- A new OPEN assignment requires an ACTIVE asset (retired/sold/lost/stolen/
  -- written_off cannot be issued). Closing/cancelling is always allowed.
  if new.status = 'open' and a_status <> 'active' then
    raise exception 'asset % is % and cannot be assigned', new.asset_id, a_status
      using errcode = 'check_violation';
  end if;
  if new.job_id is not null
     and not exists (select 1 from public.jobs where id = new.job_id and org_id = new.org_id) then
    raise exception 'job % is not in org %', new.job_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.vehicle_asset_id is not null
     and not exists (select 1 from public.assets where id = new.vehicle_asset_id and org_id = new.org_id) then
    raise exception 'vehicle asset % is not in org %', new.vehicle_asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.assignee_id is not null
     and not exists (select 1 from public.memberships where user_id = new.assignee_id and org_id = new.org_id) then
    raise exception 'assignee % is not a member of org %', new.assignee_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_assignments_guard on public.asset_assignments;
create trigger asset_assignments_guard before insert or update on public.asset_assignments
  for each row execute function public.tg_asset_assignments_guard();

-- Atomic transfer: close an asset's current open assignment and open the next,
-- in ONE transaction (a function body is atomic). SECURITY INVOKER so the
-- caller's RLS, the guard trigger and the partial unique index ALL still apply —
-- if opening the next fails (eligibility, cross-org, etc.) the whole transfer
-- rolls back and the original custody stays intact. Never two unrelated calls.
create or replace function public.transfer_asset_assignment(
  p_asset_id           uuid,
  p_org_id             uuid,
  p_assignment_type    text,
  p_job_id             uuid,
  p_assignee_id        uuid,
  p_vehicle_asset_id   uuid,
  p_location           text,
  p_issue_condition    text,
  p_issue_notes        text,
  p_expected_return_at date,
  p_assigned_by        uuid
) returns uuid
language plpgsql
as $$
declare
  v_old uuid;
  v_new uuid;
begin
  update public.asset_assignments
     set status = 'closed', actual_return_at = now(), returned_by = p_assigned_by
   where asset_id = p_asset_id and org_id = p_org_id and status = 'open'
   returning id into v_old;

  insert into public.asset_assignments (
    org_id, asset_id, assignment_type, job_id, assignee_id, vehicle_asset_id,
    location, issue_condition, issue_notes, expected_return_at, assigned_by,
    transferred_from_id, status
  ) values (
    p_org_id, p_asset_id, p_assignment_type, p_job_id, p_assignee_id,
    p_vehicle_asset_id, p_location, p_issue_condition, p_issue_notes,
    p_expected_return_at, p_assigned_by, v_old, 'open'
  ) returning id into v_new;

  return v_new;
end $$;

-- Issue/return evidence rides the universal attachments pipeline. Widen the
-- shared CHECK by introspection, preserving every prior target.
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
                          'assets', 'asset_assignments'));
