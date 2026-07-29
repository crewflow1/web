-- Sites — the company's own physical locations, as ONE reusable entity.
--
-- WHY NOW (three domains are already paying for its absence, verified in the
-- migration text rather than asserted):
--   1. `fleet_vehicles.home_depot` (20261056000000, the "operations" block)
--      is free text, and its own comment says so: "this schema has no
--      depots/locations table … Introducing a depots entity is its own
--      milestone." This IS that milestone.
--   2. `asset_assignments.location` (20260925000000) is the precedent that
--      comment cites — "a depot/yard name or a justified free-text location".
--      Custody's `stored_at_depot` type therefore names a place that nothing
--      can join to, count, or rename.
--   3. The stock/warehouse work queued behind this needs a place to hold
--      stock at. Building a third free-text location column would make the
--      same mistake a third time.
--
-- Two free-text columns already disagree about the same yard the moment
-- someone types "Wakefield Yard" in one and "wakefield yard" in the other.
-- This table is the authority; both columns keep working (see the ADDITIVE
-- section) and neither is migrated by this file.
--
-- ── WHAT A SITE IS NOT: a customer job site (the `job_site` exclusion) ───────
-- `kind` deliberately EXCLUDES 'job_site', and this file deliberately does NOT
-- touch `jobs.site_address_*` (20260601000000). The two are different things
-- that happen to share the word "site":
--
--   OWNERSHIP    A depot is YOURS. A job site belongs to the CUSTOMER, and
--                `jobs.site_address_*` exists precisely as an OVERRIDE of the
--                customer's own address (20260601's header: "when null, the job
--                inherits the customer's address"). Lifting job addresses into
--                a company-owned register would sever that inheritance.
--   LIFECYCLE    A depot outlives every job run from it and is edited a
--                handful of times in a company's life. A job site exists for
--                the duration of one job and is never reused verbatim.
--   CARDINALITY  A builder has a handful of depots referenced by thousands of
--                rows. They have one job address per job, referenced once. A
--                register that absorbed job sites would grow without bound and
--                its uniqueness rule below (one name per org) would be wrong —
--                two customers on the same street are not a duplicate.
--   AUTHORITY    Sites are reference data: admins curate, members consume (the
--                RLS block below). A job's site address is part of the job and
--                is edited by whoever is running the job.
--
-- So this file adds no 'job_site' kind and migrates no job address. Whether
-- CrewFlow should eventually have ONE address book spanning both is a PRODUCT
-- decision about how customers think, not a schema convenience — and it is
-- reversible in that direction (add a kind, backfill) but not in this one.
--
-- ── ADDITIVE: typed FKs ALONGSIDE the free text, both kept ───────────────────
-- `fleet_vehicles.home_site_id` and `asset_assignments.site_id` are new,
-- nullable, and sit BESIDE `home_depot` / `location`. Nothing is dropped,
-- nothing is backfilled, nothing that works today stops working. Backfilling
-- (matching free text to a site by name) is a separate, reversible choice a
-- human can make per-org later.
--
-- Both FKs are ON DELETE SET NULL with a TRIGGER guard rather than a composite
-- FK to (id, org_id) — the 20261011000000 reasoning, verbatim in its shape:
-- a composite FK to a NOT NULL org_id forces ON DELETE CASCADE, which would
-- mean deleting a depot DELETED the vans that lived there. Losing a depot must
-- lose the LINK, never the vehicle or the custody record. So the declarative
-- control is impossible here, and a BEFORE INSERT/UPDATE guard is what enforces
-- "the site you point at is in your org" — for every role, service_role
-- included, exactly as tg_purchase_order_org_integrity does for POs.
--
-- Additive, idempotent, reversible. To roll back:
--   drop trigger if exists asset_assignments_site_org on public.asset_assignments;
--   drop trigger if exists fleet_vehicles_site_org on public.fleet_vehicles;
--   drop function if exists public.tg_site_reference_org_integrity();
--   drop trigger if exists sites_delete_guard on public.sites;
--   drop function if exists public.tg_sites_delete_guard();
--   alter table public.asset_assignments drop column if exists site_id;
--   alter table public.fleet_vehicles drop column if exists home_site_id;
--   drop table if exists public.sites;
--   -- and re-create the pre-20261061 save_fleet_vehicle /
--   -- transfer_asset_assignment signatures from 20261056 / 20260925.

-- ── sites ────────────────────────────────────────────────────────────────────
create table if not exists public.sites (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  -- The name a foreman actually says on the phone: "Wakefield yard".
  -- Bounded at 160 to match `fleet_vehicles.home_depot`'s CHECK exactly, so a
  -- later free-text → site backfill can never overflow this column.
  name          text not null
                check (length(trim(name)) between 1 and 160),

  -- UK construction language, and the deliberate absence of 'job_site' (header).
  -- A lock-up and a storage container are distinct from a yard to the people
  -- who keep kit in them, so they are distinct here.
  kind          text not null
                check (kind in ('depot','yard','warehouse','office',
                                'storage_container','lock_up')),

  -- Address, in the SHAPE 20260601000000 already established for customers —
  -- line1 / line2 / city / county / postcode / country, with country defaulted.
  -- `city` rather than `town` even though "town" is the commoner UK word: two
  -- tables already spell this column `city` (customers) / `site_city` (jobs),
  -- and a third spelling would fork every address formatter in the app.
  -- Postcode carries a LENGTH bound and no regex — the registration/VIN lesson
  -- from 20261056: an over-tight CHECK on an externally-issued identifier is a
  -- support trap that needs a migration to relax.
  address_line1 text check (address_line1 is null or length(trim(address_line1)) <= 200),
  address_line2 text check (address_line2 is null or length(trim(address_line2)) <= 200),
  city          text check (city is null or length(trim(city)) <= 120),
  county        text check (county is null or length(trim(county)) <= 120),
  postcode      text check (postcode is null or length(trim(postcode)) <= 16),
  country       text not null default 'United Kingdom',

  -- DEACTIVATE, NEVER DELETE, once referenced. A closed depot is still the
  -- truthful answer to "where was that van kept in 2026", so retiring it must
  -- not rewrite history. `active` is what the pickers filter on; the delete
  -- guard below makes the rule structural rather than a UI convention.
  active        boolean not null default true,

  notes         text check (notes is null or length(notes) <= 2000),

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

-- One name per org, CASE-INSENSITIVELY — the suppliers precedent
-- (20260623000000: `suppliers_org_name_unique on (org_id, lower(name))`), and
-- for the same reason: "Wakefield Yard" and "wakefield yard" are one place, and
-- a picker that offers both has already lost. Scoped to org_id, so two tenants
-- may each have a "Main yard".
create unique index if not exists sites_org_name_unique
  on public.sites (org_id, lower(name));

-- The register's default board and every picker read: this org's sites, active
-- first. org_id leads, so it also serves the bare org_id predicate RLS applies.
create index if not exists sites_org_active_idx
  on public.sites (org_id, active);

drop trigger if exists sites_set_updated_at on public.sites;
create trigger sites_set_updated_at before update on public.sites
  for each row execute function public.tg_set_updated_at();

-- ── RLS: members read, admins write ──────────────────────────────────────────
-- The REFERENCE-DATA posture, taken from asset_inspection_schedules
-- (20260930000000) and asset_service_schedules (20261003000000), which state it
-- as "standing rules … admin-only writes; every member can see what's due".
-- A site is the same shape of thing: every member needs to SEE the depot list
-- to pick one when they store a tool or set a van's base, but renaming or
-- retiring a depot re-labels every record that points at it across the whole
-- company — that is a curation act, not a day's work.
--
-- Deliberately NOT the `suppliers` posture (member write). Suppliers are added
-- constantly, mid-job, by whoever is buying; depots are established once and
-- then referenced for years.
alter table public.sites enable row level security;

create policy sites_select on public.sites
  for select using (org_id in (select public.current_org_ids()));
create policy sites_insert on public.sites
  for insert with check (public.is_org_admin(org_id));
create policy sites_update on public.sites
  for update using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
create policy sites_delete on public.sites
  for delete using (public.is_org_admin(org_id));

-- ── the typed links, added BESIDE the free text ──────────────────────────────
alter table public.fleet_vehicles
  add column if not exists home_site_id uuid references public.sites(id) on delete set null;

alter table public.asset_assignments
  add column if not exists site_id uuid references public.sites(id) on delete set null;

-- Both indexes are what the delete guard below reads, as well as the obvious
-- "what lives at this depot" question. Partial: the overwhelming majority of
-- rows carry no site while the free-text columns are still in use.
create index if not exists fleet_vehicles_home_site_idx
  on public.fleet_vehicles (home_site_id) where home_site_id is not null;
create index if not exists asset_assignments_site_idx
  on public.asset_assignments (site_id) where site_id is not null;

-- ── cross-tenant control for both links ──────────────────────────────────────
-- RLS only ever checks the ROW's own org_id; it says nothing about the org of
-- the thing the row POINTS AT. Without this, a writer in org A could bind their
-- van to org B's depot — the exact class 20261011000000 closed for purchase
-- orders, and 20260911 closed structurally for invoice_payments.
--
-- ONE function, TWO triggers, parameterised by the column name via TG_ARGV, so
-- the rule exists in a single place and the two tables cannot drift apart.
--
-- A SEPARATE trigger rather than an extension of the tables' existing guards
-- (tg_fleet_vehicles_guard / tg_asset_assignments_guard) on purpose. Extending
-- them means reproducing ~60 lines of safety-inspection and eligibility logic
-- this milestone has no business owning, and whichever migration replaces that
-- function LAST silently wins — so a concurrent milestone amending the custody
-- guard would erase this check without a single test noticing. A dedicated
-- org-integrity trigger is also exactly the shape 20261011000000 chose for this
-- same job. Both triggers are pure validators (they never modify NEW), so
-- firing order against the existing guards is irrelevant.
--
-- SECURITY DEFINER + pinned search_path, mirroring
-- tg_purchase_order_org_integrity: the check must read the TRUE owning org of
-- the referenced site, not the subset of `sites` the caller's RLS happens to
-- expose. The function leaks nothing — it returns no data, and its message
-- repeats only the site id the caller itself supplied and the caller's own org.
create or replace function public.tg_site_reference_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_site uuid;
  v_org  uuid;
begin
  v_site := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if v_site is null then
    return new;
  end if;
  select org_id into v_org from public.sites where id = v_site;
  if v_org is null or v_org <> new.org_id then
    raise exception 'site % is not in org %', v_site, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists fleet_vehicles_site_org on public.fleet_vehicles;
create trigger fleet_vehicles_site_org
  before insert or update on public.fleet_vehicles
  for each row execute function public.tg_site_reference_org_integrity('home_site_id');

drop trigger if exists asset_assignments_site_org on public.asset_assignments;
create trigger asset_assignments_site_org
  before insert or update on public.asset_assignments
  for each row execute function public.tg_site_reference_org_integrity('site_id');

-- ── "deactivate, never delete, once referenced", enforced ────────────────────
-- The ON DELETE SET NULL above is the SAFETY NET (it guarantees that losing a
-- site can never destroy a vehicle or a custody record). This guard is the
-- POLICY: while anything still points at a site, deleting it would silently
-- blank those links and lose the answer to "where was this kept", so the delete
-- is refused and the operator is told to deactivate instead. The two are not
-- redundant — a trigger can be disabled, an FK action cannot, so the graceful
-- outcome survives even if this guard is ever dropped.
--
-- TEARDOWN ESCAPE — the 20261052000000 idiom, and it is load-bearing, not
-- decoration. `delete from organizations` removes the org row and then cascades
-- into `sites`; at that moment fleet_vehicles / asset_assignments rows for the
-- same org may not yet have been cascaded away, so a naive guard would find
-- live references and ABORT the whole teardown. That is precisely the P1 that
-- 20261052000000 fixed for activity_log. The org check below converts the
-- cascade case into a no-op and changes nothing else: when the organisation is
-- gone, every referencing row is being deleted in the same statement anyway.
-- SECURITY DEFINER for the same reason 20261052000000 gives — the existence
-- check on public.organizations must not be filtered by the caller's RLS.
-- Regression cover: __tests__/integration/rls/sites-isolation.test.ts.
create or replace function public.tg_sites_delete_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_vehicles integer;
  v_custody  integer;
begin
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old;
  end if;

  select count(*) into v_vehicles from public.fleet_vehicles where home_site_id = old.id;
  select count(*) into v_custody  from public.asset_assignments where site_id = old.id;

  if v_vehicles > 0 or v_custody > 0 then
    raise exception
      'site % is still used by % vehicle(s) and % custody record(s) — deactivate it instead of deleting it',
      old.id, v_vehicles, v_custody
      using errcode = 'restrict_violation';
  end if;

  return old;
end $$;

drop trigger if exists sites_delete_guard on public.sites;
create trigger sites_delete_guard before delete on public.sites
  for each row execute function public.tg_sites_delete_guard();

-- ── save_fleet_vehicle: carry the typed site through the atomic save ─────────
-- The RPC writes the asset row and its extension in ONE transaction
-- (20261056000000's header). Adding a parameter changes the signature, and
-- `create or replace` would leave TWO overloads behind, so the old one is
-- dropped by its exact argument list first.
--
-- `p_home_site_id` is APPENDED, after p_created_by, with a DEFAULT — not
-- inserted next to p_home_depot where it reads better. PostgREST calls this by
-- NAMED arguments, so position is irrelevant to the app, and appending with a
-- default is what keeps every existing 28-argument caller (including
-- __tests__/integration/rls/fleet-isolation.test.ts) resolving to exactly one
-- function instead of failing to find one.
--
-- Everything else is reproduced verbatim from 20261056000000: the same
-- SECURITY INVOKER posture (no privilege is granted over the caller's own), the
-- same `and org_id = p_org_id` active-org pin on BOTH updates, and the same
-- odometer re-stamp rule. This remains a FULL-FORM save — every parameter is
-- authoritative, exactly as p_home_depot and p_vin already were.
drop function if exists public.save_fleet_vehicle(
  uuid, uuid, text, text, text, text, text, uuid, date, numeric, text,
  text, text, integer, date, text, text, integer, boolean, text,
  text, uuid, text, numeric, date, text, integer, uuid
);

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
  p_created_by              uuid,
  p_home_site_id            uuid default null
) returns uuid
language plpgsql
as $$
declare
  v_asset_id uuid;
  v_hit      integer;
  v_prev_odo integer;
begin
  if p_asset_id is null then
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
      finance_monthly_payment, finance_end_date, home_depot, home_site_id,
      odometer_miles, odometer_recorded_at, created_by
    ) values (
      v_asset_id, p_org_id, p_vin, p_variant, p_year_of_manufacture,
      p_first_registered_on, p_fuel_type, p_vehicle_class, p_gross_weight_kg,
      coalesce(p_mot_exempt, false), coalesce(p_operational_status, 'in_service'),
      coalesce(p_finance_type, 'none'), p_finance_provider_id,
      p_finance_agreement_ref, p_finance_monthly_payment, p_finance_end_date,
      p_home_depot, p_home_site_id, p_odometer_miles,
      case when p_odometer_miles is null then null else now() end, p_created_by
    );

    return v_asset_id;
  end if;

  -- UPDATE. Org-pinned on BOTH rows (see 20261056000000's header).
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
    home_site_id            = p_home_site_id,
    odometer_miles          = p_odometer_miles,
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

-- ── transfer_asset_assignment: carry the typed site through the atomic move ──
-- Same treatment, same reasons: dropped by exact signature so no overload is
-- left behind, `p_site_id` APPENDED with a default so the existing 11-argument
-- callers still resolve, and the body otherwise reproduced verbatim from
-- 20260925000000 — SECURITY INVOKER, so the caller's RLS, the custody guard,
-- the new site-org guard and the one-open-assignment partial unique index all
-- still apply and a failed open rolls the whole transfer back.
drop function if exists public.transfer_asset_assignment(
  uuid, uuid, text, uuid, uuid, uuid, text, text, text, date, uuid
);

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
  p_assigned_by        uuid,
  p_site_id            uuid default null
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
    location, site_id, issue_condition, issue_notes, expected_return_at,
    assigned_by, transferred_from_id, status
  ) values (
    p_org_id, p_asset_id, p_assignment_type, p_job_id, p_assignee_id,
    p_vehicle_asset_id, p_location, p_site_id, p_issue_condition, p_issue_notes,
    p_expected_return_at, p_assigned_by, v_old, 'open'
  ) returning id into v_new;

  return v_new;
end $$;

-- ── column comments: the free-text columns now say where the authority is ────
comment on column public.fleet_vehicles.home_depot is
  'Legacy free-text depot name. Kept and still written; `home_site_id` is the typed authority (20261061000000). Not backfilled.';
comment on column public.fleet_vehicles.home_site_id is
  'The company location this vehicle is based at (public.sites). ON DELETE SET NULL — losing a depot must never delete a van.';
comment on column public.asset_assignments.location is
  'Legacy free-text location. Kept and still written; `site_id` is the typed authority (20261061000000). Not backfilled.';
comment on column public.asset_assignments.site_id is
  'The company location this custody record points at (public.sites). ON DELETE SET NULL — losing a depot must never delete custody history.';
comment on table public.sites is
  'Company operational locations (depots, yards, warehouses, offices, containers, lock-ups). NOT customer job sites — those are jobs.site_address_* (20260601000000). See the 20261061000000 header.';
