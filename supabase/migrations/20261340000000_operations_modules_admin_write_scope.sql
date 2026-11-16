-- Operations modules (purchase orders, suppliers, stock, assets, fleet) and customer
-- properties: writes are owner/admin only at the data layer.
-- (least-privilege enforcement — register ST-10 / ST-11, UI finding S-3.)
--
-- THE HOLE
-- --------
-- The navigation hides Operations from `staff`, but hiding a menu item was the only
-- control: the pages were member-gated, the server actions had no role check and the
-- table policies admit any org member. With a `staff` JWT straight at PostgREST a
-- member could
--   * raise a purchase order (INSERT) they cannot even read back, and add lines to it;
--   * rewrite a goods-received note / line (status, voided_*, qty_received) and a
--     stocktake session / line (status, posted_by, counted_qty) by direct PATCH,
--     skipping the posting RPCs' state machine and the stock ledger;
--   * create / edit suppliers (name, email, payment terms) and stock items;
--   * edit the asset and vehicle registers (including purchase_price / current_value),
--     custody records, inspections, calibration certificates, fuel logs, maintenance
--     cases, QR identities and PUBLISHED inspection templates;
--   * edit a customer's property address although the customers module is
--     capability-gated;
--   * move stock by calling the SECURITY DEFINER stock RPCs (record_stock_issue /
--     _transfer / _adjustment / _receipt_from_grn), whose only in-body check is org
--     membership.
--
-- THE DECISION (docs/programme/security-least-privilege/STAFF-ACCESS-DECISIONS.md)
-- -------------------------------------------------------------------------------
-- These modules are CAPABILITY surfaces: default DENY for plain staff; an admin needs
-- the module grant (enforced in the app by requireCapability); the owner always passes.
-- `membership_permissions` is service-role only, so the data layer enforces the role
-- floor (owner/admin) and the application narrows an admin to their grants — the same
-- split as 20261303000000 / 20261304000000.
--
-- THE FIX
-- -------
-- 1. RESTRICTIVE per-command write policies requiring is_org_admin(org_id) on the
--    tables below. Restrictive = ANDed with the existing permissive policies: it can
--    only remove access; nothing existing is dropped or altered. READ access is left
--    as it is (a staff member still sees the assets on a job they are assigned to and
--    the supplier / stock-item names the cost and materials-request forms list).
-- 2. A BEFORE INSERT guard on stock_movements for client JWTs. The four stock RPCs are
--    SECURITY DEFINER (RLS does not apply inside them), so the role floor is enforced
--    on the ledger table itself; the RPC bodies are not touched.
--
-- service_role (crons, importers, webhooks) bypasses RLS and passes the trigger.
-- The SECURITY INVOKER posting RPCs (post_/void_goods_received_note, the stocktake
-- RPCs, save_fleet_vehicle, transfer_asset_assignment) keep working for owner/admin.
--
-- data-api:exempt: policy + trigger only; adds no table and no grant.
-- Additive, idempotent (drops only the NEW policy / trigger names).
--
-- Safe to apply before the code deploys: yes. The old code's ungated staff writes then
-- fail with an RLS error instead of a redirect; owner/admin behaviour is unchanged.
-- Production precondition: none (no data is read or rewritten).
--
-- Rollback (manual, not recommended — reopens ST-10 / ST-11):
--   drop policy "<table>: admin-only <cmd>" on public.<table>;
--   drop trigger stock_movements_admin_writer on public.stock_movements;
--   drop function public.tg_stock_movements_admin_writer();

do $$
declare
  t text;
  c text;
  pol text;
begin
  foreach t in array array[
    -- purchase orders + goods receiving
    'purchase_orders',
    'purchase_order_line_items',
    'goods_received_notes',
    'goods_received_lines',
    -- suppliers
    'suppliers',
    -- stock
    'stock_items',
    'stocktake_sessions',
    'stocktake_lines',
    -- assets + fleet
    'assets',
    'fleet_vehicles',
    'asset_assignments',
    'asset_calibration_certificates',
    'asset_fuel_logs',
    'asset_inspection_templates',
    'asset_inspections',
    'asset_maintenance_cases',
    'asset_qr_identities',
    -- customers module (capability-gated in the app)
    'properties'
  ]
  loop
    foreach c in array array['insert', 'update', 'delete']
    loop
      -- Short name: Postgres truncates identifiers at 63 bytes, and three policies
      -- truncated to the same name would silently replace one another.
      pol := t || ': admin-only ' || c;
      if length(pol) > 63 then
        raise exception 'policy name too long: %', pol;
      end if;
      execute format('drop policy if exists %I on public.%I', pol, t);
      if c = 'insert' then
        execute format(
          'create policy %I on public.%I as restrictive for insert to authenticated '
          'with check (public.is_org_admin(org_id))', pol, t);
      elsif c = 'update' then
        execute format(
          'create policy %I on public.%I as restrictive for update to authenticated '
          'using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id))', pol, t);
      else
        execute format(
          'create policy %I on public.%I as restrictive for delete to authenticated '
          'using (public.is_org_admin(org_id))', pol, t);
      end if;
      execute format(
        'comment on policy %I on public.%I is %L', pol, t,
        'Least privilege (ST-10/ST-11): writes are owner/admin only at the data layer; '
        'the app narrows an admin to their capability grants. RESTRICTIVE — can only '
        'remove access.');
    end loop;
  end loop;
end $$;

-- 2. The stock ledger: only an owner/admin JWT (or the server) may add a movement,
--    whichever write path — table INSERT or SECURITY DEFINER RPC — is used.
create or replace function public.tg_stock_movements_admin_writer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Client JWTs only. service_role and JWT-less sessions (crons, migrations, psql)
  -- are the server and pass.
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and not public.is_org_admin(new.org_id) then
    raise exception 'Forbidden: stock movements are recorded by an owner or admin'
      using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.tg_stock_movements_admin_writer() is
  'Least privilege (ST-11): a client JWT must be an owner/admin of the row''s org to '
  'add a stock movement — also inside the SECURITY DEFINER stock RPCs.';

drop trigger if exists stock_movements_admin_writer on public.stock_movements;
create trigger stock_movements_admin_writer
  before insert on public.stock_movements
  for each row execute function public.tg_stock_movements_admin_writer();
