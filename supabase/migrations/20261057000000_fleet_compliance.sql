-- Fleet — Train C: vehicle compliance on the EXISTING maintenance engines.
--
-- MOT, insurance and road tax are recurring, dated obligations that produce a
-- piece of work with a provider, a cost, a mileage and a certificate. That is
-- precisely what `asset_service_schedules` (20261003000000) generates and what
-- `asset_maintenance_cases` (20261002000000) records. Building a
-- `vehicle_compliance_events` table would fork BOTH: a second scheduler with a
-- second idempotency story, and a second completion record with a second
-- evidence rule and a second cost satellite.
--
-- So this migration WIDENS rather than forks. Three changes, no new table:
--
--   1. asset_service_schedules.maintenance_type gains 'mot','insurance','road_tax'.
--   2. asset_maintenance_cases.case_type gains the SAME three. This is NOT
--      optional decoration: server/services/asset-maintenance-generator.ts
--      passes `case_type: schedule.maintenance_type` STRAIGHT THROUGH (line 98).
--      Widening the schedule CHECK alone would make every generated MOT case
--      fail its insert with a check violation the moment the cron ran. The two
--      CHECKs are coupled by that passthrough and must move together.
--   3. asset_maintenance_cases gains `odometer_miles` — the mileage AT the
--      event, which an MOT certificate records and which a service interval is
--      judged against. Nullable: non-vehicle assets have no odometer.
--
-- WHAT IS DELIBERATELY *NOT* WIDENED:
--   'inspection' is absent from this list on purpose. A vehicle inspection is
--   not a new concept needing a new type — `asset_inspection_schedules` +
--   `asset_inspections` (20260927-20261001) already own scheduled inspections,
--   with immutable issued snapshots, safety-critical fail blocking and the
--   override machinery. Adding 'inspection' to the maintenance types would
--   create a second, weaker inspection path that skips all of it. Fleet routes
--   inspections to the existing engine.
--
-- Everything a compliance event needs already exists on the case:
--   due date        → scheduled_for          completed date → completed_at
--   provider/garage → supplier_id            cost           → asset_maintenance_case_costs (admin-only)
--   evidence        → tenant_attachments ('asset_maintenance_cases')
--   provenance      → schedule_id + cycle_key    history    → the case list itself
--
-- WIDENING ONLY — every previously-legal value stays legal, so no existing row
-- and no existing caller can be invalidated. Additive and reversible (re-adding
-- the narrower CHECK requires no rows to hold the new values).

-- ── 1. schedules: allow the three compliance cadences ────────────────────────
-- Introspect-then-rebuild rather than dropping a hard-coded constraint name —
-- the tenant_attachments idiom used throughout this history. Matching on the
-- constraint DEFINITION mentioning the column is unambiguous here: it is the
-- only CHECK on this table that references maintenance_type.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'asset_service_schedules'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%maintenance_type%';
  if cname is not null then
    execute format('alter table public.asset_service_schedules drop constraint %I', cname);
  end if;
end $$;

alter table public.asset_service_schedules
  add constraint asset_service_schedules_maintenance_type_check
  check (maintenance_type in ('preventive', 'service', 'calibration',
                              'mot', 'insurance', 'road_tax'));

-- ── 2. cases: the generator's passthrough target must accept the same set ────
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'asset_maintenance_cases'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%case_type%';
  if cname is not null then
    execute format('alter table public.asset_maintenance_cases drop constraint %I', cname);
  end if;
end $$;

alter table public.asset_maintenance_cases
  add constraint asset_maintenance_cases_case_type_check
  check (case_type in ('breakdown', 'corrective', 'preventive', 'service',
                       'calibration', 'warranty',
                       'mot', 'insurance', 'road_tax'));

-- ── 3. mileage at the event ──────────────────────────────────────────────────
-- Same units and same sanity bound as fleet_vehicles.odometer_miles (20261056)
-- so a reading can move between the two without a conversion or a wider domain.
alter table public.asset_maintenance_cases
  add column if not exists odometer_miles integer;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'asset_maintenance_cases_odometer_check'
  ) then
    alter table public.asset_maintenance_cases
      add constraint asset_maintenance_cases_odometer_check
      check (odometer_miles is null or odometer_miles between 0 and 3000000);
  end if;
end $$;

-- The compliance attention sweep: this org's open compliance work, soonest
-- first. Partial on the three compliance types so it stays small next to the
-- general-purpose maintenance indexes already on this table.
create index if not exists asset_maintenance_cases_compliance_idx
  on public.asset_maintenance_cases (org_id, scheduled_for)
  where case_type in ('mot', 'insurance', 'road_tax')
    and status not in ('completed', 'cancelled');

-- ── 4. atomic completion: record the event AND roll the next due date ────────
-- Recording an MOT pass is two writes — complete the case, and move the
-- schedule's next_due to next year. Split across two PostgREST calls they can
-- half-succeed, and BOTH halves fail dangerously:
--   case written, schedule not advanced → the vehicle shows overdue forever;
--   schedule advanced, case not written → a legal obligation silently vanishes
--                                         from the attention list with no
--                                         evidence it was ever met.
-- The second is the one that gets a company prosecuted, so this is a
-- transaction, not a convenience. A function body is atomic: both, or neither.
--
-- SECURITY INVOKER — the caller's RLS, the cases guard (which enforces
-- "completed requires work evidence") and the schedules' admin-only write
-- policy all still apply. p_org_id is the ACTIVE-ORG PIN on every statement.
create or replace function public.record_fleet_compliance_completion(
  p_org_id         uuid,
  p_asset_id       uuid,
  p_case_id        uuid,      -- an existing (generated) case to complete, or null
  p_schedule_id    uuid,      -- the standing schedule to advance, or null
  p_case_type      text,
  p_title          text,
  p_completed_on   date,
  p_odometer_miles integer,
  p_supplier_id    uuid,
  p_work_performed text,
  p_next_due       date,      -- null = do not advance
  p_completed_by   uuid
) returns uuid
language plpgsql
as $$
declare
  v_case_id uuid;
  v_hit     integer;
begin
  if p_work_performed is null or length(btrim(p_work_performed)) = 0 then
    raise exception 'a completed compliance event needs a record of what was done'
      using errcode = 'check_violation';
  end if;

  if p_case_id is not null then
    -- Complete the case the generator already raised for this cycle, rather
    -- than creating a duplicate beside it.
    update public.asset_maintenance_cases set
      status         = 'completed',
      work_performed = p_work_performed,
      completed_at   = (p_completed_on::timestamptz),
      completed_by   = p_completed_by,
      supplier_id    = coalesce(p_supplier_id, supplier_id),
      odometer_miles = coalesce(p_odometer_miles, odometer_miles)
    where id = p_case_id and org_id = p_org_id and asset_id = p_asset_id
      and status <> 'completed'
    returning id into v_case_id;
    get diagnostics v_hit = row_count;
    if v_hit = 0 then
      raise exception 'compliance case % not found (or already completed) in org %',
        p_case_id, p_org_id using errcode = 'no_data_found';
    end if;
  else
    -- Ad-hoc: the work was done without a standing schedule having raised it.
    insert into public.asset_maintenance_cases (
      org_id, asset_id, case_type, priority, status, title,
      work_performed, completed_at, completed_by, supplier_id,
      odometer_miles, scheduled_for, reported_by
    ) values (
      p_org_id, p_asset_id, p_case_type, 'medium', 'completed', p_title,
      p_work_performed, (p_completed_on::timestamptz), p_completed_by, p_supplier_id,
      p_odometer_miles, p_completed_on, p_completed_by
    ) returning id into v_case_id;
  end if;

  if p_schedule_id is not null and p_next_due is not null then
    update public.asset_service_schedules set
      next_due          = p_next_due,
      last_completed_at = (p_completed_on::timestamptz),
      active            = true
    where id = p_schedule_id and org_id = p_org_id and asset_id = p_asset_id;
    get diagnostics v_hit = row_count;
    if v_hit = 0 then
      raise exception 'schedule % not found in org % for asset %',
        p_schedule_id, p_org_id, p_asset_id using errcode = 'no_data_found';
    end if;
  end if;

  return v_case_id;
end $$;
