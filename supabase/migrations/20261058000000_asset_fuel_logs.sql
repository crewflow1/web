-- Fleet — Train D: fuel + operating cost.
--
-- `asset_fuel_logs`, not `fleet_fuel_logs`: diesel goes into excavators,
-- dumpers, generators and site welfare units as well as vans, and every one of
-- those is already an `assets` row. Keying on asset_id (not on the vehicle
-- extension) means the same log serves plant and fleet, and the fuel spend of a
-- 5-tonne excavator is not silently unrecordable because it has no registration.
--
-- CROSS-TENANT CONTROL: the composite FK to assets(id, org_id) — the same
-- declarative control 20261056000000 added for fleet_vehicles, enforced for
-- every role including service_role, with no procedural code to bypass.
--
-- THE MPG QUESTION (why `is_full_fill` is not decoration):
-- Fuel consumption can only be computed tank-to-tank: distance travelled
-- between two BRIM-FULL fills, divided by the litres it took to refill. A
-- partial fill leaves an unknown quantity in the tank, so any figure derived
-- across one is arithmetic performed on a number nobody measured. This column
-- is what lets lib/fleet/fuel.ts REFUSE to compute rather than invent — see the
-- no-fake-MPG rule and its unit tests. Recording a partial fill is fully
-- supported; it simply does not produce an efficiency figure.
--
-- NO LEDGER DUPLICATION: this table does not post to `finances` and is not a
-- second expense ledger. It is the operational record of what went into the
-- tank. Wiring fuel spend into committed costs is a real seam but a deliberate
-- follow-up, not something to guess at here.
--
-- Additive, idempotent, reversible. To roll back:
--   drop trigger if exists asset_fuel_logs_odometer_sync on public.asset_fuel_logs;
--   drop function if exists public.tg_asset_fuel_logs_odometer_sync();
--   drop trigger if exists asset_fuel_logs_guard on public.asset_fuel_logs;
--   drop function if exists public.tg_asset_fuel_logs_guard();
--   drop table if exists public.asset_fuel_logs;

create table if not exists public.asset_fuel_logs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  asset_id      uuid not null,

  filled_on     date not null,
  -- Odometer at the pump, in MILES (UK). Same domain and bound as
  -- fleet_vehicles.odometer_miles so a reading moves between them unchanged.
  odometer_miles integer check (odometer_miles is null
                                or odometer_miles between 0 and 3000000),
  -- Nullable on purpose: an electric van is charged, not fuelled, and has cost
  -- and mileage but no litres. Inventing a litre figure for it would poison
  -- every aggregate downstream. When present it must be a real quantity.
  litres        numeric(10,2) check (litres is null or litres > 0),
  -- Pounds, 2dp, numeric — never a float (lib/money.ts is the display boundary,
  -- this is the storage boundary).
  cost          numeric(12,2) not null check (cost >= 0),
  -- Brim-full fill? THE precondition for any consumption figure (see header).
  is_full_fill  boolean not null default true,

  -- Where it was bought. Both shapes are real: a fuel-card account or a bulk
  -- supplier is a `suppliers` row (typed FK, same-org guarded); a motorway
  -- forecourt on the way to site is free text. Neither is forced.
  supplier_id   uuid references public.suppliers(id) on delete set null,
  station       text check (station is null or length(trim(station)) between 1 and 160),
  -- Who filled it. `users` + a membership check, matching every other
  -- staff reference in the asset spine.
  driver_id     uuid references public.users(id) on delete set null,
  notes         text check (notes is null or length(notes) <= 2000),

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),

  constraint asset_fuel_logs_asset_org_fk
    foreign key (asset_id, org_id) references public.assets (id, org_id)
    on update cascade on delete cascade,

  -- A log with neither a quantity nor a cost records nothing.
  constraint asset_fuel_logs_substance_check
    check (litres is not null or cost > 0)
);

-- ── indexes: org_id + the hot filters ────────────────────────────────────────
-- Per-vehicle history and the consecutive-full-fill walk, newest first, with a
-- unique `id` tiebreaker so a page boundary can never drop or repeat a row.
create index if not exists asset_fuel_logs_asset_idx
  on public.asset_fuel_logs (asset_id, filled_on desc, id desc);
-- Org-wide spend windows (the fleet cost page).
create index if not exists asset_fuel_logs_org_date_idx
  on public.asset_fuel_logs (org_id, filled_on desc, id desc);
-- Spend by supplier / fuel card.
create index if not exists asset_fuel_logs_supplier_idx
  on public.asset_fuel_logs (org_id, supplier_id) where supplier_id is not null;

-- ── guard: same-org references + date sanity ─────────────────────────────────
create or replace function public.tg_asset_fuel_logs_guard()
returns trigger language plpgsql as $$
begin
  if new.supplier_id is not null
     and not exists (select 1 from public.suppliers
                     where id = new.supplier_id and org_id = new.org_id) then
    raise exception 'supplier % is not in org %', new.supplier_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.driver_id is not null
     and not exists (select 1 from public.memberships
                     where user_id = new.driver_id and org_id = new.org_id) then
    raise exception 'driver % is not a member of org %', new.driver_id, new.org_id
      using errcode = 'check_violation';
  end if;
  -- A fill cannot have happened tomorrow. One day of slack absorbs the
  -- timezone gap between a phone's local date and the server's UTC day; this
  -- lives in the trigger rather than a CHECK because a CHECK containing now()
  -- is re-evaluated on every later UPDATE and would retroactively invalidate
  -- rows that were perfectly legal when written.
  if new.filled_on > (current_date + 1) then
    raise exception 'fuel log date % is in the future', new.filled_on
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_fuel_logs_guard on public.asset_fuel_logs;
create trigger asset_fuel_logs_guard before insert or update on public.asset_fuel_logs
  for each row execute function public.tg_asset_fuel_logs_guard();

drop trigger if exists asset_fuel_logs_set_updated_at on public.asset_fuel_logs;
create trigger asset_fuel_logs_set_updated_at before update on public.asset_fuel_logs
  for each row execute function public.tg_set_updated_at();

-- ── odometer sync: the fleet register's "current mileage" ────────────────────
-- Advances fleet_vehicles.odometer_miles when a fill carries a HIGHER reading
-- than the one on record. Strictly forward-only, so back-dated entry of an old
-- receipt can never rewind a vehicle's mileage. A no-op for assets with no
-- vehicle extension (plant), and for readings that are absent or not higher.
--
-- SECURITY INVOKER (the default) on purpose: it must NOT be able to touch a row
-- the caller could not touch directly. fleet_vehicles' own RLS therefore still
-- applies, and its guard trigger still fires — this is a convenience
-- materialisation, never a privilege escalation. It is deliberately not a
-- generated column: the value's authority is "latest known reading from any
-- source", which no single expression over this table can express.
create or replace function public.tg_asset_fuel_logs_odometer_sync()
returns trigger language plpgsql as $$
begin
  if new.odometer_miles is null then
    return null;
  end if;
  update public.fleet_vehicles v
     set odometer_miles = new.odometer_miles,
         odometer_recorded_at = now()
   where v.asset_id = new.asset_id
     and v.org_id = new.org_id
     and (v.odometer_miles is null or new.odometer_miles > v.odometer_miles);
  return null;
end $$;

drop trigger if exists asset_fuel_logs_odometer_sync on public.asset_fuel_logs;
create trigger asset_fuel_logs_odometer_sync
  after insert or update of odometer_miles on public.asset_fuel_logs
  for each row execute function public.tg_asset_fuel_logs_odometer_sync();

-- ── RLS: matches asset_maintenance_cases (member CRUD, admin delete) ─────────
-- Fuel cost is operational, not commercially sensitive: it is the crew's own
-- spend, unlike the supplier labour rates that 20261002000000 deliberately hid
-- from members in an admin-only satellite. A driver must be able to log the
-- fill they just paid for. Deletion stays admin-only because a fuel log is
-- expense evidence.
alter table public.asset_fuel_logs enable row level security;

create policy asset_fuel_logs_select on public.asset_fuel_logs
  for select using (org_id in (select public.current_org_ids()));
create policy asset_fuel_logs_insert on public.asset_fuel_logs
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_fuel_logs_update on public.asset_fuel_logs
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy asset_fuel_logs_delete on public.asset_fuel_logs
  for delete using (public.is_org_admin(org_id));

-- ── attachments: receipts ride the universal pipeline ────────────────────────
-- Introspect + rebuild, preserving EVERY prior target. The 15 targets below
-- were read back from the LIVE constraint (pg_get_constraintdef on the applied
-- 20261055 schema), never reconstructed from memory — the introspection drops
-- whatever is there, so an under-stated list here would silently REVOKE
-- attachment support for a whole domain. 20261002000000 is the last migration
-- that widened it; 'asset_fuel_logs' is the 16th.
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
                          'asset_maintenance_cases',
                          'asset_fuel_logs'));
