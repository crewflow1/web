-- ============================================================================
-- R5 Phase 4 (slice 5) — stock_movements financial masking (read-split).
-- ============================================================================
-- stock_movements is BOTH operational (qty / effect / movement_type / site / job
-- — staff legitimately see on-hand quantities) AND commercial (unit_cost /
-- cost_effect / costed_qty_effect — the valuation/COGS facts staff must not see).
-- A blanket admin-only SELECT would break staff stock quantities AND zero stock
-- valuation; column-level GRANTs can't distinguish admin from staff at runtime.
-- So this is a read-split:
--
--   1. A cost-free operational VIEW (stock_movements_operational) exposes every
--      operational column and projects the 3 cost columns as NULL. It is
--      security_invoker=false (so it is not re-blocked by the narrowed base RLS)
--      and self-scopes rows with `org_id in (select current_org_ids())`. Granted
--      to authenticated. Staff read QUANTITIES here; cost is never present.
--   2. The quantity BALANCES survive the base narrow: stock_balance() becomes
--      SECURITY DEFINER + org-guarded, and the stock_balances view becomes
--      security_invoker=false + org-filtered. Both already sum only `effect`
--      (quantity), never cost, so no cost is exposed.
--   3. The base table SELECT narrows to is_org_admin — direct base reads (which
--      carry cost) are owner/admin-only. The app's cost paths (valuation / COGS
--      reports) are already costs:view-gated (admin) and read the base.
--
-- The companion server/services/stock.ts change points the STAFF quantity paths
-- (listStockMovements / loadStockPositions / history / low-stock) at the
-- operational view, and gives the valuation/COGS folds their own base read.
-- Writes (goods-received via the definer RPC, adjustments, cost entry) are
-- unchanged. Owners/admins keep full base access.
-- ROLLBACK:
--   drop view if exists public.stock_movements_operational;
--   -- recreate stock_balance / stock_balances / the base SELECT policy from
--   -- 20261064000000 (security_invoker=true, member-scoped).
-- ============================================================================

-- 1. Cost-free operational view (quantities only; cost columns NULL).
create or replace view public.stock_movements_operational
with (security_invoker = false) as
  select
    id, org_id, stock_item_id, site_id, movement_type, qty, effect,
    occurred_at, actor_id, notes, grn_line_id, job_id,
    material_request_line_id, transfer_group_id, corrects_movement_id, created_at,
    null::numeric as unit_cost,
    null::numeric as cost_effect,
    null::numeric as costed_qty_effect
  from public.stock_movements
  where org_id in (select public.current_org_ids());

revoke all on public.stock_movements_operational from anon;
grant select on public.stock_movements_operational to authenticated;

-- 2a. Quantity balance function → SECURITY DEFINER + canonical org guard (no cost).
create or replace function public.stock_balance(
  p_org_id  uuid,
  p_item_id uuid,
  p_site_id uuid
) returns numeric
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  return coalesce((
    select sum(effect)
      from public.stock_movements
     where org_id = p_org_id and stock_item_id = p_item_id and site_id = p_site_id
  ), 0)::numeric(12, 2);
end;
$$;
grant execute on function public.stock_balance(uuid, uuid, uuid) to authenticated;

-- 2b. Quantity balances view → definer-style (own org only, quantity only).
drop view if exists public.stock_balances;
create view public.stock_balances
with (security_invoker = false) as
  select org_id,
         stock_item_id,
         site_id,
         sum(effect)::numeric(12, 2) as quantity,
         max(occurred_at)            as last_movement_at,
         count(*)                    as movement_count
    from public.stock_movements
   where org_id in (select public.current_org_ids())
   group by org_id, stock_item_id, site_id;
grant select on public.stock_balances to authenticated;

-- 3. Base table SELECT → admin-only (cost columns off-limits to staff; the
--    operational view + definer balances are the staff quantity paths).
drop policy if exists "stock_movements: members can select" on public.stock_movements;
create policy "stock_movements: members can select" on public.stock_movements
  for select to authenticated
  using (org_id in (select public.current_org_ids()) and public.is_org_admin(org_id));
