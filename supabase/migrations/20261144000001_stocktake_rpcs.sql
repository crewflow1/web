-- O3 OPERATIONAL STOCK — STOCKTAKE WRITE PATHS (part 2 of 2).
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — RESTATED. Every function here writes only     ║
-- ║  stocktake rows and, at post time, stock_movements ADJUSTMENTS through   ║
-- ║  record_stock_adjustment. NONE touches `public.finances`, none carries a ║
-- ║  price/cost/VAT, none computes a valuation. A variance is a QUANTITY     ║
-- ║  difference; posting it double-counts nothing because materials are      ║
-- ║  already expensed by recordSupplierBill. Stock valuation is CEO decision ║
-- ║  D1 and is UNDECIDED; a stocktake valuation report is out of scope.      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- FOUR SECURITY INVOKER functions — the 20261065000000 posture. The caller's
-- RLS, every composite FK and every guard trigger STILL APPLY, so none is a
-- privileged back door. They exist for the things a client statement sequence
-- cannot do safely:
--
--   · open   — snapshot every item's expected quantity in ONE consistent read,
--              and stamp the crewflow.stocktake_open marker the line-insert
--              guard requires, so the snapshot is the only legal way lines appear.
--   · count  — flip a session to `counting` and record a count, refusing both if
--              the session is not open for counting.
--   · post   — ATOMICALLY post every variance as an adjustment movement (through
--              the admin-gated, floor-checked, lock-taking record_stock_adjustment)
--              and move the session to `posted`. All-or-nothing: a floor breach on
--              any line rolls the whole post back, so a session is never half
--              posted.
--   · cancel — abandon an open/counting session.
--
-- POSTING REUSES record_stock_adjustment (20261071000000), it does not re-insert
-- movements itself. That is deliberate: the adjustment path already owns the
-- admin gate, the per-(item, site) advisory lock, the negative-stock floor, the
-- crewflow.stock_write authorised-write marker and the activity-log write. A
-- second insert path would be a second place all of those could be wrong.
--
-- VARIANCE = counted − expected(snapshot). The snapshot is frozen at open, so
-- the variance is deterministic; posting it as the adjustment delta brings the
-- balance to the counted figure when nothing else moved in between (the normal
-- case — a count freezes the place). If something did move, the floor check
-- still protects the ledger and the operator recounts.
--
-- Additive and reversible. To roll back:
--   drop function if exists public.cancel_stocktake_session(uuid, uuid, text);
--   drop function if exists public.post_stocktake_session(uuid, uuid);
--   drop function if exists public.record_stocktake_count(uuid, uuid, uuid, numeric);
--   drop function if exists public.start_stocktake_counting(uuid, uuid);
--   drop function if exists public.open_stocktake_session(uuid, uuid, text, text);

-- ── 1. OPEN — snapshot the site, freeze expected quantities ─────────────────
-- Snapshots EVERY active item plus any inactive item still holding a balance at
-- the site (so a discontinued product sitting on a shelf can still be counted to
-- zero). expected_qty is sum(effect) at open — read once, frozen for ever.
create or replace function public.open_stocktake_session(
  p_org_id    uuid,
  p_site_id   uuid,
  p_reference text default null,
  p_notes     text default null
) returns uuid
language plpgsql
as $$
declare
  v_session uuid;
  v_ref     text;
  v_notes   text;
begin
  if p_org_id is null or p_site_id is null then
    raise exception 'organisation and site are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on the site. RLS admits every org the caller belongs to;
  -- p_org_id narrows to the company being worked in.
  if not exists (select 1 from public.sites where id = p_site_id and org_id = p_org_id) then
    raise exception 'site not found' using errcode = 'no_data_found';
  end if;

  v_ref   := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  insert into public.stocktake_sessions (org_id, site_id, reference, status, notes, opened_by)
  values (p_org_id, p_site_id, v_ref, 'open', v_notes, auth.uid())
  returning id into v_session;

  -- The marker the line-insert guard requires. Transaction-local, naming THIS
  -- session, so it cannot authorise an insert into a different one.
  perform set_config('crewflow.stocktake_open', v_session::text, true);

  insert into public.stocktake_lines (org_id, session_id, stock_item_id, expected_qty)
  select p_org_id, v_session, si.id,
         coalesce((
           select sum(m.effect)
             from public.stock_movements m
            where m.org_id = p_org_id
              and m.stock_item_id = si.id
              and m.site_id = p_site_id
         ), 0)::numeric(12, 2)
    from public.stock_items si
   where si.org_id = p_org_id
     and (
       si.active = true
       or exists (
         select 1 from public.stock_movements m2
          where m2.org_id = p_org_id and m2.stock_item_id = si.id and m2.site_id = p_site_id
       )
     );

  perform set_config('crewflow.stocktake_open', '', true);

  return v_session;
end $$;
grant execute on function public.open_stocktake_session(uuid, uuid, text, text) to authenticated;

-- ── 2. START COUNTING — open → counting ─────────────────────────────────────
create or replace function public.start_stocktake_counting(
  p_org_id     uuid,
  p_session_id uuid
) returns text
language plpgsql
as $$
declare
  v_status text;
begin
  select status into v_status from public.stocktake_sessions
   where id = p_session_id and org_id = p_org_id
   for update;
  if v_status is null then
    raise exception 'stocktake not found' using errcode = 'no_data_found';
  end if;
  if v_status = 'counting' then
    return 'counting'; -- idempotent: already counting
  end if;
  if v_status <> 'open' then
    raise exception 'a % stocktake cannot be reopened for counting', v_status
      using errcode = 'check_violation';
  end if;

  update public.stocktake_sessions set status = 'counting'
   where id = p_session_id and org_id = p_org_id;
  return 'counting';
end $$;
grant execute on function public.start_stocktake_counting(uuid, uuid) to authenticated;

-- ── 3. RECORD A COUNT — set counted_qty on one line ─────────────────────────
-- Refuses an item that was not part of the snapshot (added after open): the
-- snapshot is frozen, so a late item is a deliberate refusal, not a silent new
-- line with an unfrozen expected. Pass null to clear a count (mis-scan undo).
create or replace function public.record_stocktake_count(
  p_org_id       uuid,
  p_session_id   uuid,
  p_stock_item_id uuid,
  p_counted_qty  numeric
) returns uuid
language plpgsql
as $$
declare
  v_status text;
  v_line   uuid;
  v_qty    numeric(12, 2);
begin
  if p_stock_item_id is null then
    raise exception 'pick an item to count' using errcode = 'invalid_parameter_value';
  end if;
  if p_counted_qty is not null then
    v_qty := round(p_counted_qty, 2);
    if v_qty < 0 then
      raise exception 'a count cannot be negative' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select status into v_status from public.stocktake_sessions
   where id = p_session_id and org_id = p_org_id;
  if v_status is null then
    raise exception 'stocktake not found' using errcode = 'no_data_found';
  end if;
  if v_status <> 'counting' then
    raise exception 'this stocktake is not open for counting (it is %)', v_status
      using errcode = 'check_violation';
  end if;

  update public.stocktake_lines
     set counted_qty = v_qty,
         counted_at  = case when v_qty is null then null else now() end,
         counted_by  = case when v_qty is null then null else auth.uid() end
   where session_id = p_session_id
     and stock_item_id = p_stock_item_id
     and org_id = p_org_id
  returning id into v_line;

  if v_line is null then
    raise exception 'that item was not part of this stocktake — it may have been added after the count started'
      using errcode = 'no_data_found';
  end if;

  return v_line;
end $$;
grant execute on function public.record_stocktake_count(uuid, uuid, uuid, numeric) to authenticated;

-- ── 4. POST — variances → adjustment movements, session → posted ────────────
-- ADMIN ONLY, three times over: an explicit check here (clean message), the
-- record_stock_adjustment gate on every movement, and the transition trigger on
-- the session. ATOMIC: one transaction, so a floor breach on any line rolls the
-- whole post back — a session is never half posted. IDEMPOTENT: the session is
-- locked FOR UPDATE and must be `counting`, so a concurrent double-post finds
-- `posted` and is refused.
create or replace function public.post_stocktake_session(
  p_org_id     uuid,
  p_session_id uuid
) returns integer
language plpgsql
as $$
declare
  v_status  text;
  v_site    uuid;
  v_ref     text;
  v_counted integer;
  v_posted  integer := 0;
  v_reason  text;
  v_mv      uuid;
  v_var     numeric(12, 2);
  r         record;
begin
  if auth.uid() is not null and not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can post a stocktake'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock the session so a concurrent post serialises on this row.
  select status, site_id, reference into v_status, v_site, v_ref
    from public.stocktake_sessions
   where id = p_session_id and org_id = p_org_id
   for update;
  if v_status is null then
    raise exception 'stocktake not found' using errcode = 'no_data_found';
  end if;
  if v_status <> 'counting' then
    raise exception 'a % stocktake cannot be posted — it is posted from counting', v_status
      using errcode = 'check_violation';
  end if;

  select count(*) into v_counted from public.stocktake_lines
   where session_id = p_session_id and org_id = p_org_id and counted_qty is not null;
  if v_counted = 0 then
    raise exception 'count at least one item before posting'
      using errcode = 'check_violation';
  end if;

  -- The marker the line posted_* write AND the session → posted transition need.
  perform set_config('crewflow.stocktake_post', p_session_id::text, true);

  -- Every counted line whose count differs from its frozen snapshot. Ordered by
  -- id so the movements land in a deterministic order.
  for r in
    select id, stock_item_id, expected_qty, counted_qty
      from public.stocktake_lines
     where session_id = p_session_id
       and org_id = p_org_id
       and counted_qty is not null
       and counted_qty <> expected_qty
     order by id
  loop
    v_var := round(r.counted_qty - r.expected_qty, 2);
    if v_var = 0 then
      continue;
    end if;
    v_reason := left(
      'Stocktake ' || coalesce(v_ref, p_session_id::text)
      || ': counted ' || r.counted_qty || ', expected ' || r.expected_qty,
      2000
    );

    -- Through the ledger's own admin-gated, lock-taking, floor-checked path.
    v_mv := public.record_stock_adjustment(p_org_id, r.stock_item_id, v_site, v_var, v_reason);

    update public.stocktake_lines
       set posted_movement_id = v_mv, posted_variance = v_var
     where id = r.id and org_id = p_org_id;

    v_posted := v_posted + 1;
  end loop;

  update public.stocktake_sessions
     set status = 'posted', posted_by = auth.uid(), posted_at = now()
   where id = p_session_id and org_id = p_org_id;

  perform set_config('crewflow.stocktake_post', '', true);

  return v_posted;
end $$;
grant execute on function public.post_stocktake_session(uuid, uuid) to authenticated;

-- ── 5. CANCEL — abandon an open/counting session ────────────────────────────
create or replace function public.cancel_stocktake_session(
  p_org_id     uuid,
  p_session_id uuid,
  p_reason     text default null
) returns text
language plpgsql
as $$
declare
  v_status text;
  v_notes  text;
begin
  select status, notes into v_status, v_notes from public.stocktake_sessions
   where id = p_session_id and org_id = p_org_id
   for update;
  if v_status is null then
    raise exception 'stocktake not found' using errcode = 'no_data_found';
  end if;
  if v_status in ('posted', 'cancelled') then
    raise exception 'a % stocktake cannot be cancelled', v_status
      using errcode = 'check_violation';
  end if;

  update public.stocktake_sessions
     set status = 'cancelled',
         cancelled_by = auth.uid(),
         cancelled_at = now(),
         notes = case
                   when nullif(btrim(coalesce(p_reason, '')), '') is null then notes
                   else left(coalesce(notes || E'\n', '') || 'Cancelled: ' || btrim(p_reason), 2000)
                 end
   where id = p_session_id and org_id = p_org_id;
  return 'cancelled';
end $$;
grant execute on function public.cancel_stocktake_session(uuid, uuid, text) to authenticated;

comment on function public.post_stocktake_session(uuid, uuid) is
  'Admin-only. Posts every counted line''s variance (counted − frozen expected) as an adjustment movement through record_stock_adjustment, then moves the session to posted. Atomic and idempotent. Records quantities only — no cost is posted anywhere (D1 undecided).';
