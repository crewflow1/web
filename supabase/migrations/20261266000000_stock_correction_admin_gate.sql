-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  record_stock_correction → ADMIN-ONLY (owner/admin), 2026-11-01            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- WHY. A correction REVERSES a posted movement. Like `record_stock_adjustment`
-- (20261071000000) it changes the authoritative ledger after the fact, and
-- stock quantity feeds job profitability. The two sit either side of the house
-- boundary described in 20261065000000: "a member can move stock all day; only
-- an owner/admin can declare that the number WAS WRONG." Issue / transfer /
-- receipt stay member-level (routine operational acts); correction and
-- adjustment are the privileged after-the-fact ledger changes. Correction was
-- the one such path still open to any member — this closes that gap so the two
-- after-the-fact ledger writers share one permission model.
--
-- The action layer (app/(app)/stock/actions.ts::correctStockMovement) already
-- shows a member a clean sentence, but the UI check is NOT the control — the RPC
-- is callable directly by any authenticated principal via PostgREST, so the
-- enforcing gate must live HERE, exactly as the adjustment gate does. Defence in
-- depth, mirroring record_stock_adjustment verbatim.
--
-- SCOPE. This CREATE OR REPLACE reproduces the CURRENT definition of
-- public.record_stock_correction (20261071000000 — the one that sets the
-- `crewflow.stock_write` authorised-write marker the write-path trigger
-- requires) BYTE-FOR-BYTE, except for the new admin gate inserted as the
-- function's first act. SECURITY INVOKER is preserved (no `security definer`),
-- so the caller's RLS and every guard trigger still apply; the write-path
-- marker, the single transfer-leg refusal, the per-(item, site) advisory lock,
-- the negative-stock floor and the append-only insert are all UNCHANGED.
-- Tenant isolation is unchanged: the ACTIVE-ORG PIN (`org_id = p_org_id` on the
-- movement read) still scopes every correction to the caller's org, and
-- is_org_admin(p_org_id) itself only returns true for an owner/admin OF THAT org.
--
-- Additive and reversible. To roll back, re-apply 20261071000000's definition of
-- public.record_stock_correction (identical body without the admin gate).

create or replace function public.record_stock_correction(
  p_org_id     uuid,
  p_movement_id uuid,
  p_reason     text
) returns uuid
language plpgsql
as $$
declare
  v_item     uuid;
  v_site     uuid;
  v_effect   numeric(12, 2);
  v_group    uuid;
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_reason   text;
begin
  -- ADMIN-ONLY (NEW, 2026-11-01). A correction reverses the authoritative
  -- ledger, so it carries the same owner/admin gate as record_stock_adjustment.
  -- JWT-gated (the 20261034000000 asymmetry): auth.uid() is null for the trusted
  -- service role, which is not a tenant principal and must not be blocked.
  if auth.uid() is not null and not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can correct a stock movement'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'a correction needs a reason — it is the correction record'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN, plus the transfer_group_id the guard below needs.
  select stock_item_id, site_id, effect, transfer_group_id
    into v_item, v_site, v_effect, v_group
    from public.stock_movements
   where id = p_movement_id and org_id = p_org_id;
  if v_item is null then
    raise exception 'stock movement not found' using errcode = 'no_data_found';
  end if;

  -- A SINGLE TRANSFER LEG IS NOT CORRECTABLE (20261069000000). Refused here for
  -- a clear message, and again structurally by tg_stock_movements_derive.
  if v_group is not null then
    raise exception
      'this is one leg of a transfer — move it back with a compensating transfer, which keeps both sites in balance; correcting a single leg would create stock at one site'
      using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(v_item, v_site)
  );

  -- Reversing an INBOUND movement removes quantity, so it can breach the floor.
  if v_effect > 0 then
    v_balance := public.stock_balance(p_org_id, v_item, v_site);
    if v_effect > v_balance then
      raise exception
        'cannot reverse % units: only % left at this site — some of it has already been used. Record an adjustment instead',
        v_effect, v_balance using errcode = 'check_violation';
    end if;
  end if;

  perform set_config('crewflow.stock_write', p_org_id::text, true);
  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes,
    corrects_movement_id
  ) values (
    p_org_id, v_item, v_site, 'correction', abs(v_effect), auth.uid(), v_reason,
    p_movement_id
  ) returning id into v_movement;
  perform set_config('crewflow.stock_write', '', true);

  return v_movement;
end $$;
grant execute on function public.record_stock_correction(uuid, uuid, text) to authenticated;

comment on function public.record_stock_correction(uuid, uuid, text) is
  'Reverse ONE earlier movement in full, with a reason. Refuses a single transfer leg (record a compensating transfer instead — 20261069000000). Sets the crewflow.stock_write write-path marker (20261071000000). ADMIN-ONLY (owner/admin, 20261266000000): a correction reverses the authoritative ledger and feeds job profitability, so it carries the same is_org_admin gate as record_stock_adjustment. Issue/transfer/receipt stay member-level.';
