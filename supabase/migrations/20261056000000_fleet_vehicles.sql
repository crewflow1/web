-- Fleet — Train B: the vehicle register as a 1:1 EXTENSION of `assets`.
--
-- THE ARCHITECTURE DECISION (evidence, not assertion):
-- `public.assets` (20260924000000) ALREADY carries name, category, asset_ref,
-- manufacturer, model, serial_number, REGISTRATION, ownership (owned|hired),
-- lifecycle status, supplier_id, purchase_date, purchase_price, current_value,
-- warranty_expires_at, hire_start/end/rate and notes. Photos, manuals and V5C
-- scans already ride `tenant_attachments` with target_table='assets'. Custody
-- (who has the van) is `asset_assignments` (20260925000000) with its partial
-- unique open-assignment index and its atomic transfer RPC. Inspections
-- (20260927-20261001), maintenance cases (20261002000000) and service
-- schedules (20261003000000) all key on asset_id.
--
-- A vehicle is therefore an ASSET plus the handful of facts an asset does not
-- have (VIN, fuel type, vehicle class, gross weight, finance structure, depot,
-- odometer, operational availability). Modelling `fleet_vehicles` as a parallel
-- table would fork custody, QR, inspections, maintenance and history — five
-- proven engines — and create a second answer to "where is the Transit". So
-- this table is a 1:1 extension keyed on asset_id, exactly as CIS M1
-- (20261046000000) extends `suppliers` keyed (org_id, supplier_id).
--
-- WHAT IS DELIBERATELY *NOT* HERE (no duplicate sources of truth):
--   registration, make, model, purchase date/price, notes, documents → `assets`
--   who is driving it, since when, due back when                     → `asset_assignments`
--   MOT / insurance / road tax / service due dates                   → `asset_service_schedules` (20261057)
--   the work itself, garage, cost, evidence                          → `asset_maintenance_cases` + costs satellite
--   disposal (sold / written off / retired / stolen)                 → `assets.status`
--
-- `operational_status` here is NOT a copy of `assets.status`. 20261002000000's
-- header already names the distinction: lifecycle status (assets), custody
-- (assignments) and OPERATIONAL AVAILABILITY are three separate concerns. This
-- column owns the third for vehicles only — in service / off road (SORN, laid
-- up) / in the workshop. A disposed asset can never be 'in_service'; the guard
-- below enforces that so the two columns cannot contradict each other.
--
-- Additive, idempotent, reversible. To roll back:
--   drop trigger if exists fleet_vehicles_guard on public.fleet_vehicles;
--   drop function if exists public.tg_fleet_vehicles_guard();
--   drop table if exists public.fleet_vehicles;
--   alter table public.assets drop constraint if exists assets_id_org_key;
-- (Dropping assets_id_org_key is safe only once no other table references it.)

-- ── composite-FK target on assets ────────────────────────────────────────────
-- `assets` has PK (id) and no (id, org_id) candidate key, so a cross-tenant-safe
-- composite FK is not yet expressible. Add it — the CIS M1 precedent, and for
-- the same reason: a DECLARATIVE composite FK is enforced for EVERY role
-- including service_role, needs no procedural code, and cannot be bypassed by a
-- direct PostgREST write. A forged asset_id from another tenant simply has no
-- matching (id, org_id) row, so `fleet_vehicles` can never point at an asset
-- belonging to a different organisation — regardless of what the app sends.
--
-- Cascade semantics are exactly what we want here (unlike 20261024000000's
-- SET NULL links, where a composite FK would have wrongly deleted whole rows):
-- this is a 1:1 EXTENSION, so no asset ⇒ no vehicle profile for it.
--
-- Lock note: builds a small unique index under a brief ACCESS EXCLUSIVE lock.
-- `assets` is a per-tenant register (tens-to-hundreds of rows for a 5-50-person
-- builder), so the lock is negligible. Wrapped so re-runs are no-ops.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'assets_id_org_key'
  ) then
    alter table public.assets add constraint assets_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── fleet_vehicles ───────────────────────────────────────────────────────────
create table if not exists public.fleet_vehicles (
  -- 1:1 with the asset. PK on asset_id IS the "one vehicle profile per asset"
  -- invariant — no partial-unique gymnastics needed.
  asset_id            uuid primary key,
  org_id              uuid not null references public.organizations(id) on delete cascade,

  -- ── identity the V5C carries and `assets` does not ────────────────────────
  -- VIN / chassis number. Real VINs exclude I, O and Q to avoid 1/0 confusion.
  -- 17 chars since 1981; older and imported plant run shorter, so the CHECK is a
  -- sanity bound (11-17) rather than a strict modern-VIN pin — an over-tight
  -- CHECK on an externally-issued identifier is a support trap needing a
  -- migration to relax (the CIS verification_reference lesson).
  vin                 text check (vin is null or vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  -- Trim / body variant, e.g. "350 L3 H3 Leader" — `assets.model` holds "Transit".
  variant             text check (variant is null or length(trim(variant)) between 1 and 120),
  year_of_manufacture integer check (year_of_manufacture is null
                                     or year_of_manufacture between 1900 and 2100),
  -- The V5C first-registration date: what MOT eligibility and age actually key on.
  first_registered_on date,
  fuel_type           text check (fuel_type is null or fuel_type in
                        ('diesel','petrol','electric','hybrid','plug_in_hybrid',
                         'hydrogen','lpg','other')),
  -- UK construction language throughout: tipper, luton, HGV rigid/artic, plant
  -- transporter. Not "truck", not "license plate".
  vehicle_class       text check (vehicle_class is null or vehicle_class in
                        ('car','van','pickup','tipper','luton','flatbed','minibus',
                         'hgv_rigid','hgv_artic','plant_transporter','trailer','other')),
  -- Gross vehicle weight (MAM) in kg — what decides HGV class, O-licence scope
  -- and whether a driver's category B entitlement covers it.
  gross_weight_kg     integer check (gross_weight_kg is null
                                     or gross_weight_kg between 1 and 100000),
  -- MOT exemption: vehicles under 3 years old, and historic vehicles over 40.
  -- Recorded, not inferred — the operator owns this judgement.
  mot_exempt          boolean not null default false,

  -- ── operational availability (see header — NOT assets.status) ─────────────
  operational_status  text not null default 'in_service'
    check (operational_status in ('in_service','off_road','in_workshop')),

  -- ── finance structure ─────────────────────────────────────────────────────
  -- ORTHOGONAL to `assets.ownership` (owned|hired), not a duplicate of it: a
  -- hire-purchase van is `owned` on the asset and `hire_purchase` here; a
  -- contract-hire van is `hired` there and `contract_hire` here. This column
  -- answers "what agreement is behind it", never "do we own it".
  finance_type        text not null default 'none'
    check (finance_type in ('none','hire_purchase','lease','contract_hire','daily_rental')),
  finance_provider_id uuid references public.suppliers(id) on delete set null,
  finance_agreement_ref text check (finance_agreement_ref is null
                                    or length(trim(finance_agreement_ref)) between 1 and 120),
  finance_monthly_payment numeric(12,2) check (finance_monthly_payment is null
                                               or finance_monthly_payment >= 0),
  finance_end_date    date,

  -- ── operations ────────────────────────────────────────────────────────────
  -- Free text: this schema has no depots/locations table (verified by catalogue
  -- query, not by grep), and `asset_assignments.location` sets the precedent for
  -- a depot/yard name as text. Introducing a depots entity is its own milestone.
  home_depot          text check (home_depot is null or length(trim(home_depot)) between 1 and 160),

  -- Current odometer in MILES (UK). A plain column, never a generated one: it is
  -- the latest KNOWN reading, advanced by the fuel-log trigger (20261058) when a
  -- newer higher reading arrives, and directly correctable by a user when a
  -- clock is replaced or a typo is found. Deliberately NOT enforced monotonic at
  -- the DB — replacement instrument clusters legitimately read lower, and a
  -- hard non-decrease CHECK would trap that vehicle forever with no escape but a
  -- migration. Bounds sanity is enforced; direction is a judgement.
  odometer_miles      integer check (odometer_miles is null
                                     or odometer_miles between 0 and 3000000),
  odometer_recorded_at timestamp with time zone,

  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamp with time zone not null default now(),
  updated_at          timestamp with time zone not null default now(),

  -- THE cross-tenant control (see header).
  constraint fleet_vehicles_asset_org_fk
    foreign key (asset_id, org_id) references public.assets (id, org_id)
    on update cascade on delete cascade,

  -- A reading timestamp without a reading is meaningless.
  constraint fleet_vehicles_odometer_pair_check
    check (odometer_recorded_at is null or odometer_miles is not null),

  -- Agreement detail belongs to an agreement. With finance_type 'none' there is
  -- nothing for a provider, reference, payment or end date to describe.
  constraint fleet_vehicles_finance_coherence_check
    check (finance_type <> 'none'
           or (finance_provider_id is null and finance_agreement_ref is null
               and finance_monthly_payment is null and finance_end_date is null))
);

-- ── indexes: org_id + the hot filters ────────────────────────────────────────
-- The register's default board (org's vehicles by availability).
create index if not exists fleet_vehicles_org_status_idx
  on public.fleet_vehicles (org_id, operational_status);
-- Paging with a unique total order (org_id, created_at desc, asset_id desc).
create index if not exists fleet_vehicles_org_created_idx
  on public.fleet_vehicles (org_id, created_at desc, asset_id desc);
-- VIN lookup (the identifier an insurer or the police quote back at you).
create index if not exists fleet_vehicles_vin_idx
  on public.fleet_vehicles (org_id, vin) where vin is not null;
-- Finance agreements running out (a lease end is a procurement deadline).
create index if not exists fleet_vehicles_finance_end_idx
  on public.fleet_vehicles (org_id, finance_end_date) where finance_end_date is not null;

-- ── guard: same-org references + the availability invariant ──────────────────
-- The composite FK already proves the asset is same-org, so this guard does NOT
-- re-check it. It covers what the FK cannot: the supplier reference, and the
-- contradiction between a disposed asset and an in-service vehicle.
create or replace function public.tg_fleet_vehicles_guard()
returns trigger language plpgsql as $$
declare
  a_status text;
begin
  if new.finance_provider_id is not null
     and not exists (select 1 from public.suppliers
                     where id = new.finance_provider_id and org_id = new.org_id) then
    raise exception 'supplier % is not in org %', new.finance_provider_id, new.org_id
      using errcode = 'check_violation';
  end if;

  -- A sold / written-off / stolen / retired / lost asset is not in service.
  -- Mirrors the custody guard's eligibility arm (20260925000000): the asset
  -- lifecycle is the authority, and this extension must never contradict it.
  --
  -- Checked ON THE TRANSITION ONLY (insert, or an update that actually moves the
  -- vehicle INTO service) — the 20261002000000 G2 idiom. Validating it on every
  -- update would be a trap: `assets.status` can move to 'sold' independently, and
  -- a blanket re-check would then freeze the vehicle row forever, so an operator
  -- could no longer even correct its odometer or mark it off road. This form
  -- still makes the illegal state unreachable going in, while leaving every row
  -- editable — including editable back to a legal state.
  if new.operational_status = 'in_service'
     and (tg_op = 'INSERT' or old.operational_status is distinct from 'in_service') then
    select status into a_status from public.assets where id = new.asset_id;
    if a_status is distinct from 'active' then
      raise exception 'asset % is % and cannot be in service', new.asset_id, a_status
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists fleet_vehicles_guard on public.fleet_vehicles;
create trigger fleet_vehicles_guard before insert or update on public.fleet_vehicles
  for each row execute function public.tg_fleet_vehicles_guard();

drop trigger if exists fleet_vehicles_set_updated_at on public.fleet_vehicles;
create trigger fleet_vehicles_set_updated_at before update on public.fleet_vehicles
  for each row execute function public.tg_set_updated_at();

-- ── RLS: mirrors `assets` exactly ────────────────────────────────────────────
-- Member read + member write, admin-only hard delete. A vehicle profile carries
-- finance and identity history and is audit-worthy, so members retire it via
-- the asset's status; owners/admins delete (the assets_delete posture).
alter table public.fleet_vehicles enable row level security;

create policy fleet_vehicles_select on public.fleet_vehicles
  for select using (org_id in (select public.current_org_ids()));
create policy fleet_vehicles_insert on public.fleet_vehicles
  for insert with check (org_id in (select public.current_org_ids()));
create policy fleet_vehicles_update on public.fleet_vehicles
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy fleet_vehicles_delete on public.fleet_vehicles
  for delete using (public.is_org_admin(org_id));

-- ── atomic save: the asset row and its extension, in ONE transaction ─────────
-- Creating a vehicle writes TWO rows. Two separate PostgREST calls are not
-- atomic: if the second fails (a bad VIN, a cross-org supplier, a guard) the
-- first has already committed, leaving an asset that appears in /assets but
-- never in /fleet — an invisible half-vehicle no screen can repair. A function
-- body IS a transaction, so this either writes both rows or neither.
--
-- SECURITY INVOKER (the default, and the transfer_asset_assignment precedent):
-- the caller's RLS, the composite FK, both guard triggers and every CHECK still
-- apply. This function grants NO authority the caller did not already have —
-- it only makes the caller's own two writes atomic.
--
-- The org predicate on the UPDATE arm is the active-org pin: RLS would happily
-- allow a multi-org user to edit their OTHER org's vehicle by id, so the
-- `and org_id = p_org_id` is what makes a foreign id a not-found instead of an
-- edit. It is load-bearing, not defensive decoration.
create or replace function public.save_fleet_vehicle(
  p_asset_id                uuid,
  p_org_id                  uuid,
  p_name                    text,
  p_registration            text,
  p_manufacturer            text,
  p_model                   text,
  p_ownership               text,
  p_supplier_id             uuid,
  p_purchase_date           date,
  p_purchase_price          numeric,
  p_notes                   text,
  p_vin                     text,
  p_variant                 text,
  p_year_of_manufacture     integer,
  p_first_registered_on     date,
  p_fuel_type               text,
  p_vehicle_class           text,
  p_gross_weight_kg         integer,
  p_mot_exempt              boolean,
  p_operational_status      text,
  p_finance_type            text,
  p_finance_provider_id     uuid,
  p_finance_agreement_ref   text,
  p_finance_monthly_payment numeric,
  p_finance_end_date        date,
  p_home_depot              text,
  p_odometer_miles          integer,
  p_created_by              uuid
) returns uuid
language plpgsql
as $$
declare
  v_asset_id uuid;
  v_hit      integer;
  v_prev_odo integer;
begin
  if p_asset_id is null then
    -- CREATE. `category` is seeded to 'Vehicle' so the asset register reads
    -- sensibly for a record created from Fleet; it stays free text and the user
    -- can change it from /assets afterwards. Lifecycle `status` is left to the
    -- assets default ('active') — Fleet never sets disposal.
    insert into public.assets (
      org_id, name, category, registration, manufacturer, model,
      ownership, supplier_id, purchase_date, purchase_price, notes, created_by
    ) values (
      p_org_id, p_name, 'Vehicle', p_registration, p_manufacturer, p_model,
      coalesce(p_ownership, 'owned'), p_supplier_id, p_purchase_date,
      p_purchase_price, p_notes, p_created_by
    ) returning id into v_asset_id;

    insert into public.fleet_vehicles (
      asset_id, org_id, vin, variant, year_of_manufacture, first_registered_on,
      fuel_type, vehicle_class, gross_weight_kg, mot_exempt, operational_status,
      finance_type, finance_provider_id, finance_agreement_ref,
      finance_monthly_payment, finance_end_date, home_depot,
      odometer_miles, odometer_recorded_at, created_by
    ) values (
      v_asset_id, p_org_id, p_vin, p_variant, p_year_of_manufacture,
      p_first_registered_on, p_fuel_type, p_vehicle_class, p_gross_weight_kg,
      coalesce(p_mot_exempt, false), coalesce(p_operational_status, 'in_service'),
      coalesce(p_finance_type, 'none'), p_finance_provider_id,
      p_finance_agreement_ref, p_finance_monthly_payment, p_finance_end_date,
      p_home_depot, p_odometer_miles,
      case when p_odometer_miles is null then null else now() end, p_created_by
    );

    return v_asset_id;
  end if;

  -- UPDATE. Org-pinned on BOTH rows (see header).
  update public.assets set
    name           = p_name,
    registration   = p_registration,
    manufacturer   = p_manufacturer,
    model          = p_model,
    ownership      = coalesce(p_ownership, ownership),
    supplier_id    = p_supplier_id,
    purchase_date  = p_purchase_date,
    purchase_price = p_purchase_price,
    notes          = p_notes
  where id = p_asset_id and org_id = p_org_id;
  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    raise exception 'vehicle % not found in org %', p_asset_id, p_org_id
      using errcode = 'no_data_found';
  end if;

  select odometer_miles into v_prev_odo
    from public.fleet_vehicles
   where asset_id = p_asset_id and org_id = p_org_id;

  update public.fleet_vehicles set
    vin                     = p_vin,
    variant                 = p_variant,
    year_of_manufacture     = p_year_of_manufacture,
    first_registered_on     = p_first_registered_on,
    fuel_type               = p_fuel_type,
    vehicle_class           = p_vehicle_class,
    gross_weight_kg         = p_gross_weight_kg,
    mot_exempt              = coalesce(p_mot_exempt, false),
    operational_status      = coalesce(p_operational_status, operational_status),
    finance_type            = coalesce(p_finance_type, 'none'),
    finance_provider_id     = p_finance_provider_id,
    finance_agreement_ref   = p_finance_agreement_ref,
    finance_monthly_payment = p_finance_monthly_payment,
    finance_end_date        = p_finance_end_date,
    home_depot              = p_home_depot,
    odometer_miles          = p_odometer_miles,
    -- Only re-stamp the reading time when the reading actually changed, so an
    -- unrelated edit (a new depot) does not make a stale mileage look fresh.
    odometer_recorded_at    = case
                                when p_odometer_miles is null then null
                                when p_odometer_miles is distinct from v_prev_odo then now()
                                else odometer_recorded_at
                              end
  where asset_id = p_asset_id and org_id = p_org_id;
  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    raise exception 'vehicle profile % not found in org %', p_asset_id, p_org_id
      using errcode = 'no_data_found';
  end if;

  return p_asset_id;
end $$;
