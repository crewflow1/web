-- ============================================================================
-- R5 Phase 4/5 — fix three legitimate-access regressions the narrowing caused.
-- ============================================================================
-- The adversarial integration reconciliation (PR #1004) found three REAL breaks
-- where Phase 4/5 narrowing stopped a legitimate NON-ADMIN workflow. Each is
-- fixed here by giving the legitimate read a self-/org-scoped SECURITY DEFINER
-- path (not by re-widening a base table). Staff keep their operational
-- workflow; admins/owners unaffected; no cross-tenant exposure.
--
-- B-1 — GOODS-RECEIVED INTO STOCK was broken for non-admin storemen.
--   record_stock_receipt_from_grn (20261212) is SECURITY INVOKER and joins
--   purchase_orders to read po.job_id; migration 20261250 made purchase_orders
--   admin-only, so a non-admin's invoker read returned nothing → "delivery line
--   not found", blocking all goods-receipt. Re-create it SECURITY DEFINER with
--   the canonical org guard: it may now read the PO regardless of the admin-only
--   SELECT, while the guard keeps it strictly tenant-scoped. Body is otherwise
--   byte-for-byte the 20261212 definition.
--
-- B-2 — H&S "required operatives" crew list was broken for non-admin operatives.
--   requiredOperatives() reads rota_entries under the member JWT; migration
--   20261251 self-scoped rota to user_id = auth.uid(), so an operative saw only
--   themselves as the sign-off crew. New SECURITY DEFINER job_rota_crew(job,org)
--   returns the distinct crew of a job (org-guarded); the app reads it instead.
--
-- B-3 — STAFF variation-request intake could file but not read back.
--   variation_requests has a staff self-intake INSERT policy (requester_type
--   'staff' AND requested_by = auth.uid(), 20261221); migration 20261250
--   narrowed SELECT to admin-only, so a staff filer could never see their own
--   request. SELECT is relaxed to is_org_admin OR requested_by = auth.uid() —
--   staff see ONLY their own variations (not the org ledger), admins see all.
-- ROLLBACK notes inline per statement.
-- ============================================================================

-- ── B-1 ─────────────────────────────────────────────────────────────────────
-- ROLLBACK: re-create from 20261212 with `language plpgsql` (no security clause).
create or replace function public.record_stock_receipt_from_grn(
  p_org_id      uuid,
  p_grn_line_id uuid,
  p_item_id     uuid,
  p_site_id     uuid,
  p_notes       text default null
) returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_qty        numeric(12, 2);
  v_grn_status text;
  v_po_job_id  uuid;
  v_existing   uuid;
  v_movement   uuid;
begin
  -- Canonical membership guard (current_org_ids + 42501). SECURITY DEFINER below
  -- lets this read the now-admin-only purchase_orders for a legitimate non-admin
  -- storeman; this guard is what keeps it strictly tenant-scoped.
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;

  if p_org_id is null or p_grn_line_id is null or p_item_id is null or p_site_id is null then
    raise exception 'organisation, delivery line, item and site are all required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on the delivery line AND its note, plus the posted check AND
  -- the parent purchase order's job_id, in one read. The join to purchase_orders
  -- is org-pinned on both sides (composite FK, 20261059); under R5 the PO SELECT
  -- is admin-only, so this function runs SECURITY DEFINER and the org guard above
  -- is the tenancy boundary.
  select grl.qty_received, gn.status, po.job_id
    into v_qty, v_grn_status, v_po_job_id
    from public.goods_received_lines grl
    join public.goods_received_notes gn
      on gn.id = grl.goods_received_note_id and gn.org_id = grl.org_id
    join public.purchase_orders po
      on po.id = gn.purchase_order_id and po.org_id = gn.org_id
   where grl.id = p_grn_line_id and grl.org_id = p_org_id;

  if v_qty is null then
    raise exception 'delivery line not found' using errcode = 'no_data_found';
  end if;
  if v_grn_status <> 'posted' then
    raise exception 'this delivery is % — post it before taking it into stock', v_grn_status
      using errcode = 'check_violation';
  end if;

  -- DEPOT-ONLY GUARD (the double-count fix). A job-tagged delivery belongs on the
  -- job, not in shared stock.
  if v_po_job_id is not null then
    raise exception 'this delivery is for a specific job — record it as a cost against that job when you bill the supplier, not into shared stock'
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENCY. The partial unique index (20261064000000) is the real guard.
  select id into v_existing
    from public.stock_movements
   where grn_line_id = p_grn_line_id
     and movement_type = 'receipt'
     and org_id = p_org_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if not exists (select 1 from public.stock_items where id = p_item_id and org_id = p_org_id) then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  -- The write-path marker the RLS insert policy + guard trigger require
  -- (20261071000000). Transaction-local; names THIS org; cleared immediately after.
  perform set_config('crewflow.stock_write', p_org_id::text, true);
  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes, grn_line_id
  ) values (
    p_org_id, p_item_id, p_site_id, 'receipt', v_qty, auth.uid(),
    nullif(btrim(coalesce(p_notes, '')), ''), p_grn_line_id
  ) returning id into v_movement;
  perform set_config('crewflow.stock_write', '', true);

  return v_movement;
exception
  when unique_violation then
    perform set_config('crewflow.stock_write', '', true);
    select id into v_existing
      from public.stock_movements
     where grn_line_id = p_grn_line_id and movement_type = 'receipt' and org_id = p_org_id;
    if v_existing is null then raise; end if;
    return v_existing;
end $$;

-- ── B-2 ─────────────────────────────────────────────────────────────────────
-- ROLLBACK: drop function public.job_rota_crew(uuid, uuid);
create or replace function public.job_rota_crew(p_job_id uuid, p_org_id uuid)
returns setof uuid language plpgsql stable security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  return query
    select distinct user_id from public.rota_entries
    where job_id = p_job_id and org_id = p_org_id;
end;
$$;

-- ── B-3 ─────────────────────────────────────────────────────────────────────
-- ROLLBACK: recreate with `using (org_id in (select current_org_ids()) and is_org_admin(org_id))`.
drop policy if exists variation_requests_select on public.variation_requests;
create policy variation_requests_select on public.variation_requests
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and (public.is_org_admin(org_id) or requested_by = auth.uid())
  );
