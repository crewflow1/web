-- O3 OPERATIONAL STOCK + M4 MATERIAL REQUESTS — RESIDUAL HARDENING.
--
-- Closes the four residuals a fresh adversarial review left open across
-- 20261063–65 (stock), 20261066–67 (material requests) and 20261069 (the
-- transfer-correction guard). All of those are LIVE; every table both lanes
-- deferred an FK to now exists in the same database, so the seams they had to
-- leave open can finally be closed structurally.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY IS UNCHANGED AND UNTOUCHED.                     ║
-- ║                                                                          ║
-- ║  Stock remains an OPERATIONAL QUANTITY LEDGER. This migration adds no    ║
-- ║  money column, no unit cost, no VAT and no valuation; it writes nothing  ║
-- ║  to `public.finances`, puts no trigger on it, and names it nowhere in    ║
-- ║  an executable statement. Materials are ALREADY expensed by              ║
-- ║  recordSupplierBill (20261009000000), so a second posting at receipt or  ║
-- ║  at issue would double-count the same spend and silently inflate the     ║
-- ║  cost of sale on every affected job. Stock valuation / COGS-on-issue is  ║
-- ║  CEO decision D1 and remains UNDECIDED.                                  ║
-- ║                                                                          ║
-- ║  Enforced, not merely stated: __tests__/security/operational-stock.test  ║
-- ║  .ts now includes THIS FILE in the surfaces it sweeps for `finances`.    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §1  THE TWO DEFERRED COMPOSITE FKs — the cross-lane seam, closed
-- ═══════════════════════════════════════════════════════════════════════════
-- Two uuid columns pointed at each other with NO referential integrity in
-- either direction, because the two lanes were built in parallel and neither
-- table existed on the other's branch:
--
--   stock_movements.material_request_line_id  → material_request_lines
--   material_request_lines.stock_item_id      → stock_items
--
-- Both were RECORDED DEFERRED DEBT with the exact DDL written down
-- (20261064000000's column comment; 20261066000000 header note 2), and both
-- candidate keys were added at the time precisely so this migration would not
-- have to touch either table's shape: `material_request_lines_id_org_key`
-- (20261066) and `stock_items_id_org_key` (20261063) already exist.
--
-- WHY THIS MATTERS AND WHAT IT REPLACES. Until now the refusal of a crafted
-- cross-org line id was the SEAM'S ACTIVE-ORG PIN — an app-layer read filter
-- (server/services/material-fulfilment.ts) plus `isStockItemInOrg`. That stops
-- the app from counting a foreign movement, but it never stopped the WRITE:
-- __tests__/integration/rls/material-request-fulfilment.test.ts proved org B
-- could physically stamp org A's line id onto its own movement, and a member
-- could hand a request line another company's stock item id. After this
-- migration both are UNREPRESENTABLE, for every role including service_role —
-- the 20261059000000 note-2 posture that every other reference on these tables
-- already had.
--
-- `NO ACTION DEFERRABLE INITIALLY DEFERRED`, NOT `RESTRICT` — 20261059000000
-- note 3, and the reason is not theoretical: RESTRICT can never be deferred, so
-- a `delete from organizations` that cascades one side before the other aborts
-- tenant teardown outright. That is exactly how the 20261052000000 org-teardown
-- P1 happened. Deferring keeps the protection for a real targeted delete (the
-- orphan still exists at COMMIT → error) while letting a teardown that removes
-- both sides succeed in ONE transaction.
--
-- `NOT VALID` FIRST, THEN AN EXPLICIT `VALIDATE` — so the migration CANNOT FAIL
-- ON DIRTY DATA. Both columns were writable-without-integrity for the whole
-- life of the two lanes, so a violating row is *possible* even though the app
-- path never wrote one. It cannot be REPAIRED in place either: `stock_movements`
-- is append-only for every role (tg_stock_movements_append_only refuses every
-- UPDATE, service_role included) and `material_request_lines` is frozen once its
-- request leaves draft, so a repair UPDATE would have to disable another
-- milestone's guard triggers — rewriting ledger history to add a constraint,
-- which is a far worse trade than a loud warning. So: add NOT VALID (always
-- succeeds, and enforces every future write immediately), then VALIDATE inside a
-- handler. Clean data → fully validated constraint, identical in every
-- environment. Dirty data → the constraint stays NOT VALID, still enforcing all
-- new writes, and the release emits a WARNING naming the count instead of
-- failing. Local pre-check at authoring time: 0 violations on both.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §2  THE DIRECT-INSERT RESIDUE — much larger than it was recorded as
-- ═══════════════════════════════════════════════════════════════════════════
-- 20261064000000 §6 grants members a direct INSERT policy on `stock_movements`,
-- because the write RPCs are SECURITY INVOKER and therefore need the caller's
-- own insert right. That was recorded as one accepted residue: "it CAN write an
-- unserialised movement that drives a balance negative".
--
-- RE-EXAMINED WITH A PROBE, AND IT IS FOUR THINGS, NOT ONE. Every one of these
-- was confirmed against the live local schema as a plain `staff` member holding
-- an ordinary JWT, going straight to PostgREST:
--
--   1. NEGATIVE BALANCE (the recorded one). A direct `issue` of 1000 against a
--      site holding 10 was ACCEPTED and took the balance to −990. It bypasses
--      the per-(item, site) advisory lock and the floor read entirely.
--   2. THE ADMIN-ONLY ADJUSTMENT GATE IS BYPASSED. `record_stock_adjustment`
--      correctly refused the member ("only an owner or admin can adjust
--      stock") — and the member then inserted `adjustment_out` DIRECTLY and it
--      was ACCEPTED. That gate is the one 20261065000000 §4 argues for at
--      length: an adjustment is the single movement with NO counterparty, "the
--      write that can conceal a loss, and the reason a stock system is believed
--      or not". It was enforceable only in a function the caller could decline
--      to call. This is a privilege escalation, not self-harm.
--   3. STOCK IS MANUFACTURED FROM NOTHING. A bare `transfer_in` of 500 with no
--      counterparty leg was ACCEPTED and the company total rose by 500. This is
--      the SAME defect class 20261069000000 shipped a fix for — conservation
--      broken by a half-transfer — reachable by a plainer route that the fix
--      did not cover.
--   4. THE POSTED-EVIDENCE CHECK IS BYPASSED. A direct `receipt` carrying a
--      DRAFT goods-received line was ACCEPTED, so unposted delivery evidence
--      lands in stock. The RPC refuses exactly this ("post it before taking it
--      into stock").
--
-- Cross-tenant writes were never reachable (the composite FKs), and the sign,
-- the reason and immutability are all structural. But 2, 3 and 4 are AUTHORITY
-- bypasses of the same shape 20261067000000 closed for material-request status:
-- "the app path is safe, the DB is the real backstop", and any member holding a
-- JWT could walk straight past it.
--
-- ── THE FIX, AND WHY NOT THE TWO OPTIONS THAT WERE WRITTEN DOWN ─────────────
-- The recorded options were (a) a constraint trigger that re-sums the balance on
-- every insert, or (b) make the RPCs SECURITY DEFINER. Both are worse:
--
--   (a) A BALANCE TRIGGER FIXES ONLY DEFECT 1. It says nothing about the
--       adjustment gate, the half-transfer or the unposted receipt — it polices
--       the NUMBER, not the AUTHORITY, and three of the four defects are about
--       authority. It also cannot be sound on its own: a per-row re-sum is not
--       serialised without the same advisory lock the direct path skipped, so
--       two concurrent inserts can still both pass it.
--       AND THE COST IS UNBOUNDED, WHICH IS THE PART THAT SETTLES IT. Measured
--       on this schema (200 reps each, one (item, site) pair, the balance index
--       in play — transcript in docs/operational-stock.md):
--             1 000 movements at the pair → SUM 0.125 ms vs insert 0.047 ms  (2.7×)
--            10 000 movements at the pair → SUM 0.709 ms vs insert 0.035 ms (20.3×)
--       The insert is FLAT; the aggregate grows LINEARLY with the ledger, and
--       the ledger is append-only, so it only ever grows. Paying an
--       ever-increasing tax on every legitimate write to buy one quarter of the
--       fix is the wrong trade at any scale, and it gets worse for ever.
--   (b) SECURITY DEFINER ON THE WRITE PATHS gives up the caller's RLS, every
--       guard trigger on the path and the whole "none of these is a privileged
--       back door" property that 20261065000000 was built around and that
--       __tests__/security/operational-stock.test.ts asserts by name. Each
--       function would then have to re-implement tenancy itself, which is five
--       new places for a membership check to be wrong.
--
-- SO: KEEP EVERY RPC SECURITY INVOKER, AND MAKE THE INSERT RIGHT CONDITIONAL ON
-- BEING INSIDE ONE OF THEM. A transaction-local marker names the org being
-- written; the insert policy requires it; the five write paths set it
-- immediately before their INSERT and clear it immediately after. This is the
-- IDIOM ALREADY PROVEN IN THIS SCHEMA — 20261067000000 gates the two derived
-- material-request statuses on `crewflow.mr_fulfilment` in exactly this way,
-- from a SECURITY INVOKER function called by ordinary members, and it has been
-- live since M4. `set_config(..., true)` is transaction-local, so it cannot leak
-- into another statement on a pooled connection, and it names the ORG so a
-- marker set for org A cannot wave through an insert for org B.
--
-- Refused at TWO layers, structural first (the 20261069000000 shape):
--   1. THE RLS POLICY — a tenant principal with no marker is refused before any
--      trigger runs. Policies never apply to service_role, so the trusted
--      server-side paths (seeds, backfills, imports, the integration harness's
--      ground-truth fixtures) are untouched.
--   2. A BEFORE INSERT TRIGGER — the same requirement, JWT-gated, carrying a
--      sentence that names the five write paths. It exists because an RLS
--      refusal is a bare 42501 with nothing actionable in it, and because a
--      future edit to the policy would otherwise silently reopen all four
--      defects.
--
-- SERVICE_ROLE REMAINS TRUSTED, DELIBERATELY. It is not a tenant principal: it
-- is reachable only from server-side code holding the secret key. That is the
-- SAME asymmetry every authority check in this schema already uses — the
-- adjustment gate (20261065000000 §4), the RAMS lifecycle (20261034000000), the
-- GRN lifecycle (20261059000000) and the material-request transition trigger
-- (20261067000000) are all skipped when `auth.uid()` is null. A negative balance
-- is therefore still *constructible* by trusted server code; it is no longer
-- constructible by any user of the product, which is where the boundary belongs.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §3  advance_material_request_fulfilment NO LONGER TRUSTS THE CALLER
-- ═══════════════════════════════════════════════════════════════════════════
-- 20261067000000 shipped `p_fulfilled jsonb` because, on its own branch, only
-- the app could read a stock schema that was not frozen yet. Its own header
-- names the debt and the fix: "closing this is a ~15-line change confined to the
-- RPC below: replace the p_fulfilled argument with a direct read of
-- stock_movements". Confirmed live: a plain member called it with a fabricated
-- `p_fulfilled` and moved their own org's request to `partially_fulfilled` with
-- ZERO issue movements in existence.
--
-- The argument is GONE, not ignored — an inert parameter that still looks
-- authoritative is how a trust boundary gets quietly restored. The RPC now
-- derives the quantities itself, using the SAME rule the app-side reader uses
-- (server/services/material-fulfilment.ts): sum `qty` over `movement_type =
-- 'issue'` carrying each line id, EXCLUDING any issue that has been reversed
-- (`not exists (correction where corrects_movement_id = m.id)`), because
-- `record_stock_correction` does not copy the line id onto the correction row —
-- so a naive sum over issues over-reports a reversed issue and would leave a
-- stripped site reading "fulfilled".
--
-- It stays SECURITY INVOKER. The derivation is therefore filtered by the
-- caller's own RLS, which is both safe and SOUND: `stock_movements: members can
-- select` admits every row of the caller's own org, so the sum is complete for
-- the tenant being worked in and empty for everyone else's — and every row it
-- reads is pinned to `p_org_id` on top of that. A SECURITY DEFINER derivation
-- would be a privileged read of any org's movements for anyone who could guess a
-- request id.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- §4  TERMINAL `fulfilled` CAN NOW WALK BACK — because it is a CACHE
-- ═══════════════════════════════════════════════════════════════════════════
-- M4 froze `fulfilled` as terminal and made the RPC forward-only. Correcting the
-- issues behind a fully-fulfilled request therefore fixed the DERIVED display
-- while the `status` column went on saying `fulfilled` for ever. That column is
-- not decoration: it drives the office queue's filters, the request badge, and
-- `isMaterialRequestOverdue` (which treats `fulfilled` as "nobody is waiting").
-- A site whose cement was booked out and then reversed silently dropped off the
-- office's radar.
--
-- THE DECIDING ARGUMENT, AND WHY THIS IS NOT A LOOSENING. `status` is a
-- FORWARD-ONLY CACHE OF A DERIVATION — 20261067000000 says so, and
-- server/services/material-fulfilment.ts says so again. A cache that can only
-- move one way is a cache that can be wrong, and now that §3 puts the derivation
-- IN THE DATABASE the cache can simply follow it. So the question "who may walk
-- it back?" dissolves: nobody may, because it is not a human act. It is a
-- re-derivation, requested through the same single writer, gated by the same
-- transaction marker, computed from the same ledger. The graph gains exactly ONE
-- edge and it is reachable only the way the forward edges are.
--
-- THE INVARIANT THIS BUYS, stated so it can be tested:
--     status = 'fulfilled'  ⟹  the derived position is 'full'.
-- A request may never claim to be fulfilled when the ledger disagrees.
--
-- SCOPE, KEPT DELIBERATELY NARROW:
--   · `rejected` and `cancelled` stay HARD terminal. Those are human decisions,
--     not derived caches, and nothing walks out of them.
--   · The walk-back lands on `partially_fulfilled`, never on `approved` — even
--     when the derivation drops all the way to 'none'. `partially_fulfilled`
--     means "open, and something has happened here", which is exactly true after
--     a reversal, and it preserves 20261067000000's existing rule that an issue
--     which has happened cannot un-happen from this side. The precise position
--     ('none' vs 'partial') is what every surface already renders, derived live.
--   · A HAND-SET move out of `fulfilled` is still refused, with the same "% is
--     final" message it has always had. Only the marker-gated re-derivation is
--     exempt.
--
-- ── ADDITIVE AND REVERSIBLE. To roll back to 20261069 behaviour:
--   alter table public.stock_movements drop constraint if exists stock_movements_mrl_org_fkey;
--   alter table public.material_request_lines drop constraint if exists material_request_lines_item_org_fkey;
--   drop trigger if exists stock_movements_authorised_write on public.stock_movements;
--   drop function if exists public.tg_stock_movements_authorised_write();
--   -- restore the open insert policy:
--   drop policy if exists "stock_movements: members insert only through the write paths" on public.stock_movements;
--   create policy "stock_movements: members can insert" on public.stock_movements
--     for insert to authenticated with check (org_id in (select public.current_org_ids()));
--   -- then re-apply the five RPCs from 20261065000000 (and record_stock_correction
--   -- from 20261069000000), the RPC from 20261067000000, and
--   -- tg_material_request_transition from 20261067000000, all verbatim.

-- ════════════════════════════════════════════════════════════════════════════
-- §1. THE TWO COMPOSITE, ORG-BINDING FOREIGN KEYS
-- ════════════════════════════════════════════════════════════════════════════

-- Report what is there BEFORE anything changes, so a release log carries the
-- evidence rather than an assumption.
do $$
declare
  v_mrl int;
  v_itm int;
begin
  select count(*) into v_mrl
    from public.stock_movements m
   where m.material_request_line_id is not null
     and not exists (
       select 1 from public.material_request_lines li
        where li.id = m.material_request_line_id and li.org_id = m.org_id
     );
  select count(*) into v_itm
    from public.material_request_lines li
   where li.stock_item_id is not null
     and not exists (
       select 1 from public.stock_items si
        where si.id = li.stock_item_id and si.org_id = li.org_id
     );
  raise notice
    '20261071000000 pre-check: % dangling/cross-org stock_movements.material_request_line_id, % dangling/cross-org material_request_lines.stock_item_id',
    v_mrl, v_itm;
end $$;

-- ── 1a. stock_movements.material_request_line_id → material_request_lines ────
-- The DDL written down in 20261064000000's column comment, verbatim in shape.
-- MATCH SIMPLE (the default): with material_request_line_id null the constraint
-- is not checked at all, which is right — the linkage is optional provenance and
-- the overwhelming majority of movements never touch a request.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_movements_mrl_org_fkey') then
    alter table public.stock_movements
      add constraint stock_movements_mrl_org_fkey
      foreign key (material_request_line_id, org_id)
      references public.material_request_lines (id, org_id)
      on delete no action deferrable initially deferred not valid;
  end if;
end $$;

do $$
begin
  alter table public.stock_movements validate constraint stock_movements_mrl_org_fkey;
exception
  when foreign_key_violation then
    raise warning
      'stock_movements_mrl_org_fkey left NOT VALID: pre-existing rows name a material request line outside their org. Every NEW write is still enforced. Investigate before relying on this constraint for planning.';
end $$;

-- ── 1b. material_request_lines.stock_item_id → stock_items ──────────────────
-- The mirror image, and the structural half of the debt whose app-layer half is
-- `isStockItemInOrg` (server/services/material-fulfilment.ts). That check stays:
-- it turns a deferred 23503 at COMMIT into a sentence at form-validation time.
--
-- A CONSEQUENCE, STATED: deleting a stock item that a request line names is now
-- refused (at COMMIT, as a deferred FK). That is the same posture the item
-- register already had for movements — 20261063000000's header says outright
-- "DELETE ... is additionally refused outright by the ledger's FK once the item
-- has any movement history — deactivate instead."
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'material_request_lines_item_org_fkey') then
    alter table public.material_request_lines
      add constraint material_request_lines_item_org_fkey
      foreign key (stock_item_id, org_id)
      references public.stock_items (id, org_id)
      on delete no action deferrable initially deferred not valid;
  end if;
end $$;

do $$
begin
  alter table public.material_request_lines validate constraint material_request_lines_item_org_fkey;
exception
  when foreign_key_violation then
    raise warning
      'material_request_lines_item_org_fkey left NOT VALID: pre-existing lines name a stock item outside their org. Every NEW write is still enforced.';
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- §2. THE INSERT RIGHT IS NOW CONDITIONAL ON BEING INSIDE A WRITE PATH
-- ════════════════════════════════════════════════════════════════════════════

-- ── 2a. Layer 1 — the RLS policy (structural; no message) ───────────────────
-- Renamed, because a policy name is documentation and `\d+` should not claim
-- members can insert freely when they cannot. SELECT is untouched; there is
-- still deliberately NO update and NO delete policy (20261064000000 §6).
drop policy if exists "stock_movements: members can insert" on public.stock_movements;
drop policy if exists "stock_movements: members insert only through the write paths"
  on public.stock_movements;
create policy "stock_movements: members insert only through the write paths"
  on public.stock_movements
  for insert to authenticated
  with check (
    org_id in (select public.current_org_ids())
    -- The marker only the five write paths set, naming THIS org. Transaction-
    -- local, so it cannot survive the statement that set it.
    and coalesce(current_setting('crewflow.stock_write', true), '') = org_id::text
  );

-- ── 2b. Layer 2 — the trigger that says WHY, and holds if the policy changes ─
-- Named `stock_movements_authorised_write` so it sorts BEFORE
-- `stock_movements_derive`: a caller who took the wrong path should be told that
-- first, rather than getting a message about a sign or a corrected movement.
--
-- JWT-GATED (`auth.uid() is null` → allow) — the house asymmetry. service_role
-- is trusted server-side code, not a tenant principal, and the integration
-- suite's ground-truth fixtures depend on it (the forged-sign proof and the
-- cross-tenant-FK proof are both service_role direct inserts).
--
-- NOT security definer: it reads only the row in front of it and two session
-- functions, so it needs no privilege the caller lacks.
create or replace function public.tg_stock_movements_authorised_write()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then
    return new;   -- trusted service role: seeds, backfills, imports
  end if;
  if coalesce(current_setting('crewflow.stock_write', true), '') <> new.org_id::text then
    raise exception
      'a stock movement is recorded through a stock write path (record_stock_issue, record_stock_transfer, record_stock_receipt_from_grn, record_stock_adjustment, record_stock_correction) — a direct insert would skip the balance floor, the per-(item, site) lock and the admin-only adjustment gate'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists stock_movements_authorised_write on public.stock_movements;
create trigger stock_movements_authorised_write
  before insert on public.stock_movements
  for each row execute function public.tg_stock_movements_authorised_write();

-- ════════════════════════════════════════════════════════════════════════════
-- §3. THE FIVE WRITE PATHS — reproduced VERBATIM apart from the marker
-- ════════════════════════════════════════════════════════════════════════════
-- Every one of these is 20261065000000's function (record_stock_correction is
-- 20261069000000's, transfer-leg guard included) with exactly two changes: a
-- `set_config('crewflow.stock_write', p_org_id::text, true)` immediately before
-- the INSERT and a clear immediately after. SECURITY INVOKER is preserved
-- throughout — the caller's RLS, every composite FK and every guard trigger
-- still apply, so none of these becomes a back door.
--
-- record_stock_issue additionally gains ONE friendly pre-check for the new FK in
-- §1a, exactly as it already pre-reads the item and the site: the FK is the rule,
-- but a deferred FK reports at COMMIT as a raw 23503, and this turns that into a
-- sentence. (The same reasoning 20261065000000 gives: "reading them first turns a
-- raw 23503 into a sentence the yard can act on.")

-- ── 3a. Receive a POSTED delivery line into stock (IDEMPOTENT) ──────────────
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
  -- to the company they are working in.
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
    -- The racing sibling won. Return ITS movement: the caller asked for the
    -- delivery to be in stock, and it is. (The subtransaction rollback has
    -- already retired the marker; clearing it again is belt and braces.)
    perform set_config('crewflow.stock_write', '', true);
    select id into v_existing
      from public.stock_movements
     where grn_line_id = p_grn_line_id and movement_type = 'receipt' and org_id = p_org_id;
    if v_existing is null then raise; end if;
    return v_existing;
end $$;
grant execute on function public.record_stock_receipt_from_grn(uuid, uuid, uuid, uuid, text) to authenticated;

-- ── 3b. Issue stock (out of a site, optionally to a job / a request line) ────
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE M4 PARAMETER CONTRACT IS UNCHANGED. `p_material_request_line_id     ║
-- ║  uuid default null` keeps its NAME, its DEFAULT and its position. What   ║
-- ║  changes is that the value is now validated — by the composite FK in §1a ║
-- ║  structurally, and by the pre-check below for the message.               ║
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
end $$;
grant execute on function public.record_stock_issue(uuid, uuid, uuid, numeric, uuid, uuid, text) to authenticated;

-- ── 3c. Transfer between two sites — ONE transaction, TWO rows ──────────────
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
end $$;
grant execute on function public.record_stock_transfer(uuid, uuid, uuid, uuid, numeric, text) to authenticated;

-- ── 3d. Adjustment — ADMIN ONLY (and now unbypassable, see §2 defect 2) ─────
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
end $$;
grant execute on function public.record_stock_adjustment(uuid, uuid, uuid, numeric, text) to authenticated;

-- ── 3e. Correction — 20261069000000's version, transfer-leg guard intact ────
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

-- ════════════════════════════════════════════════════════════════════════════
-- §4. advance_material_request_fulfilment — DERIVES, and may walk back
-- ════════════════════════════════════════════════════════════════════════════
-- The 3-argument form is DROPPED, not left inert (see §3 of the header). Any
-- caller still sending `p_fulfilled` now gets PGRST202, which the seam already
-- classifies as "that lane isn't here" and degrades to a no-op advance — a stale
-- badge for one render, never a wrong status.
drop function if exists public.advance_material_request_fulfilment(uuid, uuid, jsonb);

create or replace function public.advance_material_request_fulfilment(
  p_request_id uuid,
  p_org_id     uuid
) returns text
language plpgsql
as $$
declare
  v_status text;
  v_state  text;
  v_target text;
  v_issued jsonb;
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

  -- A fulfilment position exists for a live approved/part-fulfilled request and
  -- — new in this migration — for a `fulfilled` one, which must be able to stop
  -- claiming it if the issues behind it are reversed. draft / submitted /
  -- rejected / cancelled have no position at all; calling this on one is a
  -- caller bug, not a no-op.
  if v_status not in ('approved', 'partially_fulfilled', 'fulfilled') then
    raise exception 'a % material request has no fulfilment position', v_status
      using errcode = 'check_violation';
  end if;

  -- ── THE DERIVATION. Nothing is taken from the caller but two ids. ─────────
  -- Same rule as server/services/material-fulfilment.ts readIssuedForLines:
  --   · only movement_type = 'issue' carries a fulfilment claim;
  --   · `qty` is always POSITIVE (CHECK qty > 0) — the sign lives in `effect`,
  --     so summing qty over issues is correct and needs no sign handling;
  --   · an issue that has been REVERSED is EXCLUDED. record_stock_correction
  --     does not copy material_request_line_id onto the correction row, so a
  --     naive sum still counts a corrected-away issue and would leave a
  --     stripped site reading 'fulfilled'. At most one correction per movement
  --     (stock_movements_corrects_uniq), so this is cheap.
  -- Every leg is pinned to p_org_id on top of RLS: the join to
  -- material_request_lines is on (id, org_id), which is exactly the composite
  -- the FK in §1a now enforces, so a crafted foreign line id cannot contribute.
  select coalesce(
           jsonb_agg(jsonb_build_object('line_id', m.material_request_line_id, 'qty', m.qty)),
           '[]'::jsonb)
    into v_issued
    from public.stock_movements m
    join public.material_request_lines li
      on li.id = m.material_request_line_id
     and li.org_id = m.org_id
   where li.material_request_id = p_request_id
     and li.org_id = p_org_id
     and m.org_id = p_org_id
     and m.movement_type = 'issue'
     and not exists (
       select 1 from public.stock_movements c
        where c.corrects_movement_id = m.id
          and c.org_id = m.org_id
     );

  -- The status ARITHMETIC still lives in one place, reached through the GRANTED
  -- wrapper (this body runs as the CALLER, so the revoked internal function
  -- would be 42501 for every real JWT — 20261067000000's pairing note).
  v_state := public.material_request_fulfilment_state(p_request_id, p_org_id, v_issued);

  v_target := case v_state when 'full' then 'fulfilled'
                           when 'partial' then 'partially_fulfilled'
                           else 'approved' end;

  -- ── THE WALK-BACK (see §4 of the header) ─────────────────────────────────
  -- INVARIANT: status = 'fulfilled' ⟹ the derived position is 'full'. If a
  -- fulfilled request no longer derives 'full', it must stop saying so. Both
  -- 'none' and 'partial' land on `partially_fulfilled` — "open, and something
  -- has happened here" — never on `approved`, so 20261067000000's rule that an
  -- issue which happened cannot un-happen from this side is preserved. The
  -- precise position is what the surfaces render, derived live.
  if v_status = 'fulfilled' and v_state <> 'full' then
    v_target := 'partially_fulfilled';
  end if;

  if v_target = v_status then
    return v_status;   -- nothing moved; don't churn updated_at or the feed
  end if;

  -- 'approved' is not reachable backwards from partially_fulfilled.
  if v_target = 'approved' then
    return v_status;
  end if;

  -- The marker the transition trigger requires. Transaction-local, and it names
  -- the specific request so it cannot wave a DIFFERENT row through.
  perform set_config('crewflow.mr_fulfilment', p_request_id::text, true);

  update public.material_requests
     set status = v_target
   where id = p_request_id and org_id = p_org_id;

  -- Retire the marker immediately: it authorises exactly one statement.
  perform set_config('crewflow.mr_fulfilment', '', true);

  return v_target;
end $$;
grant execute on function public.advance_material_request_fulfilment(uuid, uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- §5. THE TRANSITION TRIGGER — one new edge, reachable only by re-derivation
-- ════════════════════════════════════════════════════════════════════════════
-- Reproduces 20261067000000's tg_material_request_transition VERBATIM except
-- that the terminal freeze now carves out the single marker-gated walk-back off
-- `fulfilled`, and the derived-status branch accepts that one extra edge.
--
-- ORDER IS LOAD-BEARING. The terminal check still runs BEFORE the derived
-- branch, so every message a caller could already see is unchanged: a
-- `cancelled → fulfilled` attempt still reads "cancelled is final", and a
-- HAND-SET `fulfilled → partially_fulfilled` (no marker) reads "fulfilled is
-- final" rather than leaking the existence of a derived path.
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

  v_marker := coalesce(current_setting('crewflow.mr_fulfilment', true), '');

  -- ── Terminal states are frozen ─────────────────────────────────────────
  -- ONE carve-out, and it is not a human act: a request that reads `fulfilled`
  -- while the ledger no longer supports it must be able to stop claiming so.
  -- Only advance_material_request_fulfilment can request it (the marker), it
  -- can only land on `partially_fulfilled`, and `rejected` / `cancelled` — real
  -- human decisions — stay hard terminal with no carve-out at all.
  if old.status in ('fulfilled', 'rejected', 'cancelled') then
    if not (old.status = 'fulfilled'
            and new.status = 'partially_fulfilled'
            and v_marker = new.id::text) then
      raise exception 'material request %: % is final', old.id, old.status
        using errcode = 'check_violation';
    end if;
  end if;

  -- ── The derived statuses: only ever reached through the RPC ────────────
  if new.status in ('partially_fulfilled', 'fulfilled') then
    if v_marker <> new.id::text then
      raise exception
        'material request %: fulfilment is DERIVED from stock issues, not set by hand', old.id
        using errcode = 'check_violation';
    end if;
    -- ...and only between positions that a re-derivation can actually produce.
    if not (
         (old.status = 'approved'            and new.status in ('partially_fulfilled', 'fulfilled'))
      or (old.status = 'partially_fulfilled' and new.status = 'fulfilled')
      or (old.status = 'fulfilled'           and new.status = 'partially_fulfilled')
    ) then
      raise exception 'material request %: % -> % is not a legal transition',
        old.id, old.status, new.status using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- ── Cancelling ─────────────────────────────────────────────────────────
  if new.status = 'cancelled' then
    if old.status in ('draft', 'submitted') then
      if not (v_own or v_admin) then
        raise exception 'material request %: only the requester or an admin can cancel it', old.id
          using errcode = 'insufficient_privilege';
      end if;
    elsif not v_admin then
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
  raise exception 'material request %: % -> % is not a legal transition',
    old.id, old.status, new.status using errcode = 'check_violation';
end $$;

drop trigger if exists material_requests_transition on public.material_requests;
create trigger material_requests_transition
  before update on public.material_requests
  for each row execute function public.tg_material_request_transition();

-- ── Comments ────────────────────────────────────────────────────────────────
comment on column public.stock_movements.material_request_line_id is
  'The material request line this issue fulfils. Bound to material_request_lines (id, org_id) by stock_movements_mrl_org_fkey (20261071000000) — the deferred cross-lane debt from 20261064000000, now paid: a cross-org line id is unrepresentable for every role.';
comment on column public.material_request_lines.stock_item_id is
  'Optional catalogue link. Bound to stock_items (id, org_id) by material_request_lines_item_org_fkey (20261071000000) — the mirror half of the same debt (20261066000000 header note 2).';
comment on function public.tg_stock_movements_authorised_write() is
  'A stock movement may only be inserted from inside a stock write path, which sets the transaction-local crewflow.stock_write marker. JWT-gated: service_role is trusted server-side code. Closes direct-PostgREST negative balances, the admin-only adjustment-gate bypass, bare transfer_in stock manufacture and unposted-GRN receipts (20261071000000 §2).';
comment on function public.advance_material_request_fulfilment(uuid, uuid) is
  'The single writer of partially_fulfilled / fulfilled. DERIVES the fulfilled quantities from stock_movements itself (corrected issues excluded) — it takes no quantities from the caller. Walks a request BACK off fulfilled when the derivation no longer supports it, so status = fulfilled always implies a full derived position (20261071000000).';
