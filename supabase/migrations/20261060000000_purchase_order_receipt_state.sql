-- Warehouse M1 (part 2) — receipt state becomes DERIVED, not asserted.
--
-- 20261059 gave deliveries a record. This migration makes the purchase order
-- TELL THE TRUTH about them:
--
--   1. `purchase_orders.status` gains 'partially_received'. Until now a part
--      delivery — the normal case at a builders' merchant — had nowhere to
--      live: the PO was either 'sent' (a lie: half of it is on site) or
--      'received' (a lie: half of it is still outstanding).
--
--   2. A DB-level TRANSITION TRIGGER. The lifecycle existed only in TypeScript
--      (PO_TRANSITIONS in lib/purchase-orders/schema.ts, checked in
--      setPurchaseOrderStatus). Direct REST — /rest/v1/purchase_orders?id=eq.X
--      with {"status":"received"} — bypassed it entirely, so any JWT member
--      could mark an order received without a single item arriving. That is the
--      same "the app path is safe, the DB is the real backstop" gap 20261034
--      closed for RAMS.
--
--   3. THE RULE FOR THE MANUAL 'received' WRITE (the product decision this
--      migration makes explicit): RECEIPT STATE IS DERIVED FROM POSTED GRNs
--      AND MAY NOT CONTRADICT THEM.
--        · No posted GRN on the order → the legacy manual tick still works:
--          sent → received is allowed, exactly as it does in production today.
--          Nothing that works now stops working, and no back-fill is needed for
--          the POs already sitting at 'received'.
--        · Any posted GRN on the order → the status is owned by the receiving
--          engine. 'received' is refused while a single line is short, and
--          'partially_received' is refused when nothing has been received. The
--          only manual move left is 'cancelled'.
--      So the tick is a shortcut for orders you never bothered to receive
--      formally, and it switches itself off the moment real evidence exists.
--      lib/purchase-orders/schema.ts mirrors this: poManualTransitions()
--      returns only ['cancelled'] once a PO has receipts, so the UI never
--      offers a button the database will refuse.
--
--   4. OVER-RECEIPT IS BLOCKED, IN THE DATABASE. Posting 60 against a line
--      with 50 outstanding raises. A tolerance ("accept up to 5% / 1 unit
--      over") is a genuine product/commercial decision with VAT and
--      supplier-claim consequences; nobody has made it, so the safe default is
--      to refuse and make the user split the order or amend the PO. ESCALATED:
--      if merchants routinely over-deliver, this becomes a per-org tolerance
--      setting, and this function is the single place it would be applied.
--
--   5. CONCURRENCY. post_goods_received_note() and void_goods_received_note()
--      both take pg_advisory_xact_lock() on the PURCHASE ORDER (the
--      20261051 CIS-settlement precedent) before reading "how much has already
--      been received". Without it, two operators posting the same delivery — or
--      one double-submitted form — both read "0 received", both pass the
--      over-receipt check, and the order ends up 200% received with two GRNs
--      that each look individually valid. The lock makes the read-check-write
--      sequence serial per order; the loser simply sees the over-receipt error.
--      Proven with two concurrent psql sessions, not merely reasoned about.
--
--   6. Delivery-note photos ride the EXISTING attachments pipeline
--      (tenant_attachments), widened by the introspect-drop-readd idiom.
--
--   7. Tenant visibility: activity_log gains 'grn.posted' / 'grn.voided' and
--      the purchase order's status changes. Triggers are the ONLY legal writers
--      of activity_log (20260516200000). Both new triggers are AFTER UPDATE
--      ONLY — never AFTER DELETE — so neither can be reached by the
--      `delete from organizations` cascade that 20261052 had to rescue.
--
-- RECEIVING IS OPERATIONAL, NOT FINANCIAL. Nothing here touches `finances`.
-- The cost of the goods still lands exactly once, when the supplier's bill is
-- recorded (recordSupplierBill). Asserted by a security test.
--
-- Additive and reversible: one widened CHECK, four functions, three triggers.

-- ── 1. Widen the status CHECK (introspect-drop-readd; 20260925/20261057) ────
-- Matching on the constraint DEFINITION rather than a hard-coded name: it is
-- the only CHECK on this table that mentions `status`. WIDENING ONLY — every
-- previously legal value stays legal, so no existing row is invalidated.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'purchase_orders'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%status%';
  if cname is not null then
    execute format('alter table public.purchase_orders drop constraint %I', cname);
  end if;
end $$;

alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check (status in ('draft', 'sent', 'partially_received', 'received', 'cancelled'));

-- ── 2. The derivation — the single source of receipt truth ──────────────────
-- 'none'    no posted receipt quantity at all
-- 'partial' something received, but at least one ordered line is still short
-- 'full'    every ordered line has been received in full
--
-- INTERNAL: SECURITY DEFINER so the transition trigger is authoritative even
-- when the caller could not see every row, and EXECUTE is revoked from
-- authenticated (the 20260708000001 lock-down idiom) so a JWT cannot probe
-- another tenant's order id. App callers go through the tenancy-checked wrapper
-- purchase_order_receipt_state() below.
create or replace function public.po_receipt_state(p_po_id uuid)
returns text language sql stable security definer set search_path = public as $$
  with ordered as (
    select li.id, li.qty
      from public.purchase_order_line_items li
     where li.purchase_order_id = p_po_id
  ),
  got as (
    -- The join to purchase_order_line_items is not redundant with the
    -- tg_goods_received_line_draft_only guard: it makes this function's
    -- definition IDENTICAL to computeReceiving() in
    -- lib/purchase-orders/receiving.ts, which counts only receipts against
    -- lines that are still on the order. Two definitions of "received" that
    -- could ever differ is how a page ends up disagreeing with the status
    -- beside it.
    select grl.purchase_order_line_item_id as id, sum(grl.qty_received) as qty
      from public.goods_received_lines grl
      join public.goods_received_notes gn on gn.id = grl.goods_received_note_id
      join public.purchase_order_line_items li
        on li.id = grl.purchase_order_line_item_id
       and li.purchase_order_id = p_po_id
     where gn.purchase_order_id = p_po_id
       and gn.status = 'posted'
     group by 1
  )
  select case
    when coalesce((select sum(qty) from got), 0) = 0 then 'none'
    when not exists (
      select 1 from ordered o
        left join got g on g.id = o.id
       where coalesce(g.qty, 0) < o.qty
    ) then 'full'
    else 'partial'
  end;
$$;
revoke execute on function public.po_receipt_state(uuid) from public, anon, authenticated;

-- Tenancy-checked wrapper for app callers. p_org_id is the ACTIVE org: passing
-- the wrong one returns 'none'-equivalent by raising, so a receipt state can
-- never be read for an order outside the company the operator is working in.
create or replace function public.purchase_order_receipt_state(p_po_id uuid, p_org_id uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'purchase order not found' using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from public.purchase_orders where id = p_po_id and org_id = p_org_id
  ) then
    raise exception 'purchase order not found' using errcode = 'no_data_found';
  end if;
  return public.po_receipt_state(p_po_id);
end $$;
grant execute on function public.purchase_order_receipt_state(uuid, uuid) to authenticated;

-- ── 3. The transition trigger — the graph, enforced at the database ────────
create or replace function public.tg_purchase_order_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_state text;
begin
  if new.status is not distinct from old.status then
    return new; -- ordinary field edit; nothing to police
  end if;

  if old.status = 'cancelled' then
    raise exception 'purchase order %: cancelled is final', old.id
      using errcode = 'check_violation';
  end if;

  -- Cancelling is always available from a live state (you can abandon the rest
  -- of a part-delivered order; the GRNs already posted stay as evidence).
  if new.status = 'cancelled' then
    return new;
  end if;

  if new.status = 'draft' then
    raise exception 'purchase order %: an order that has been sent cannot go back to draft', old.id
      using errcode = 'check_violation';
  end if;

  -- Structural skeleton. Wider than the manual graph in TypeScript on purpose:
  -- the receiving engine also moves this column, and voiding a GRN legitimately
  -- moves it BACKWARDS (received -> partially_received -> sent). The receipt
  -- consistency rule below is what stops a human using those backward edges to
  -- misreport; alone, neither check is sufficient.
  if not (
       (old.status = 'draft'              and new.status = 'sent')
    or (old.status = 'sent'               and new.status in ('partially_received', 'received'))
    or (old.status = 'partially_received' and new.status in ('received', 'sent'))
    or (old.status = 'received'           and new.status in ('partially_received', 'sent'))
  ) then
    raise exception 'purchase order %: % -> % is not a legal transition', old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;

  -- Receipt consistency (see header note 3).
  v_state := public.po_receipt_state(new.id);
  if v_state = 'none' and new.status = 'partially_received' then
    raise exception 'purchase order %: nothing has been received against this order', old.id
      using errcode = 'check_violation';
  elsif v_state = 'partial' and new.status <> 'partially_received' then
    raise exception 'purchase order %: goods received notes show a PART delivery — the status is derived, not set by hand', old.id
      using errcode = 'check_violation';
  elsif v_state = 'full' and new.status <> 'received' then
    raise exception 'purchase order %: every ordered line has been received — the status is derived, not set by hand', old.id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists purchase_orders_transition on public.purchase_orders;
create trigger purchase_orders_transition
  before update on public.purchase_orders
  for each row execute function public.tg_purchase_order_transition();

-- ── 4. Posting a delivery — one atomic, RLS-respecting operation ────────────
-- SECURITY INVOKER (the transfer_asset_assignment precedent, 20260925): the
-- caller's RLS, every guard trigger, both composite FKs and the transition
-- trigger ALL still apply, and if any line fails the WHOLE delivery rolls back.
-- An RPC rather than a multi-statement client sequence because a half-posted
-- delivery — note without lines, or lines without a status move — is exactly
-- the corrupt state this milestone exists to prevent.
create or replace function public.post_goods_received_note(
  p_org_id                  uuid,
  p_purchase_order_id       uuid,
  p_delivery_date           date,
  p_delivery_note_reference text,
  p_delivery_location       text,
  p_notes                   text,
  p_received_by             uuid,
  -- [{ "line_item_id": uuid, "qty_received": numeric, "notes": text }, ...]
  p_lines                   jsonb
) returns uuid
language plpgsql
as $$
declare
  v_po_status text;
  v_grn       uuid;
  v_number    text;
  v_ordered   numeric;
  v_prev      numeric;
  v_seen      uuid[] := '{}';
  v_state     text;
  v_target    text;
  r           record;
begin
  if p_org_id is null or p_purchase_order_id is null then
    raise exception 'org and purchase order are required'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'record what arrived before posting the delivery'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Serialise every receipt decision on THIS order (header note 5).
  perform pg_advisory_xact_lock(hashtext('grn_post_po'), hashtext(p_purchase_order_id::text));

  -- ACTIVE-ORG PIN. RLS admits every org the caller belongs to; p_org_id
  -- narrows that to the one company they are working in, so a dual-org user
  -- cannot receive against the other company's order.
  select status into v_po_status
    from public.purchase_orders
   where id = p_purchase_order_id and org_id = p_org_id;
  if v_po_status is null then
    raise exception 'purchase order not found' using errcode = 'no_data_found';
  end if;
  if v_po_status not in ('sent', 'partially_received') then
    raise exception 'a % purchase order cannot take a delivery', v_po_status
      using errcode = 'check_violation';
  end if;

  -- Number allocation serialised per ORG; unique (org_id, number) is still the
  -- real guard (20261059 header).
  perform pg_advisory_xact_lock(hashtext('grn_number'), hashtext(p_org_id::text));
  v_number := public.next_grn_number(p_org_id);

  insert into public.goods_received_notes (
    org_id, purchase_order_id, number, status, received_by, delivery_date,
    delivery_note_reference, delivery_location, notes, created_by
  ) values (
    p_org_id, p_purchase_order_id, v_number, 'draft', p_received_by,
    coalesce(p_delivery_date, current_date),
    nullif(btrim(coalesce(p_delivery_note_reference, '')), ''),
    nullif(btrim(coalesce(p_delivery_location, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    auth.uid()
  ) returning id into v_grn;

  for r in
    select (elem ->> 'line_item_id')::uuid          as line_item_id,
           round((elem ->> 'qty_received')::numeric, 2) as qty,
           nullif(btrim(coalesce(elem ->> 'notes', '')), '') as notes
      from jsonb_array_elements(p_lines) as elem
     order by 1
  loop
    if r.line_item_id is null then
      raise exception 'every received line must name an ordered line'
        using errcode = 'invalid_parameter_value';
    end if;
    if r.line_item_id = any (v_seen) then
      raise exception 'line % appears twice on the same delivery — combine it into one row', r.line_item_id
        using errcode = 'invalid_parameter_value';
    end if;
    v_seen := v_seen || r.line_item_id;

    if r.qty is null or r.qty <= 0 then
      raise exception 'received quantity must be above zero'
        using errcode = 'invalid_parameter_value';
    end if;

    select li.qty into v_ordered
      from public.purchase_order_line_items li
     where li.id = r.line_item_id
       and li.purchase_order_id = p_purchase_order_id
       and li.org_id = p_org_id;
    if v_ordered is null then
      raise exception 'line % is not on this purchase order', r.line_item_id
        using errcode = 'check_violation';
    end if;

    select coalesce(sum(grl.qty_received), 0) into v_prev
      from public.goods_received_lines grl
      join public.goods_received_notes gn on gn.id = grl.goods_received_note_id
     where grl.purchase_order_line_item_id = r.line_item_id
       and gn.status = 'posted';

    -- OVER-RECEIPT: blocked (header note 4).
    if v_prev + r.qty > v_ordered then
      raise exception
        'over-receipt: % ordered, % already received, % more would exceed the order',
        v_ordered, v_prev, r.qty using errcode = 'check_violation';
    end if;

    insert into public.goods_received_lines (
      org_id, goods_received_note_id, purchase_order_line_item_id, qty_received, notes
    ) values (
      p_org_id, v_grn, r.line_item_id, r.qty, r.notes
    );
  end loop;

  -- Post it. The lifecycle trigger re-checks substance and PINS posted_by /
  -- posted_at server-side, so provenance cannot be forged or back-dated.
  update public.goods_received_notes
     set status = 'posted'
   where id = v_grn and org_id = p_org_id;

  -- Move the order to whatever the receipts now say. The transition trigger
  -- independently re-derives and refuses anything that disagrees, so this
  -- statement cannot invent a status.
  v_state  := public.purchase_order_receipt_state(p_purchase_order_id, p_org_id);
  v_target := case v_state when 'full' then 'received'
                           when 'partial' then 'partially_received'
                           else 'sent' end;
  if v_target <> v_po_status then
    update public.purchase_orders
       set status = v_target
     where id = p_purchase_order_id and org_id = p_org_id;
  end if;

  return v_grn;
end $$;
grant execute on function public.post_goods_received_note(
  uuid, uuid, date, text, text, text, uuid, jsonb
) to authenticated;

-- ── 5. Voiding a delivery — the ONLY correction path ───────────────────────
-- A posted GRN is immutable evidence, so a mistake is corrected by voiding it
-- with a reason and recording a fresh one. Voiding removes its quantities from
-- the derivation, so the order's status walks BACK to the truth in the same
-- transaction (received -> partially_received -> sent).
create or replace function public.void_goods_received_note(
  p_grn_id uuid,
  p_org_id uuid,
  p_reason text
) returns uuid
language plpgsql
as $$
declare
  v_po      uuid;
  v_status  text;
  v_current text;
  v_state   text;
  v_target  text;
begin
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'a void needs a reason — it is the correction record'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN (see post_goods_received_note).
  select purchase_order_id, status into v_po, v_status
    from public.goods_received_notes
   where id = p_grn_id and org_id = p_org_id;
  if v_po is null then
    raise exception 'goods received note not found' using errcode = 'no_data_found';
  end if;
  if v_status = 'void' then
    raise exception 'this delivery has already been voided' using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtext('grn_post_po'), hashtext(v_po::text));

  update public.goods_received_notes
     set status = 'void', void_reason = btrim(p_reason)
   where id = p_grn_id and org_id = p_org_id;

  select status into v_current
    from public.purchase_orders where id = v_po and org_id = p_org_id;
  if v_current is not null and v_current not in ('cancelled', 'draft') then
    v_state  := public.purchase_order_receipt_state(v_po, p_org_id);
    v_target := case v_state when 'full' then 'received'
                             when 'partial' then 'partially_received'
                             else 'sent' end;
    if v_target <> v_current then
      update public.purchase_orders
         set status = v_target
       where id = v_po and org_id = p_org_id;
    end if;
  end if;

  return p_grn_id;
end $$;
grant execute on function public.void_goods_received_note(uuid, uuid, text) to authenticated;

-- ── 6. Delivery-note photos ride the universal attachments pipeline ────────
-- Introspect + rebuild, preserving EVERY prior target. The 16 targets below
-- were read back from the LIVE constraint (pg_get_constraintdef on the applied
-- 20261058 schema), never reconstructed from memory — the introspection drops
-- whatever is there, so an under-stated list would silently REVOKE attachment
-- support for a whole domain. 20261058000000 is the last migration that widened
-- it; 'goods_received_notes' is the 17th.
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
                          'asset_maintenance_cases', 'asset_fuel_logs',
                          'goods_received_notes'));

-- ── 7. Tenant visibility (activity_log) ────────────────────────────────────
-- Triggers are the only legal writers of activity_log (20260516200000); both of
-- these are AFTER UPDATE ONLY, so neither sits on the org-teardown cascade path
-- that 20261052 had to rescue (that failure mode needs an AFTER DELETE trigger).
create or replace function public._tg_goods_received_notes_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.status is distinct from OLD.status and NEW.status = 'posted' then
    perform _record_activity(
      NEW.org_id, 'grn.posted', 'goods_received_notes', NEW.id,
      jsonb_build_object(
        'number', NEW.number,
        'purchase_order_id', NEW.purchase_order_id,
        'delivery_date', NEW.delivery_date,
        'delivery_note_reference', NEW.delivery_note_reference,
        'lines', (select count(*) from public.goods_received_lines
                   where goods_received_note_id = NEW.id)
      )
    );
  elsif NEW.status is distinct from OLD.status and NEW.status = 'void' then
    perform _record_activity(
      NEW.org_id, 'grn.voided', 'goods_received_notes', NEW.id,
      jsonb_build_object(
        'number', NEW.number,
        'purchase_order_id', NEW.purchase_order_id,
        'reason', NEW.void_reason,
        'from', OLD.status
      )
    );
  end if;
  return null;
end $$;

drop trigger if exists goods_received_notes_activity on public.goods_received_notes;
create trigger goods_received_notes_activity
  after update on public.goods_received_notes
  for each row execute function public._tg_goods_received_notes_activity();

-- Purchase orders had NO tenant activity trigger — only the HQ-side audit
-- (recordAdminActivity), which tenants cannot see. Now that receipts move this
-- column on their own, the derived transition must be visible in the org's own
-- feed, otherwise an order would change state with no explanation anywhere the
-- customer can read. Fires on status only.
create or replace function public._tg_purchase_orders_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.status is distinct from OLD.status then
    perform _record_activity(
      NEW.org_id, 'purchase_order.' || NEW.status, 'purchase_orders', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'from', OLD.status, 'to', NEW.status,
        'total', NEW.total, 'job_id', NEW.job_id
      )
    );
  end if;
  return null;
end $$;

drop trigger if exists purchase_orders_activity on public.purchase_orders;
create trigger purchase_orders_activity
  after update of status on public.purchase_orders
  for each row execute function public._tg_purchase_orders_activity();
