-- VAN / VEHICLE STOCK — a fleet vehicle modelled as a stock LOCATION.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — UNCHANGED, RESTATED HERE BECAUSE THIS IS A    ║
-- ║  FILE SOMEBODY WILL BE TEMPTED TO EXTEND WITH A VALUATION.               ║
-- ║                                                                          ║
-- ║  Van stock is a QUANTITY MOVING BETWEEN PLACES and nothing else. This    ║
-- ║  migration adds no money column, no unit cost, no VAT and no valuation;  ║
-- ║  it writes nothing to `public.finances`, puts no trigger on it, and      ║
-- ║  names it nowhere in an executable statement. Loading 10 boards onto a   ║
-- ║  van is a TRANSFER depot → van — the same conserving pair as any other   ║
-- ║  transfer — and posts NO new cost, because materials are ALREADY         ║
-- ║  expensed by recordSupplierBill (20261009000000). A second posting would ║
-- ║  double-count the same spend. Stock valuation / COGS-on-issue is CEO     ║
-- ║  decision D1 and remains UNDECIDED — this is an operational quantity     ║
-- ║  location only. Asserted on source by __tests__/security/van-stock.test. ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── WHY A VEHICLE IS A `sites` ROW, NOT A NEW TABLE ─────────────────────────
-- 20261064000000's header recorded van stock as deferred debt and named the
-- honest way in, verbatim: "a `sites` kind or a first-class 'mobile location',
-- decided with the fleet lane, not a vehicle_id column smuggled into
-- [stock_movements]." This migration takes exactly that route.
--
-- `stock_movements.site_id` is a COMPOSITE FK to `sites (id, org_id)`
-- (20261064000000). So the instant a van IS a `sites` row, the ENTIRE existing
-- ledger accepts it with ZERO changes to the write path:
--
--   · record_stock_transfer(depot → van)  loads a van   ┐ the SAME authority:
--   · record_stock_transfer(van → depot)  returns stock ┘ the per-(item, site)
--   · record_stock_issue(site = van, job) consumes off a van   advisory lock,
--   · stock_balance() / stock_balances    already fold it        the balance
--                                                                floor, the
--   crewflow.stock_write write-path gate (20261071000000 §2), the append-only
--   ledger and every composite FK — all inherited, none re-implemented. This
--   file therefore defines NO new movement function, takes NO advisory lock and
--   performs NO `insert into stock_movements`: issuing to a van is a transfer,
--   and a bare `transfer_in` that manufactures stock stays refused exactly as it
--   is for every other location.
--
-- ── WHY `sites` AND NOT `asset_assignments` ─────────────────────────────────
-- `asset_assignments` models CUSTODY of a SERIALISED asset (one drill, held by
-- one van, one open assignment) — an identity model. Stock is a FUNGIBLE
-- quantity model: 400 blocks are not 400 identities. The two answer different
-- questions and stay apart (20261064000000's header). A van as a `sites` row is
-- a PLACE that holds fungible balances, which is precisely what stock needs.
--
-- ── THE LINK: `sites.vehicle_asset_id`, plain FK + guard (the home_site_id idiom)
-- A vehicle stock location points back at the fleet vehicle it travels with.
-- The link is ON DELETE SET NULL, NOT a composite (id, org_id) FK, for the exact
-- reason `fleet_vehicles.home_site_id` is (20261061000000): a composite FK to a
-- NOT NULL org_id forces ON DELETE CASCADE, and deleting a vehicle would then
-- DELETE its stock location — taking its movement history with it, or (because
-- stock_movements' deferred FK refuses to lose a site with history) failing the
-- vehicle delete outright. Losing a vehicle must lose the LINK, never the
-- ledger. So the declarative composite is impossible here and a SECURITY DEFINER
-- BEFORE trigger enforces "the vehicle you point at is in your org", for every
-- role including service_role — the tg_site_reference_org_integrity posture.
--
-- A vehicle stock location that outlives its vehicle keeps its name, its history
-- and its balance; its `vehicle_asset_id` simply becomes null. The CHECK below
-- allows that (link only ON a vehicle site, never REQUIRED forever), so a
-- retired van's stock record is never rewritten.
--
-- ── ROLES ───────────────────────────────────────────────────────────────────
-- ENABLING a van as a stock location is CURATION of reference data — the same
-- act as adding a depot — so it inherits the `sites` reference-data posture:
-- admin-only INSERT (sites_insert, 20261061000000). ensure_vehicle_stock_location
-- is SECURITY INVOKER, so that admin gate applies through it and it is not a
-- back door. MOVING stock to/from a van is an ordinary member action (a
-- transfer), unchanged.
--
-- Additive, idempotent, reversible. To roll back:
--   drop function if exists public.ensure_vehicle_stock_location(uuid, uuid, text);
--   drop trigger if exists sites_vehicle_org on public.sites;
--   drop function if exists public.tg_sites_vehicle_org_integrity();
--   drop index if exists public.sites_org_vehicle_idx;
--   drop index if exists public.sites_vehicle_asset_uniq;
--   alter table public.sites drop constraint if exists sites_vehicle_link_check;
--   alter table public.sites drop column if exists vehicle_asset_id;
--   alter table public.sites drop constraint if exists sites_kind_check;
--   alter table public.sites add constraint sites_kind_check
--     check (kind in ('depot','yard','warehouse','office','storage_container','lock_up'));

-- ── 1. Allow 'vehicle' as a site kind (additive to the existing CHECK) ──────
-- The original CHECK is inline-anonymous on `kind`; Postgres named it
-- `sites_kind_check`. Drop and re-add as a named constraint that adds one member
-- and removes none — no existing row can be rejected. 'job_site' stays excluded
-- (20261061000000's header), and this new member is NOT added to the /sites
-- create form's vocabulary (lib/sites/schema.ts SITE_KINDS): a vehicle location
-- is only ever created THROUGH its vehicle, by ensure_vehicle_stock_location,
-- never typed in free-hand.
alter table public.sites drop constraint if exists sites_kind_check;
alter table public.sites
  add constraint sites_kind_check
  check (kind in ('depot','yard','warehouse','office',
                  'storage_container','lock_up','vehicle'));

-- ── 2. The link back to the fleet vehicle ───────────────────────────────────
-- Plain FK + SET NULL (see the header for why a composite FK is impossible
-- here). The org-integrity guard in §4 is what makes it cross-tenant-safe.
alter table public.sites
  add column if not exists vehicle_asset_id uuid
    references public.fleet_vehicles(asset_id) on delete set null;

-- The link may only sit on a vehicle-kind site. It is NOT required forever: a
-- vehicle site whose van has been deleted keeps its history with a null link.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_vehicle_link_check') then
    alter table public.sites
      add constraint sites_vehicle_link_check
      check (vehicle_asset_id is null or kind = 'vehicle');
  end if;
end $$;

-- ONE stock location per vehicle. Without this, two "enable" taps in a yard on
-- one bar of signal would create two van locations for the same Transit and
-- split its balance across both. Partial, because the overwhelming majority of
-- sites are depots with no vehicle link.
create unique index if not exists sites_vehicle_asset_uniq
  on public.sites (vehicle_asset_id) where vehicle_asset_id is not null;

-- "Which vehicles already have a stock location" — the enable picker's diff, and
-- the vans board. org_id leads so it also serves the bare org_id RLS predicate.
create index if not exists sites_org_vehicle_idx
  on public.sites (org_id, vehicle_asset_id) where vehicle_asset_id is not null;

-- ── 3. Cross-tenant control for the vehicle link ────────────────────────────
-- RLS only ever checks the ROW's own org_id; it says nothing about the org of
-- the vehicle the row POINTS AT. Without this a writer in org A could bind their
-- van location to org B's vehicle. Mirrors tg_site_reference_org_integrity
-- (20261061000000) and tg_purchase_order_org_integrity: SECURITY DEFINER +
-- pinned search_path so the check reads the TRUE owning org of the referenced
-- vehicle, not the subset the caller's RLS exposes. It returns no data and its
-- message repeats only the id the caller itself supplied and the caller's own
-- org. A pure validator (never modifies NEW), so firing order vs the existing
-- sites triggers is irrelevant.
create or replace function public.tg_sites_vehicle_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.vehicle_asset_id is null then
    return new;
  end if;
  select org_id into v_org from public.fleet_vehicles where asset_id = new.vehicle_asset_id;
  if v_org is null or v_org <> new.org_id then
    raise exception 'vehicle % is not in org %', new.vehicle_asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists sites_vehicle_org on public.sites;
create trigger sites_vehicle_org
  before insert or update on public.sites
  for each row execute function public.tg_sites_vehicle_org_integrity();

-- ── 4. Enable a vehicle as a stock location (IDEMPOTENT, admin-curated) ──────
-- SECURITY INVOKER (the ensure/save-RPC precedent, and stated by its absence):
-- the caller's RLS still applies, so `sites_insert`'s is_org_admin gate governs
-- who may enable a van, the org-integrity guard above still fires, and the CHECK
-- and unique index all hold. This is NOT a privileged back door — it only makes
-- the "is it already enabled?" read and the insert one atomic, idempotent act.
--
-- It inserts ONLY a `sites` row. It writes NO stock_movements, takes NO advisory
-- lock and posts NO cost: the movement authority (transfer / issue) is reused
-- untouched once the location exists.
--
-- ACTIVE-ORG PIN: the vehicle must belong to p_org_id (the company being worked
-- in), not merely to some org the caller is a member of.
create or replace function public.ensure_vehicle_stock_location(
  p_org_id           uuid,
  p_vehicle_asset_id uuid,
  p_name             text default null
) returns uuid
language plpgsql
as $$
declare
  v_site uuid;
  v_name text;
begin
  if p_org_id is null or p_vehicle_asset_id is null then
    raise exception 'organisation and vehicle are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The vehicle must be in the ACTIVE org. RLS admits every org the caller
  -- belongs to; p_org_id narrows that to the one company they are working in, so
  -- a dual-org member cannot enable another company's van from this company.
  if not exists (
    select 1 from public.fleet_vehicles
     where asset_id = p_vehicle_asset_id and org_id = p_org_id
  ) then
    raise exception 'vehicle not found' using errcode = 'no_data_found';
  end if;

  -- IDEMPOTENT: the van already has a stock location → return it, for members
  -- and admins alike (the read carries no admin requirement; only the insert
  -- below does, via RLS).
  select id into v_site from public.sites
   where org_id = p_org_id and vehicle_asset_id = p_vehicle_asset_id;
  if v_site is not null then
    return v_site;
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    select coalesce(nullif(btrim(a.name), ''), 'Vehicle') into v_name
      from public.assets a where a.id = p_vehicle_asset_id and a.org_id = p_org_id;
  end if;

  insert into public.sites (org_id, name, kind, vehicle_asset_id, active)
  values (p_org_id, v_name, 'vehicle', p_vehicle_asset_id, true)
  returning id into v_site;

  return v_site;
exception
  when unique_violation then
    -- Either a racing sibling created the van's location (return it), or the
    -- chosen name collides with an existing site (re-raise so the caller sees
    -- the clash and can supply a different label).
    select id into v_site from public.sites
     where org_id = p_org_id and vehicle_asset_id = p_vehicle_asset_id;
    if v_site is null then raise; end if;
    return v_site;
end $$;
grant execute on function public.ensure_vehicle_stock_location(uuid, uuid, text) to authenticated;

comment on column public.sites.vehicle_asset_id is
  'When set, this site IS a fleet vehicle used as a stock location (kind = ''vehicle''). Plain FK + tg_sites_vehicle_org_integrity guard, ON DELETE SET NULL — losing a vehicle must lose the link, never the van''s stock history (20261102000000).';
comment on function public.ensure_vehicle_stock_location(uuid, uuid, text) is
  'Idempotently make a fleet vehicle a stock LOCATION (a sites row, kind = ''vehicle''). SECURITY INVOKER, so the admin-only sites_insert gate applies. Writes NO stock_movements and posts NO cost: loading/returning van stock reuses record_stock_transfer, so the advisory lock, balance floor and write-path gate are all inherited (20261102000000). Stock valuation is CEO decision D1, undecided.';
