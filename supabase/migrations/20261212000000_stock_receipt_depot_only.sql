-- STOCK RECEIPT IS DEPOT-ONLY — the structural guard that makes the stock-COGS
-- job-cost allocation double-count-SAFE, not merely convention-safe.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE DEFECT THIS CLOSES (S1, adversarial financial review of the COGS     ║
-- ║  wiring). Job COGS-on-issue is folded into job margin as a MATERIALS       ║
-- ║  allocation (lib/profitability/job-cost-input + lib/stock/valuation). That ║
-- ║  is safe ONLY if a job's material cost reaches its margin through EITHER a  ║
-- ║  direct `finances` bill OR a stock issue, never BOTH for the same spend.   ║
-- ║  Nothing enforced it, and the standard workflow could reach both:          ║
-- ║    1. a PO carries job_id = A;                                             ║
-- ║    2. its delivery is taken into stock (job-less depot receipt) — this RPC ║
-- ║       had NO guard against a job-tagged PO;                                ║
-- ║    3. recordSupplierBill auto-copies po.job_id → a `finances` MATERIALS    ║
-- ║       bill lands on Job A (app/(app)/purchase-orders/actions.ts);          ║
-- ║    4. the stock is issued to Job A → COGS allocates the SAME spend to A.   ║
-- ║  Result: Job A's materials ≈ 2× the true spend.                           ║
-- ║                                                                          ║
-- ║  THE FIX — DISJOINTNESS BY CONSTRUCTION. Stock is a DEPOT pool. A          ║
-- ║  purchase is EITHER job-direct (job_id set → billed to the job, never      ║
-- ║  stocked) OR depot replenishment (job_id null → billed to the depot,       ║
-- ║  stocked, then RELEASED to the consuming job as COGS on issue). This       ║
-- ║  migration makes the second half enforceable: record_stock_receipt_from_  ║
-- ║  grn now REFUSES a delivery line whose purchase order carries a job_id, so ║
-- ║  a job-tagged purchase can never enter shared stock. The two cost paths    ║
-- ║  can therefore never both land on one job for one spend — the double-count ║
-- ║  is UNREACHABLE, not merely discouraged.                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── BASELINE: THE MARKER-SETTING BODY FROM 20261071, NOT 20261065 ────────────
-- The AUTHORITATIVE definition of this function is 20261071000000 §3a, which
-- wraps the insert in the `crewflow.stock_write` transaction marker the write-path
-- RLS policy + guard trigger require (a marker-less insert is refused with 42501,
-- "recorded through a stock write path …"). This CREATE OR REPLACE is built on
-- THAT body — the two `set_config('crewflow.stock_write', …)` calls are preserved
-- verbatim — and adds ONLY the depot-only guard. (An earlier draft was rebased on
-- the older 20261065 body by mistake, which dropped the marker and made every
-- legitimate depot receipt fail 42501; this restores it.)
--
-- ── PRIVILEGES: STILL SECURITY INVOKER, NO NEW GRANT ─────────────────────────
-- The new read of the parent purchase order's job_id joins `public.purchase_orders`.
-- `authenticated` already holds SELECT on that table (RLS-gated by
-- `org_id in current_org_ids()`, identical to goods_received_notes), so the join
-- runs under the caller's own privileges — no SECURITY DEFINER, no widened grant.
-- The join is org-pinned on both sides (po.org_id = gn.org_id, gn pinned to
-- p_org_id), so it reads only the same-org parent order.
--
-- ADDITIVE. Only the function BODY changes (a new pre-insert guard + the PO read);
-- the signature, SECURITY INVOKER posture, marker, idempotency, org pins and grant
-- are otherwise the 20261071 original. No table, RLS policy or quantity is touched.
-- This RPC still posts NOTHING to `finances`.

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
  v_po_job_id  uuid;
  v_existing   uuid;
  v_movement   uuid;
begin
  if p_org_id is null or p_grn_line_id is null or p_item_id is null or p_site_id is null then
    raise exception 'organisation, delivery line, item and site are all required'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ACTIVE-ORG PIN on the delivery line AND its note, plus the posted check AND
  -- the parent purchase order's job_id, in one read. RLS admits every org the
  -- caller belongs to; p_org_id narrows that to the company they are working in.
  -- The join to purchase_orders is org-pinned on both sides (gn.purchase_order_id
  -- is NOT NULL and same-org by composite FK, 20261059), and authenticated already
  -- holds SELECT on purchase_orders — so this stays SECURITY INVOKER.
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

  -- DEPOT-ONLY GUARD (the double-count fix). A purchase tagged to a job is
  -- expensed to that job when its supplier bill is recorded (recordSupplierBill
  -- copies po.job_id onto the finances materials row). Taking the same goods into
  -- shared stock would let the later issue allocate COGS to the SAME job for the
  -- SAME spend — double-counting it. Shared stock is a DEPOT pool of job-less
  -- purchases only; a job-tagged delivery belongs on the job, not in stock.
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
