-- O3 OPERATIONAL STOCK, part 3 of 3 — the WRITE PATHS.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — RESTATED. Every function in this file writes  ║
-- ║  exactly one kind of row: a `stock_movements` row. NONE of them touches  ║
-- ║  `public.finances`, none creates a trigger on it, and none carries a     ║
-- ║  price, a cost or a VAT rate. Materials are already expensed by          ║
-- ║  recordSupplierBill; a second posting at receipt or at issue would       ║
-- ║  double-count the same spend. Stock valuation is CEO decision D1 and is  ║
-- ║  UNDECIDED — this milestone is an operational quantity ledger only.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Five SECURITY INVOKER functions — the transfer_asset_assignment posture
-- (20260925000000) and the post_goods_received_note posture (20261060000000):
-- the caller's RLS, every guard trigger and every composite FK STILL APPLY, so
-- none of these is a privileged back door. They exist for the two things a
-- client-side statement sequence cannot do:
--
--   1. ATOMICITY. A transfer is TWO rows that must both exist or neither. Done
--      from the client that is two round trips with a window in which stock has
--      left one depot and arrived nowhere.
--   2. CORRECTNESS UNDER CONCURRENCY. "Do we have enough?" is a read-then-write
--      and is only sound under a lock. See the next section.
--
-- ── NEGATIVE STOCK IS REFUSED. THE DEFAULT POSTURE, AND WHY ─────────────────
-- You cannot issue 10 boards from a site that holds 6. The database refuses it.
--
-- This is the same shape of decision as the over-receipt block in
-- 20261060000000 note 4, and it is made the same way: a tolerance is a real
-- operational decision with consequences (a negative balance means either the
-- stock-take is wrong or somebody took something without recording it, and
-- silently permitting it destroys the one signal that would have told you), and
-- NOBODY HAS MADE IT. So the safe default is to refuse and make the human say
-- what is actually true — an `adjustment_in` with a reason ("stock-take: 20 more
-- on the rack than the system knew") is the honest path, and it leaves a record.
-- ESCALATED: if builders routinely issue ahead of booking their deliveries in,
-- this becomes a per-org tolerance setting, and these functions are the single
-- place it would be applied.
--
-- ── THE PER-(ITEM, SITE) ADVISORY LOCK ──────────────────────────────────────
-- The refusal above is a READ ("what is the balance") followed by a WRITE ("take
-- 10 off it"). Without serialisation, two operators issuing the last 10 units at
-- the same moment BOTH read "10 available", BOTH pass the check, and BOTH
-- commit — the site ends at -10 and every subsequent number in the product is
-- wrong. It is not a rare race: it is the ordinary double-submit of a form on a
-- phone with one bar of signal.
--
-- So every outbound path takes `pg_advisory_xact_lock` on the (item, site)
-- pair before it reads. This is the 20261051000000 CIS-settlement precedent and
-- the 20261060000000 GRN-posting precedent, at the narrowest granularity that
-- makes the check sound: two issues of DIFFERENT items, or the same item at
-- DIFFERENT sites, never block each other.
--
-- PROVEN, not reasoned about: two real psql sessions issuing the last 10 units
-- concurrently — with the lock one commits and one is refused (balance 0); with
-- the lock removed both commit and the balance is -10. Recorded in
-- docs/operational-stock.md alongside the exact transcript.
--
-- KNOWN RESIDUE, STATED RATHER THAN HIDDEN: `stock_movements` grants members a
-- direct INSERT policy (20261064000000 §6), because these functions are
-- SECURITY INVOKER and therefore need the caller's own insert right. A caller
-- who bypasses these functions and PATCHes PostgREST directly can therefore
-- write an unserialised movement and drive a balance negative. Closing that
-- would mean either making these functions SECURITY DEFINER (giving up RLS,
-- every guard trigger and the whole "not a back door" property — a far worse
-- trade) or adding a constraint trigger that recomputes the balance on every
-- insert (a full re-sum per row, and still not serialised without the same
-- lock). The app never takes that path, the direct-insert caller can still
-- forge nothing (sign, tenancy, reason and immutability are all structural),
-- and a negative balance is LOUD in the UI rather than silent. Recorded as
-- deferred debt.
--
-- ── GRN VOID vs STOCK RECEIPT: THE RULE THIS MILESTONE CHOSE ───────────────
-- A posted GRN is immutable evidence and the ONLY correction path is
-- void-with-a-reason (20261059000000 note 5). Once a delivery line has been
-- taken into stock, voiding its GRN could mean one of two things, and the
-- choice between them is a real decision:
--
--   (a) AUTO-CORRECT the stock receipt as part of the void, or
--   (b) REFUSE the void until the stock receipt has been corrected explicitly.
--
-- THIS MIGRATION CHOOSES (b), and refuses the void. Three reasons:
--
--   1. THE GOODS ARE REAL. The commonest void reason is "booked against the
--      wrong order" — the lorry still came, the blocks are still in the yard.
--      Auto-reversing would tell the storeman that 40 blocks he can see do not
--      exist, which is a worse lie than the one being corrected.
--   2. IT WOULD BREAK THE LEDGER'S OWN INVARIANT. If some of those blocks have
--      already been issued to a job, the auto-correction drives the balance
--      negative — so the void would either fail anyway (with a baffling message
--      from two layers down) or violate the negative-stock rule this file
--      exists to enforce. A rule with an exception for the convenient case is
--      not a rule.
--   3. IT MATCHES THE HOUSE DOCTRINE. Every correction in this codebase is an
--      explicit, reasoned, attributed act — void-with-a-reason on a GRN, void
--      and re-record on a supplier payment. A stock correction that happened as
--      a side effect of an unrelated action would be the only silent one.
--
-- So the operator's path is: correct the stock receipt (recording WHY, and
-- proving the goods really are not there), THEN void the GRN. The guard tells
-- them exactly that. Once the GRN is voided and a corrected one is posted, its
-- NEW line ids are freely receivable — the two models compose cleanly.
--
-- Additive and reversible. To roll back:
--   drop trigger if exists goods_received_notes_stock_guard on public.goods_received_notes;
--   drop function if exists public.tg_grn_void_stock_guard();
--   drop function if exists public.record_stock_receipt_from_grn(uuid, uuid, uuid, uuid, text);
--   drop function if exists public.record_stock_issue(uuid, uuid, uuid, numeric, uuid, uuid, text);
--   drop function if exists public.record_stock_transfer(uuid, uuid, uuid, uuid, numeric, text);
--   drop function if exists public.record_stock_adjustment(uuid, uuid, uuid, numeric, text);
--   drop function if exists public.record_stock_correction(uuid, uuid, text);

-- ── 0. Shared: the per-(item, site) serialisation key ───────────────────────
-- One helper so all four write paths hash the SAME key. Two ints (the classic
-- pg_advisory_xact_lock(int4, int4) form): a domain tag, and the item+site pair.
-- IMMUTABLE + no I/O, so it is free.
create or replace function public.stock_lock_key(p_item_id uuid, p_site_id uuid)
returns integer language sql immutable set search_path = public as $$
  select hashtext(p_item_id::text || ':' || p_site_id::text);
$$;

-- ── 1. Receive a POSTED delivery line into stock (IDEMPOTENT) ───────────────
-- The GRN → stock bridge. Deliberately takes the ITEM and the SITE as
-- parameters: a purchase-order line is FREE TEXT (20261006000000), so which
-- catalogue item "Cement 25kg bags x40" is, and which yard it went into, are
-- HUMAN judgements. This function NEVER infers either from the description —
-- see the app-side note in server/services/stock.ts. Guessing wrong here does
-- not produce a slightly-off report, it produces a balance for the wrong
-- product that somebody later counts against and cannot reconcile.
--
-- The quantity is NOT a parameter: it is read from the posted line, so the
-- amount taken into stock is always exactly the amount the delivery evidence
-- says arrived, and no caller can inflate it.
create or replace function public.record_stock_receipt_from_grn(
  p_org_id      uuid,
  p_grn_line_id uuid,
  p_item_id     uuid,
  p_site_id     uuid,
  p_notes       text default null
) returns uuid
language plpgsql
as $$
declare
  v_qty        numeric(12, 2);
  v_grn_status text;
  v_existing   uuid;
  v_movement   uuid;
begin
  if p_org_id is null or p_grn_line_id is null or p_item_id is null or p_site_id is null then
    raise exception 'organisation, delivery line, item and site are all required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on the delivery line AND its note, plus the posted check, in
  -- one read. RLS admits every org the caller belongs to; p_org_id narrows that
  -- to the company they are working in, so a dual-org member cannot take
  -- another company's delivery into this company's yard.
  select grl.qty_received, gn.status
    into v_qty, v_grn_status
    from public.goods_received_lines grl
    join public.goods_received_notes gn
      on gn.id = grl.goods_received_note_id and gn.org_id = grl.org_id
   where grl.id = p_grn_line_id and grl.org_id = p_org_id;

  if v_qty is null then
    raise exception 'delivery line not found' using errcode = 'no_data_found';
  end if;
  if v_grn_status <> 'posted' then
    raise exception 'this delivery is % — post it before taking it into stock', v_grn_status
      using errcode = 'check_violation';
  end if;

  -- IDEMPOTENCY. The partial unique index (20261064000000) is the real guard —
  -- this pre-check exists so the ordinary double-submit returns the SAME
  -- movement id and a success, rather than a unique violation the caller has to
  -- interpret. A concurrent double-submit that races past this read is still
  -- caught by the index, which is why the index and not this read is the rule.
  select id into v_existing
    from public.stock_movements
   where grn_line_id = p_grn_line_id
     and movement_type = 'receipt'
     and org_id = p_org_id;
  if v_existing is not null then
    return v_existing;
  end if;

  -- The item and the site must both be in the ACTIVE org. The composite FKs
  -- prove this structurally at insert time; reading them first turns a raw
  -- 23503 into a sentence the yard can act on.
  if not exists (select 1 from public.stock_items where id = p_item_id and org_id = p_org_id) then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes, grn_line_id
  ) values (
    p_org_id, p_item_id, p_site_id, 'receipt', v_qty, auth.uid(),
    nullif(btrim(coalesce(p_notes, '')), ''), p_grn_line_id
  ) returning id into v_movement;

  return v_movement;
exception
  when unique_violation then
    -- The racing sibling won. Return ITS movement: the caller asked for the
    -- delivery to be in stock, and it is.
    select id into v_existing
      from public.stock_movements
     where grn_line_id = p_grn_line_id and movement_type = 'receipt' and org_id = p_org_id;
    if v_existing is null then raise; end if;
    return v_existing;
end $$;
grant execute on function public.record_stock_receipt_from_grn(uuid, uuid, uuid, uuid, text) to authenticated;

-- ── 2. Issue stock (out of a site, optionally to a job) ─────────────────────
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  FROZEN CONTRACT WITH THE M4 MATERIAL-REQUESTS LANE.                     ║
-- ║  `p_material_request_line_id uuid default null` is FROZEN: an OPTIONAL,  ║
-- ║  DEFAULTED, LAST-BUT-ONE parameter. M4 fulfils a request line by calling ║
-- ║  this function with it set; nothing else about their table needs to      ║
-- ║  exist for this to work today, and no existing caller has to change when ║
-- ║  it does. PostgREST resolves by NAMED argument, so the position is       ║
-- ║  irrelevant to the app and only the NAME and the DEFAULT are the         ║
-- ║  contract. Do not rename it, do not make it required, do not reorder it  ║
-- ║  ahead of a parameter without a default.                                 ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
create or replace function public.record_stock_issue(
  p_org_id  uuid,
  p_item_id uuid,
  p_site_id uuid,
  p_qty     numeric,
  p_job_id  uuid default null,
  p_material_request_line_id uuid default null,
  p_notes   text default null
) returns uuid
language plpgsql
as $$
declare
  v_qty      numeric(12, 2);
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_name     text;
begin
  v_qty := round(coalesce(p_qty, 0), 2);
  if v_qty <= 0 then
    raise exception 'enter how much is going out — the quantity must be above zero'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on both references (see record_stock_receipt_from_grn).
  select name into v_name from public.stock_items
   where id = p_item_id and org_id = p_org_id;
  if v_name is null then
    raise exception 'stock item not found' using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  -- SERIALISE the read-check-write on this exact (item, site). See the header:
  -- without it two simultaneous issues of the last 10 units both succeed.
  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(p_item_id, p_site_id)
  );

  v_balance := public.stock_balance(p_org_id, p_item_id, p_site_id);
  if v_qty > v_balance then
    raise exception
      'not enough %: % in stock at this site, % requested', v_name, v_balance, v_qty
      using errcode = 'check_violation';
  end if;

  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes,
    job_id, material_request_line_id
  ) values (
    p_org_id, p_item_id, p_site_id, 'issue', v_qty, auth.uid(),
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_job_id, p_material_request_line_id
  ) returning id into v_movement;

  return v_movement;
end $$;
grant execute on function public.record_stock_issue(uuid, uuid, uuid, numeric, uuid, uuid, text) to authenticated;

-- ── 3. Transfer between two sites — ONE transaction, TWO rows ──────────────
-- CONSERVATION is the invariant: the company's total holding of this item is
-- IDENTICAL before and after. That is why it is one function and not two calls
-- — a client-side pair can be interrupted between the two writes, and the stock
-- then exists nowhere. The two rows share `transfer_group_id`, so the pair is
-- recoverable as one event on every surface for ever after.
--
-- Only the FROM side is locked. The TO side only ever GAINS, so it cannot be
-- driven negative and needs no serialisation — and locking one side rather than
-- two removes the deadlock that ordering A→B against B→A would otherwise
-- create when two operators transfer in opposite directions at the same moment.
create or replace function public.record_stock_transfer(
  p_org_id       uuid,
  p_item_id      uuid,
  p_from_site_id uuid,
  p_to_site_id   uuid,
  p_qty          numeric,
  p_notes        text default null
) returns uuid
language plpgsql
as $$
declare
  v_qty     numeric(12, 2);
  v_balance numeric(12, 2);
  v_group   uuid := gen_random_uuid();
  v_name    text;
  v_notes   text;
begin
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
  -- BOTH sites pinned to the ACTIVE org — a transfer is the one operation that
  -- names two locations, so it is the one that could move stock into another
  -- company's yard if only one end were checked.
  if (select count(*) from public.sites
       where id in (p_from_site_id, p_to_site_id) and org_id = p_org_id) <> 2 then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

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

  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes, transfer_group_id
  ) values
    (p_org_id, p_item_id, p_from_site_id, 'transfer_out', v_qty, auth.uid(), v_notes, v_group),
    (p_org_id, p_item_id, p_to_site_id,   'transfer_in',  v_qty, auth.uid(), v_notes, v_group);

  return v_group;
end $$;
grant execute on function public.record_stock_transfer(uuid, uuid, uuid, uuid, numeric, text) to authenticated;

-- ── 4. Adjustment — ADMIN ONLY ─────────────────────────────────────────────
-- WHY THIS ONE IS GATED AND THE OTHERS ARE NOT. Every other movement has a
-- counterparty that constrains it: a receipt is capped by a posted delivery
-- line, an issue is capped by the balance, a transfer conserves. An adjustment
-- has NONE — it creates or destroys quantity on somebody's say-so alone. It is
-- therefore the write that can conceal a loss, and the reason a stock system is
-- believed or not.
--
-- The house boundary for "this assertion creates an obligation or hides a
-- discrepancy" is `is_org_admin`: `cis_subcontractors` (20261046) and
-- `supplier_payments` (20261047) are both admin-only for exactly this reason,
-- and `sites` is admin-write because a rename re-labels the estate. A member
-- can move stock all day; only an owner/admin can declare that the number was
-- wrong. The reason is structurally required by the table's CHECK, so an
-- unexplained adjustment is unrepresentable rather than merely discouraged.
--
-- JWT-GATED, the 20261034000000 asymmetry that 20261059000000 also uses: the
-- check applies to authenticated callers. `auth.uid()` is NULL for the trusted
-- service role, which reaches this only from server-side code holding the
-- secret key (imports, backfills, seeding) and is not a tenant principal.
create or replace function public.record_stock_adjustment(
  p_org_id  uuid,
  p_item_id uuid,
  p_site_id uuid,
  p_delta   numeric,
  p_reason  text
) returns uuid
language plpgsql
as $$
declare
  v_delta    numeric(12, 2);
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_name     text;
  v_reason   text;
begin
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

  -- Only a DOWNWARD adjustment can breach the floor, but the lock is taken for
  -- both: an upward adjustment racing a concurrent issue would otherwise let
  -- the issue read a balance that the adjustment had not yet committed, and the
  -- ordering of the two rows in the history would stop matching what each one
  -- was actually decided against.
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

  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes
  ) values (
    p_org_id, p_item_id, p_site_id,
    case when v_delta > 0 then 'adjustment_in' else 'adjustment_out' end,
    abs(v_delta), auth.uid(), v_reason
  ) returning id into v_movement;

  return v_movement;
end $$;
grant execute on function public.record_stock_adjustment(uuid, uuid, uuid, numeric, text) to authenticated;

-- ── 5. Correction — reverse ONE earlier movement, in full, with a reason ───
-- The ONLY way an existing movement is undone. It writes a NEW row; the
-- original stays visible for ever (20261064000000's append-only triggers make
-- that structural). `tg_stock_movements_derive` computes the exact reversing
-- effect and refuses a partial reversal, a cross-org target, a correction of a
-- correction, or a target at a different item/site; the unique index refuses a
-- second correction of the same movement. This function adds the two things a
-- trigger cannot: the ACTIVE-ORG pin, and the balance floor.
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
  v_balance  numeric(12, 2);
  v_movement uuid;
  v_reason   text;
begin
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    raise exception 'a correction needs a reason — it is the correction record'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN.
  select stock_item_id, site_id, effect
    into v_item, v_site, v_effect
    from public.stock_movements
   where id = p_movement_id and org_id = p_org_id;
  if v_item is null then
    raise exception 'stock movement not found' using errcode = 'no_data_found';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(v_item, v_site)
  );

  -- Reversing an INBOUND movement removes quantity, so it can breach the floor
  -- — that is the "the goods were issued before we found the mistake" case, and
  -- it is refused for the same reason every other outbound path is. The
  -- operator's route is then an explicit adjustment with a reason, not a
  -- silently negative balance.
  if v_effect > 0 then
    v_balance := public.stock_balance(p_org_id, v_item, v_site);
    if v_effect > v_balance then
      raise exception
        'cannot reverse % units: only % left at this site — some of it has already been used. Record an adjustment instead',
        v_effect, v_balance using errcode = 'check_violation';
    end if;
  end if;

  insert into public.stock_movements (
    org_id, stock_item_id, site_id, movement_type, qty, actor_id, notes,
    corrects_movement_id
  ) values (
    p_org_id, v_item, v_site, 'correction', abs(v_effect), auth.uid(), v_reason,
    p_movement_id
  ) returning id into v_movement;

  return v_movement;
end $$;
grant execute on function public.record_stock_correction(uuid, uuid, text) to authenticated;

-- ── 6. THE GRN VOID GUARD (see the header for the rule and its reasoning) ──
-- A SEPARATE trigger rather than an edit to void_goods_received_note(), for the
-- reason 20261061000000 states explicitly: whichever migration replaces a
-- shared function LAST silently wins, so amending 20261060000000's RPC here
-- would let a concurrent milestone erase this check without a test noticing. A
-- dedicated validator trigger cannot be erased by accident, and it also covers
-- a direct PostgREST PATCH that never goes near the RPC.
--
-- BEFORE UPDATE only — never on DELETE — so it can never sit on the
-- `delete from organizations` cascade path (the 20261052000000 lesson).
--
-- SECURITY DEFINER + pinned search_path: the check must see EVERY stock
-- movement bound to this note's lines, not the subset the caller's RLS exposes.
-- A void that succeeded because the voider could not see the receipt would be
-- the worst possible outcome.
create or replace function public.tg_grn_void_stock_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_stuck integer;
begin
  if new.status <> 'void' or old.status = 'void' then
    return new;
  end if;

  select count(*) into v_stuck
    from public.stock_movements m
    join public.goods_received_lines grl on grl.id = m.grn_line_id
   where grl.goods_received_note_id = new.id
     and m.movement_type = 'receipt'
     -- "uncorrected": no correction movement names it. Asked of ANOTHER ROW,
     -- which is exactly why this is not an index predicate (20261064000000).
     and not exists (
       select 1 from public.stock_movements c
        where c.corrects_movement_id = m.id
     );

  if v_stuck > 0 then
    raise exception
      'delivery % is in stock (% line(s)) — correct the stock receipt first, then void this delivery',
      new.number, v_stuck
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists goods_received_notes_stock_guard on public.goods_received_notes;
create trigger goods_received_notes_stock_guard
  before update on public.goods_received_notes
  for each row execute function public.tg_grn_void_stock_guard();

comment on function public.record_stock_issue(uuid, uuid, uuid, numeric, uuid, uuid, text) is
  'Issue stock out of a site. p_material_request_line_id is the FROZEN CONTRACT with the M4 material-requests lane: optional, defaulted, never renamed. Records a quantity only — no cost is posted anywhere.';
comment on function public.record_stock_adjustment(uuid, uuid, uuid, numeric, text) is
  'Admin-only. The one movement with no counterparty — it can create or destroy quantity, so it carries the is_org_admin gate and a structurally required reason.';
