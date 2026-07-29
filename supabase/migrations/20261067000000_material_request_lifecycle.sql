-- M4 — Material requests (part 2: the LIFECYCLE and the FULFILMENT SEAM).
--
-- 20261066 gave the ask a record. This migration makes it TELL THE TRUTH about
-- where it has got to:
--
--   1. A DB-LEVEL TRANSITION TRIGGER. The graph existed only as a product
--      intention. Direct PostgREST — /rest/v1/material_requests?id=eq.X with
--      {"status":"approved"} — bypassed every app check, so any member holding
--      a JWT could approve their own request for £4,000 of materials. That is
--      the same "the app path is safe, the DB is the real backstop" gap
--      20261060 closed for purchase orders and 20261034 for RAMS.
--
--   2. ROLE ENFORCEMENT IN THE DATABASE. Who may walk which edge is part of
--      the graph, not a separate concern, so it lives in the same trigger.
--      RLS cannot express it: a policy sees OLD or NEW, never both.
--
--   3. THE FULFILMENT SEAM — and an honest account of what it can and cannot
--      guarantee today. See the long note below; it is the most important
--      thing in this file.
--
-- THE TRANSITION GRAPH
--   draft                → submitted | cancelled
--   submitted            → approved  | rejected | cancelled
--   approved             → partially_fulfilled | fulfilled | cancelled
--   partially_fulfilled  → fulfilled | cancelled
--   fulfilled / rejected / cancelled  → TERMINAL, nothing leaves them
-- Everything else is refused. There is no edge back to 'draft': once the
-- office has seen the ask, editing it in place would change what was approved.
--
-- WHO MAY WALK EACH EDGE
--   submit  (draft → submitted)        the requester (or their creator), or an admin
--   approve (submitted → approved)     ADMIN ONLY (owner/admin)
--   reject  (submitted → rejected)     ADMIN ONLY, reason structurally required (20261066)
--   cancel  PRE-approval                the requester (their own), or an admin
--   cancel  POST-approval               ADMIN ONLY — once the office has committed
--                                       to buying it, standing it down is an
--                                       office decision, not a site one
--   fulfil  (→ partially_fulfilled / fulfilled)   DERIVED. Nobody sets it by hand.
--
-- Justified from the role model, not invented: `ctx.membership.role` is
-- ('owner','admin','staff') and the house gate for a decision that commits the
-- company is owner/admin — approveExpenseDraft (server/services/expense-drafts.ts)
-- and reviewLeaveRequest (app/(app)/staff/actions.ts) both gate exactly this
-- way, and leave_requests is the closest analogue in the product: a member
-- raises, an admin decides, the raiser may withdraw while it is still pending.
-- `public.is_org_admin(org_id)` is the DB mirror of that same predicate.
--
-- SERVICE-ROLE ASYMMETRY: every ROLE check is skipped when `auth.uid()` is
-- null. Seeds, backfills and cron run as the trusted service role and must be
-- able to construct historical states; a JWT holder gets the full gate. The
-- GRAPH is enforced for everyone, service role included — a bad shape is a bad
-- shape no matter who writes it. Same asymmetry as tg_ra_lifecycle (20261034)
-- and tg_goods_received_note_lifecycle (20261059).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE FULFILMENT SEAM — WHAT IS AND IS NOT GUARANTEED HERE
-- ═══════════════════════════════════════════════════════════════════════════
-- Fulfilment truth is DERIVED from stock issue movements that carry a
-- material_request_line_id. Those movements live in a CONCURRENT LANE
-- (stock_items / stock_movements / record_stock_issue) which does not exist on
-- this branch, and whose movement shape — the quantity column's name, and
-- crucially its SIGN CONVENTION for an issue — is NOT part of the frozen
-- cross-lane contract. Only the linkage column is frozen.
--
-- SO THE DERIVATION IS DELIBERATELY **NOT** WRITTEN IN SQL HERE. A derivation
-- built on guessed column names is not a safety net, it is a landmine: if this
-- lane guesses that an issue is a positive `qty` and that lane stores it as a
-- negative delta, the "backstop" would start REFUSING legitimate transitions
-- in production the day the two branches merge. A wrong backstop is strictly
-- worse than an absent one. (Contrast po_receipt_state(), 20261060, which
-- derives in SQL precisely because both sides of that seam are in one lane.)
--
-- WHAT THIS MIGRATION DOES INSTEAD — three real, testable guarantees:
--
--   a) The two derived statuses are UNREACHABLE by ordinary writes. The
--      transition trigger refuses 'partially_fulfilled' / 'fulfilled' unless
--      the transaction carries a marker that ONLY
--      advance_material_request_fulfilment() sets. So a member with a raw JWT
--      cannot PostgREST their request to 'fulfilled', and there is exactly ONE
--      writer of those two values in the entire system — a one-line audit
--      rather than a grep. (Transaction-local GUC via set_config(..., true);
--      the current_setting(x, true) idiom already ships in
--      20260720010000_hq_event_spine_producers.)
--
--   b) The STATUS ARITHMETIC lives in the database, once. The RPC — not the
--      caller — decides whether a set of fulfilled quantities means 'partial'
--      or 'full', using the same every-line-must-be-satisfied rule as
--      po_receipt_state(). The app cannot assert a status; it can only supply
--      quantities and be told what they mean. Two definitions of "fulfilled"
--      that could ever drift is how a page ends up disagreeing with the badge
--      beside it.
--
--   c) The quantities the app supplies are STRUCTURALLY VALIDATED: every line
--      id must belong to THIS request in THIS org, and no quantity may be
--      negative. A caller cannot advance a request by naming another tenant's
--      lines.
--
-- WHAT REMAINS TRUSTED, STATED PLAINLY: the app supplies the summed
-- quantities, because only the app can read a schema that is not frozen yet.
-- A compromised server action could therefore supply quantities that no
-- movement supports. That is the SAME trust boundary as every `p_org_id`
-- argument in this schema (post_goods_received_note, purchase_order_receipt_state
-- …) — the server action is trusted to state the active org honestly. When the
-- stock lane merges, closing this is a ~15-line change confined to the RPC
-- below: replace the p_fulfilled argument with a direct read of
-- stock_movements. Nothing else in this milestone moves. That is the whole
-- reason the seam is a single RPC rather than an UPDATE spread across actions.
--
-- Additive and reversible: two functions, one trigger.

-- ── 1. The status arithmetic — one definition, in the database ─────────────
-- Mirrors po_receipt_state()'s rule EXACTLY: 'none' when nothing has been
-- issued at all; 'full' only when EVERY requested line is satisfied (a total
-- that happens to add up is not enough — 100 of line A and 0 of line B is
-- still a part fulfilment); 'partial' otherwise.
--
-- OVER-ISSUE IS CLAMPED, NOT REFUSED. Over-receipt on a purchase order is
-- refused (20261060 note 4) because it misstates a supplier's invoice — money.
-- Over-ISSUE against a material request is different: the stores may
-- legitimately hand out 25 bags against a request for 20, and that is the
-- STOCK lane's decision to police against its own on-hand balance. From this
-- side it simply means the ask is satisfied. So each line is capped at what
-- was requested before the comparison, and the surplus is reported separately
-- rather than being allowed to make `sum >= total` paper over a short line.
--
-- INTERNAL: EXECUTE revoked from authenticated (the 20260708000001 lock-down
-- idiom) so a JWT cannot probe another tenant's request id for its shape. App
-- callers reach it through the tenancy-checked WRAPPER below — the exact
-- po_receipt_state / purchase_order_receipt_state pairing from 20261060.
--
-- The pairing is load-bearing, not decoration: advance_material_request_
-- fulfilment() is SECURITY INVOKER (so the caller's RLS still governs the
-- UPDATE), which means it executes AS the caller — and a caller holding a
-- plain `authenticated` JWT cannot execute a function this migration has
-- revoked from them. Calling the internal function directly from the RPC
-- therefore fails with 42501 for every real user while passing as a superuser
-- in psql. Caught by __tests__/integration/rls/material-requests.test.ts,
-- which drives the RPC with a real JWT.
create or replace function public.material_request_state(
  p_request_id uuid,
  -- [{ "line_id": uuid, "qty": numeric }, ...] — summed issue quantities.
  p_fulfilled  jsonb
)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_lines   int;
  v_short   int;
  v_any     numeric;
begin
  select count(*) into v_lines
    from public.material_request_lines where material_request_id = p_request_id;
  if v_lines = 0 then
    return 'none';
  end if;

  with got as (
    select (elem ->> 'line_id')::uuid as line_id,
           greatest(round((elem ->> 'qty')::numeric, 2), 0) as qty
      from jsonb_array_elements(coalesce(p_fulfilled, '[]'::jsonb)) as elem
  ),
  -- Sum first, THEN clamp per line: two issues of 10 against a line of 20 is
  -- complete, and clamping each issue individually would lose that.
  summed as (
    select line_id, sum(qty) as qty from got group by line_id
  ),
  per_line as (
    select li.id,
           li.qty as requested,
           least(coalesce(s.qty, 0), li.qty) as counted,
           coalesce(s.qty, 0) as raw
      from public.material_request_lines li
      left join summed s on s.line_id = li.id
     where li.material_request_id = p_request_id
  )
  select count(*) filter (where counted < requested - 0.005),
         coalesce(sum(raw), 0)
    into v_short, v_any
    from per_line;

  if v_any <= 0.005 then return 'none'; end if;
  if v_short = 0 then return 'full'; end if;
  return 'partial';
end $$;
revoke execute on function public.material_request_state(uuid, jsonb) from public, anon, authenticated;

-- ── 1b. The tenancy-checked wrapper app callers may execute ────────────────
-- Mirrors purchase_order_receipt_state (20261060). p_org_id is the ACTIVE org:
-- passing one the caller is not a member of raises, so a fulfilment position
-- can never be computed for a request outside the company they are working in.
-- SECURITY DEFINER, so it may call the revoked internal function above.
create or replace function public.material_request_fulfilment_state(
  p_request_id uuid,
  p_org_id     uuid,
  p_fulfilled  jsonb
)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'material request not found' using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from public.material_requests where id = p_request_id and org_id = p_org_id
  ) then
    raise exception 'material request not found' using errcode = 'no_data_found';
  end if;
  return public.material_request_state(p_request_id, p_fulfilled);
end $$;
grant execute on function public.material_request_fulfilment_state(uuid, uuid, jsonb)
  to authenticated;

-- ── 2. THE single writer of the two derived statuses ───────────────────────
-- SECURITY INVOKER (the transfer_asset_assignment precedent, 20260925): the
-- caller's RLS, the org-integrity guard, the lifecycle trigger and the
-- transition trigger ALL still apply. This function's only privilege is that
-- it sets the transaction marker the transition trigger looks for — it grants
-- no visibility the caller did not already have.
--
-- Returns the status the request now holds, so the caller renders what the
-- database decided rather than what it hoped for.
create or replace function public.advance_material_request_fulfilment(
  p_request_id uuid,
  p_org_id     uuid,
  p_fulfilled  jsonb
) returns text
language plpgsql
as $$
declare
  v_status text;
  v_state  text;
  v_target text;
  v_bad    uuid;
begin
  if p_request_id is null or p_org_id is null then
    raise exception 'org and material request are required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN. RLS admits every org the caller belongs to; p_org_id
  -- narrows that to the one company they are working in, so a dual-org user
  -- cannot advance the other company's request.
  select status into v_status
    from public.material_requests
   where id = p_request_id and org_id = p_org_id;
  if v_status is null then
    raise exception 'material request not found' using errcode = 'no_data_found';
  end if;

  -- Only a live, approved request has a fulfilment position at all. Calling
  -- this on a draft/submitted/terminal request is a caller bug, not a no-op.
  if v_status not in ('approved', 'partially_fulfilled') then
    raise exception 'a % material request has no fulfilment position', v_status
      using errcode = 'check_violation';
  end if;

  -- Every named line must belong to THIS request in THIS org (seam note c).
  select (elem ->> 'line_id')::uuid into v_bad
    from jsonb_array_elements(coalesce(p_fulfilled, '[]'::jsonb)) as elem
   where not exists (
     select 1 from public.material_request_lines li
      where li.id = (elem ->> 'line_id')::uuid
        and li.material_request_id = p_request_id
        and li.org_id = p_org_id
   )
   limit 1;
  if v_bad is not null then
    raise exception 'line % is not on this material request', v_bad
      using errcode = 'check_violation';
  end if;

  -- Through the GRANTED wrapper, never the revoked internal function: this
  -- body runs as the CALLER (SECURITY INVOKER), so a direct call would be
  -- 42501 for every real JWT.
  v_state := public.material_request_fulfilment_state(p_request_id, p_org_id, p_fulfilled);
  v_target := case v_state when 'full' then 'fulfilled'
                           when 'partial' then 'partially_fulfilled'
                           else 'approved' end;

  if v_target = v_status then
    return v_status;   -- nothing moved; don't churn updated_at or the feed
  end if;

  -- 'approved' is not reachable BACKWARDS from partially_fulfilled: an issue
  -- that has happened cannot un-happen from this side (a stock correction is
  -- the stock lane's reversal movement, which will simply re-derive here).
  if v_target = 'approved' then
    return v_status;
  end if;

  -- The marker the transition trigger requires. Transaction-local (the third
  -- argument to set_config), so it cannot leak into another statement on a
  -- pooled connection, and it names the specific request so it cannot be used
  -- to wave a DIFFERENT row through in the same transaction.
  perform set_config('crewflow.mr_fulfilment', p_request_id::text, true);

  update public.material_requests
     set status = v_target
   where id = p_request_id and org_id = p_org_id;

  -- Retire the marker immediately: it authorises exactly one statement.
  perform set_config('crewflow.mr_fulfilment', '', true);

  return v_target;
end $$;
grant execute on function public.advance_material_request_fulfilment(uuid, uuid, jsonb) to authenticated;

-- ── 3. The transition trigger — the graph and the roles, enforced at the DB ─
create or replace function public.tg_material_request_transition()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_admin   boolean;
  v_jwt     boolean;
  v_own     boolean;
  v_marker  text;
begin
  if new.status is not distinct from old.status then
    return new; -- ordinary field edit; the lifecycle trigger polices those
  end if;

  v_jwt   := auth.uid() is not null;
  v_admin := (not v_jwt) or public.is_org_admin(new.org_id);
  v_own   := (not v_jwt)
             or old.requested_by = auth.uid()
             or old.created_by   = auth.uid();

  -- ── Terminal states are frozen ─────────────────────────────────────────
  if old.status in ('fulfilled', 'rejected', 'cancelled') then
    raise exception 'material request %: % is final', old.id, old.status
      using errcode = 'check_violation';
  end if;

  -- ── The derived statuses: only ever reached through the RPC ────────────
  if new.status in ('partially_fulfilled', 'fulfilled') then
    v_marker := coalesce(current_setting('crewflow.mr_fulfilment', true), '');
    if v_marker <> new.id::text then
      raise exception
        'material request %: fulfilment is DERIVED from stock issues, not set by hand', old.id
        using errcode = 'check_violation';
    end if;
    -- ...and only from a live, approved position.
    if not (
         (old.status = 'approved'            and new.status in ('partially_fulfilled', 'fulfilled'))
      or (old.status = 'partially_fulfilled' and new.status = 'fulfilled')
    ) then
      raise exception 'material request %: % -> % is not a legal transition',
        old.id, old.status, new.status using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── Cancelling ─────────────────────────────────────────────────────────
  if new.status = 'cancelled' then
    if old.status in ('draft', 'submitted') then
      -- Pre-approval: the requester may withdraw their own ask (the
      -- cancelLeaveRequest precedent), and an admin may stand any down.
      if not (v_own or v_admin) then
        raise exception 'material request %: only the requester or an admin can cancel it', old.id
          using errcode = 'insufficient_privilege';
      end if;
    elsif not v_admin then
      -- Post-approval the office has committed to sourcing it; standing that
      -- down is an office decision.
      raise exception 'material request %: an approved request can only be cancelled by an admin', old.id
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- ── Submitting ─────────────────────────────────────────────────────────
  if old.status = 'draft' and new.status = 'submitted' then
    if not (v_own or v_admin) then
      raise exception 'material request %: you can only submit your own request', old.id
        using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from public.material_request_lines
                    where material_request_id = new.id) then
      raise exception 'cannot submit an empty material request — add what you need first'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── Deciding ───────────────────────────────────────────────────────────
  if old.status = 'submitted' and new.status in ('approved', 'rejected') then
    if not v_admin then
      raise exception 'material request %: only an owner or admin can approve or reject it', old.id
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- ── Everything else ────────────────────────────────────────────────────
  -- Includes every route back to 'draft' (an ask the office has seen cannot be
  -- edited in place) and every skip (draft -> approved, submitted -> fulfilled).
  raise exception 'material request %: % -> % is not a legal transition',
    old.id, old.status, new.status using errcode = 'check_violation';
end $$;

drop trigger if exists material_requests_transition on public.material_requests;
create trigger material_requests_transition
  before update on public.material_requests
  for each row execute function public.tg_material_request_transition();
