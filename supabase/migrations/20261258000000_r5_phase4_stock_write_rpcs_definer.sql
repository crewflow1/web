-- ============================================================================
-- R5 Phase 4 (slice 5b) — stock write-path RPCs → SECURITY DEFINER + org guard.
-- ============================================================================
-- Companion to 20261257 (stock_movements base SELECT narrowed to admin). The
-- member write-path RPCs record_stock_issue / record_stock_transfer /
-- record_stock_adjustment read stock_movements internally (balance checks) under
-- SECURITY INVOKER, so the base narrow would make a non-admin's balance read
-- return nothing and break legitimate stock issue/transfer/adjustment. Re-created
-- SECURITY DEFINER with the canonical org guard (current_org_ids + 42501) — same
-- mechanism as record_stock_receipt_from_grn (20261256). Bodies are verbatim from
-- pg_get_functiondef with ONLY the security clause + guard added; the negative-
-- balance guard, admin-only adjustment gate, write-marker and append-only
-- invariants are unchanged. The adjustment RPC keeps its own in-body admin check.
-- ROLLBACK: re-create each from 20261071000000 (LANGUAGE plpgsql, no security clause).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.record_stock_issue(p_org_id uuid, p_item_id uuid, p_site_id uuid, p_qty numeric, p_job_id uuid DEFAULT NULL::uuid, p_material_request_line_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_qty      numeric(12, 2);
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_name     text;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  v_qty := round(coalesce(p_qty, 0), 2);
  if v_qty <= 0 then
    raise exception 'enter how much is going out — the quantity must be above zero'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on both references.
  select name into v_name from public.stock_items
   where id = p_item_id and org_id = p_org_id;
  if v_name is null then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  -- ...and on the material request line, now that it has a real FK (§1a). The
  -- FK is the rule; this read is only here so a crafted cross-org line id is
  -- refused with a sentence at call time rather than a raw 23503 at COMMIT.
  if p_material_request_line_id is not null
     and not exists (
       select 1 from public.material_request_lines
        where id = p_material_request_line_id and org_id = p_org_id
     ) then
    raise exception 'material request line not found' using errcode = 'no_data_found';
  end if;

  -- SERIALISE the read-check-write on this exact (item, site).
  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(p_item_id, p_site_id)
  );

  v_balance := public.stock_balance(p_org_id, p_item_id, p_site_id);
  if v_qty > v_balance then
    raise exception
      'not enough %: % in stock at this site, % requested', v_name, v_balance, v_qty
      using errcode = 'check_violation';
  end if;

  perform set_config('crewflow.stock_write', p_org_id::text, true);
  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes,
    job_id, material_request_line_id
  ) values (
    p_org_id, p_item_id, p_site_id, 'issue', v_qty, auth.uid(),
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_job_id, p_material_request_line_id
  ) returning id into v_movement;
  perform set_config('crewflow.stock_write', '', true);

  return v_movement;
end $function$;

CREATE OR REPLACE FUNCTION public.record_stock_transfer(p_org_id uuid, p_item_id uuid, p_from_site_id uuid, p_to_site_id uuid, p_qty numeric, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_qty     numeric(12, 2);
  v_balance numeric(12, 2);
  v_group   uuid := gen_random_uuid();
  v_name    text;
  v_notes   text;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  v_qty := round(coalesce(p_qty, 0), 2);
  if v_qty <= 0 then
    raise exception 'enter how much is moving — the quantity must be above zero'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from_site_id is null or p_to_site_id is null or p_from_site_id = p_to_site_id then
    raise exception 'a transfer needs two different sites'
      using errcode = 'invalid_parameter_value';
  end if;

  select name into v_name from public.stock_items
   where id = p_item_id and org_id = p_org_id;
  if v_name is null then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  -- BOTH sites pinned to the ACTIVE org.
  if (select count(*) from public.sites
       where id in (p_from_site_id, p_to_site_id) and org_id = p_org_id) <> 2 then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  -- Only the FROM side is locked: the TO side only ever gains, and locking one
  -- side removes the A→B / B→A deadlock.
  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(p_item_id, p_from_site_id)
  );

  v_balance := public.stock_balance(p_org_id, p_item_id, p_from_site_id);
  if v_qty > v_balance then
    raise exception
      'not enough %: % in stock at the site it is leaving, % requested', v_name, v_balance, v_qty
      using errcode = 'check_violation';
  end if;

  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- CONSERVATION: both legs in one statement, so the pair can never be half
  -- written. One marker covers both rows — they are the same org by construction.
  perform set_config('crewflow.stock_write', p_org_id::text, true);
  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes, transfer_group_id
  ) values
    (p_org_id, p_item_id, p_from_site_id, 'transfer_out', v_qty, auth.uid(), v_notes, v_group),
    (p_org_id, p_item_id, p_to_site_id,   'transfer_in',  v_qty, auth.uid(), v_notes, v_group);
  perform set_config('crewflow.stock_write', '', true);

  return v_group;
end $function$;

CREATE OR REPLACE FUNCTION public.record_stock_adjustment(p_org_id uuid, p_item_id uuid, p_site_id uuid, p_delta numeric, p_reason text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_delta    numeric(12, 2);
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_name     text;
  v_reason   text;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  -- JWT-gated (the 20261034000000 asymmetry): auth.uid() is null for the
  -- trusted service role, which is not a tenant principal.
  if auth.uid() is not null and not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can adjust stock'
      using errcode = 'insufficient_privilege';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'an adjustment needs a reason — it is the only record of why the number changed'
      using errcode = 'invalid_parameter_value';
  end if;

  v_delta := round(coalesce(p_delta, 0), 2);
  if v_delta = 0 then
    raise exception 'an adjustment of zero changes nothing'
      using errcode = 'invalid_parameter_value';
  end if;

  select name into v_name from public.stock_items
   where id = p_item_id and org_id = p_org_id;
  if v_name is null then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(p_item_id, p_site_id)
  );

  if v_delta < 0 then
    v_balance := public.stock_balance(p_org_id, p_item_id, p_site_id);
    if -v_delta > v_balance then
      raise exception
        'cannot write off % of %: only % in stock at this site', -v_delta, v_name, v_balance
        using errcode = 'check_violation';
    end if;
  end if;

  perform set_config('crewflow.stock_write', p_org_id::text, true);
  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes
  ) values (
    p_org_id, p_item_id, p_site_id,
    case when v_delta > 0 then 'adjustment_in' else 'adjustment_out' end,
    abs(v_delta), auth.uid(), v_reason
  ) returning id into v_movement;
  perform set_config('crewflow.stock_write', '', true);

  return v_movement;
end $function$;
