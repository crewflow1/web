-- O3 OPERATIONAL STOCK — hardening: a CORRECTION may not reverse a single
-- transfer leg. Closes a proven stock-manufacture defect.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY IS UNCHANGED. This migration writes no cost, no  ║
-- ║  value and no VAT, touches `finances` nowhere, and adds no money column.  ║
-- ║  It is a quantity-conservation fix. Materials are already expensed by     ║
-- ║  recordSupplierBill, so a second posting would double-count — stock       ║
-- ║  valuation is CEO decision D1 and remains UNDECIDED.                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── THE DEFECT (proven, red before this migration) ───────────────────────────
-- A transfer is a PAIR of movements sharing `transfer_group_id`: a
-- `transfer_out` at site A (effect −qty) and a `transfer_in` at site B (effect
-- +qty). Together they CONSERVE: the company total is identical before and
-- after (20261065000000 §3).
--
-- `record_stock_correction` reverses ONE movement. Applied to a single transfer
-- leg it breaks conservation and MANUFACTURES STOCK FROM NOTHING:
--
--     seed +10 @ A                         A=10  B=0   total=10
--     transfer A→B (out@A −10, in@B +10)   A=0   B=10  total=10
--     correct ONLY the transfer_out leg    A=10  B=10  total=20   ← +10 invented
--
-- The compensating +10 lands at A while B keeps its transfer_in. The reverse
-- mistake (correcting only the transfer_in) DESTROYS 10. Neither is a
-- correction: a correction restores the truth about ONE fact, and a transfer is
-- ONE fact expressed as two rows.
--
-- Nothing stopped it — not the RPC, not `tg_stock_movements_derive`'s
-- correction branch, not the UI. And because a `correction` (unlike a
-- `record_stock_adjustment`) is member-level, a non-admin could do it and
-- conceal a physical loss under a low-scrutiny "reversal".
--
-- ── THE FIX — refused at TWO layers, structural first ────────────────────────
--   1. `tg_stock_movements_derive` (the real backstop): a correction whose
--      target carries a `transfer_group_id` is refused BEFORE its effect is
--      derived. This covers EVERY writer — the RPC, a direct PostgREST
--      correction insert (members hold an insert policy, 20261064000000 §6),
--      service_role, all of it. A single leg is structurally uncorrectable.
--   2. `record_stock_correction` (the clean message): the same refusal, raised
--      early — before the advisory lock and the floor read — so the operator
--      gets a sentence that names the honest instrument instead of a trigger
--      exception surfaced two layers down.
--
-- The HONEST INSTRUMENT is a COMPENSATING TRANSFER the other way (B→A), which
-- is itself a conserving pair — so the fix does not remove the ability to undo
-- a wrong transfer, it points at the only tool that undoes it without inventing
-- or destroying quantity. `record_stock_transfer` already exists and already
-- refuses a negative balance on the leaving side, so the goods that were moved
-- can always be moved back and nothing else can.
--
-- ── THE ADMIN-GATE QUESTION, DECIDED DELIBERATELY: corrections stay MEMBER-LEVEL
-- `record_stock_adjustment` is admin-only because it is the one movement with
-- NO COUNTERPARTY — it creates or destroys quantity on an assertion alone, so
-- it is the write that can silently conceal a loss, and only an owner/admin may
-- make it (20261065000000 §4). A `correction` is a DIFFERENT animal and does
-- NOT get that gate, for three reasons that only ALL hold once transfer legs
-- are refused above:
--
--   · IT HAS A COUNTERPARTY. A correction always names an existing movement and
--     reverses exactly it, in full (the derive trigger enforces whole-movement,
--     same-item, same-site). It cannot invent a quantity out of nothing the way
--     an adjustment can — with transfer legs now refused, every remaining target
--     (receipt / issue / adjustment) is a bounded, already-recorded fact.
--   · IT CANNOT GO NEGATIVE. Reversing an INBOUND movement is floored against
--     the live balance (the `v_effect > 0` check below), exactly as every other
--     outbound path is. A correction can never drive a site below zero.
--   · IT CANNOT BE SILENT. The ledger is append-only (20261064000000): the
--     original movement stays visible for ever, AND every correction is written
--     to `activity_log` by `_tg_stock_movements_activity`. A reversal is
--     therefore two permanent, attributed facts in the owner's own feed — the
--     precise opposite of a concealed one. The property the adjustment gate
--     exists to protect (no silent loss) is already held here by construction.
--
-- So a storeman may still fix their own same-shift slip — an issue booked to the
-- wrong job, a mis-keyed receipt — without hunting down an admin, and nothing
-- they can do with a correction manufactures, hides or negatives stock. If a
-- future policy wants corrections admin-gated too, this function and the trigger
-- are the two places it goes; it is a one-line `is_org_admin` check in each,
-- deliberately NOT added today.
--
-- ── Additive and reversible. To roll back to the 20261064/65 behaviour:
--   (restore tg_stock_movements_derive WITHOUT the transfer_group_id branch from
--    20261064000000, and record_stock_correction WITHOUT the v_group read from
--    20261065000000 — both are reproduced verbatim below apart from the guard.)

-- ── 1. Structural backstop: the derivation trigger refuses a transfer-leg target
-- Reproduces public.tg_stock_movements_derive (20261064000000) VERBATIM except
-- for the single new `v_group` read and its refusal in the correction branch.
create or replace function public.tg_stock_movements_derive()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid;
  v_effect numeric(12, 2);
  v_type   text;
  v_group  uuid;
begin
  -- job_id org guard. RLS checks the ROW's org, never the org of the thing it
  -- points at; without this an issue in org A could be attributed to org B's
  -- job and leak that job's existence back through the movement history.
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'job % is not in org %', new.job_id, new.org_id
        using errcode = 'check_violation';
    end if;
  end if;

  -- THE SIGN. Assigned unconditionally, so a caller cannot supply it.
  if new.movement_type in ('receipt', 'transfer_in', 'adjustment_in') then
    new.effect := new.qty;
  elsif new.movement_type in ('issue', 'transfer_out', 'adjustment_out') then
    new.effect := - new.qty;
  else
    -- correction: the exact reversal of the movement it names. The composite FK
    -- already proves same-org; this reads the target's own signed effect so the
    -- pair always sums to zero, whichever direction the original went.
    select effect, movement_type, transfer_group_id into v_effect, v_type, v_group
      from public.stock_movements
     where id = new.corrects_movement_id and org_id = new.org_id;
    if v_effect is null then
      raise exception 'movement % cannot be corrected — it is not in org %',
        new.corrects_movement_id, new.org_id using errcode = 'check_violation';
    end if;
    if v_type = 'correction' then
      raise exception 'a correction cannot be corrected — reverse the original movement instead'
        using errcode = 'check_violation';
    end if;
    -- A TRANSFER LEG IS NOT CORRECTABLE ALONE. Reversing one leg of a
    -- conserving pair invents stock at one site (or destroys it at the other).
    -- The honest reversal of a transfer is a compensating transfer the other
    -- way — itself a conserving pair. Structural, so it also refuses a direct
    -- PostgREST correction insert, not only the RPC.
    if v_group is not null then
      raise exception
        'movement % is one leg of a transfer — record a compensating transfer instead of correcting a single leg',
        new.corrects_movement_id using errcode = 'check_violation';
    end if;
    -- The reversal must be the WHOLE movement. A partial reversal is an
    -- adjustment with a reason, not a correction.
    if new.qty is distinct from abs(v_effect) then
      raise exception 'a correction reverses the whole movement (% units), not %',
        abs(v_effect), new.qty using errcode = 'check_violation';
    end if;
    -- The correction must sit at the SAME item and site as the movement it
    -- reverses, or it moves a balance somewhere the original never touched.
    if not exists (
      select 1 from public.stock_movements
       where id = new.corrects_movement_id
         and stock_item_id = new.stock_item_id
         and site_id = new.site_id
    ) then
      raise exception 'a correction must name the same item and site as the movement it reverses'
        using errcode = 'check_violation';
    end if;
    new.effect := - v_effect;
  end if;

  return new;
end $$;

-- ── 2. Clean early refusal in the RPC (before the lock and the floor read) ───
-- Reproduces public.record_stock_correction (20261065000000) VERBATIM except
-- for the single new `v_group` read and its early refusal. SECURITY INVOKER is
-- preserved (no `security definer`), so the caller's RLS and every guard trigger
-- still apply — this is not a privileged back door.
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

  -- A SINGLE TRANSFER LEG IS NOT CORRECTABLE (see the header). Refused here for
  -- a clear message, and again structurally by tg_stock_movements_derive.
  if v_group is not null then
    raise exception
      'this is one leg of a transfer — move it back with a compensating transfer, which keeps both sites in balance; correcting a single leg would create stock at one site'
      using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('stock_balance'), public.stock_lock_key(v_item, v_site)
  );

  -- Reversing an INBOUND movement removes quantity, so it can breach the floor
  -- — that is the "the goods were issued before we found the mistake" case, and
  -- it is refused for the same reason every other outbound path is.
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

comment on function public.record_stock_correction(uuid, uuid, text) is
  'Reverse ONE earlier movement in full, with a reason. Refuses a single transfer leg (record a compensating transfer instead — 20261069000000). Member-level: a correction has a counterparty, is floored, and is append-only + activity-logged, so it cannot silently manufacture or conceal stock.';
