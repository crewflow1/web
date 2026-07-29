-- Warehouse M1 — Goods Received Notes (GRNs) against EXISTING purchase orders.
--
-- CrewFlow could ORDER (purchase_orders, 20261006) and could BILL
-- (recordSupplierBill → finances), but it could not RECEIVE. `status =
-- 'received'` was a bare enum write: it recorded no quantity, no date, no
-- delivery-note reference, no receiver and no evidence, so "what actually
-- turned up on site" existed nowhere in the product. A part delivery — the
-- normal case in UK construction merchanting — was unrepresentable.
--
-- This migration makes the receipt a FIRST-CLASS RECORD:
--
--   goods_received_notes   — the delivery event (one per physical delivery)
--   goods_received_lines   — what arrived, per ORDERED line
--
-- WHAT THIS IS NOT: it is NOT stock. There is no on-hand balance, no bin, no
-- valuation and no issue-to-job posting here. Receiving is OPERATIONAL
-- evidence; the COST of the goods is already handled by the commercial engine
-- (a PO is committed spend; the supplier bill posts the actual cost to
-- `finances`). This migration therefore writes NOTHING to `finances` and
-- creates no path that could — receiving a delivery must never move money, or
-- the same spend would be counted twice (once at receipt, once at bill).
--
-- SCHEMA DECISIONS AND THEIR EVIDENCE
--
-- 1. CANDIDATE KEYS. `purchase_orders` and `purchase_order_line_items` are
--    introspected as having only a PK on (id) — no (id, org_id) unique — so
--    neither can be the target of a composite, org-binding FK today. Both gain
--    one, the additive idiom used for invoices_id_org_key (20260911),
--    customers_id_org_key (20260915), payments_id_org_key (20261010) and
--    blueprint_versions_id_org_key (20261016/17). Purely additive: a unique
--    index on a superset of an existing PK can never reject a row.
--
-- 2. COMPOSITE FKs, NOT A GUARD TRIGGER. 20261011 had to use a BEFORE trigger
--    for purchase_orders.supplier_id/job_id because those FKs are ON DELETE SET
--    NULL while org_id is NOT NULL, which a composite FK cannot express. That
--    constraint does NOT apply here: a GRN without its PO is meaningless, so
--    purchase_order_id is NOT NULL and the composite FK is the right, and
--    strictly stronger, tool. Cross-tenant binding becomes structurally
--    unrepresentable for EVERY role, service_role included — no trigger to
--    forget, no policy to misread. It also closes the org_id-repointing hole:
--    the FK's implicit ON UPDATE NO ACTION means a dual-org admin who moves a
--    PO between their two orgs is refused while receipts exist.
--
-- 3. NO ACTION DEFERRABLE INITIALLY DEFERRED, not RESTRICT. Semantically these
--    are the same protection — you cannot delete a PO that has receipts — but
--    RESTRICT is checked immediately and can never be deferred, which would
--    BREAK ORG TEARDOWN. `delete from organizations` cascades to BOTH
--    purchase_orders and goods_received_notes in one transaction, in an order
--    Postgres does not promise; if the POs go first, an immediate RESTRICT
--    aborts the whole teardown (exactly the class of teardown bug 20261052
--    fixed for activity_log). Deferring the check to COMMIT keeps the
--    protection for a real "delete this PO" (the orphan still exists at commit
--    → error) while letting a teardown that removes both sides succeed.
--    Regression cover: __tests__/integration/rls/goods-received-notes.test.ts.
--
-- 4. delivery_location IS FREE TEXT, deliberately. It follows the
--    asset_assignments.location precedent (20260925). A typed `sites` entity is
--    a LATER milestone with its own slot; modelling a half-site here would
--    create a second, weaker site concept that the real one would then have to
--    migrate away from.
--
-- 5. POSTED IS IMMUTABLE. A GRN is delivery evidence: once posted it is frozen
--    and a mistake is corrected by VOIDING it with a mandatory reason, never by
--    editing it. Enforced by a BEFORE UPDATE write-once trigger in the shape of
--    tg_completion_certificates_immutable (20261014) /
--    tg_compliance_document_evidence_immutable (20261035), plus a born-draft +
--    provenance-pinning lifecycle guard in the shape of tg_ra_lifecycle
--    (20261034) so posted_by/posted_at can be neither forged nor back-dated.
--
-- Additive and reversible: two new tables, one new function, two additive
-- unique constraints. Rollback = drop the tables + function + constraints.

-- ── 1. Candidate keys on the PO side (FK targets; see header note 1) ─────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'purchase_orders_id_org_key') then
    alter table public.purchase_orders
      add constraint purchase_orders_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'purchase_order_line_items_id_org_key') then
    alter table public.purchase_order_line_items
      add constraint purchase_order_line_items_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. Per-org GRN number allocator (mirrors next_po_number, 20261006) ───────
-- The unique (org_id, number) constraint below — NOT this function — is the real
-- guard; a race yields a unique violation the caller retries, never a duplicate
-- delivery number. The posting RPC (20261060) additionally serialises numbering
-- per org with an advisory lock so the retry path is practically unreachable.
create or replace function public.next_grn_number(target_org uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(number from 'GRN-(\d+)') as int)), 0) + 1
  into next_num
  from public.goods_received_notes
  where org_id = target_org
    and number ~ '^GRN-\d+$';
  return 'GRN-' || lpad(next_num::text, 4, '0');
end;
$$;
grant execute on function public.next_grn_number(uuid) to authenticated;

-- ── 3. goods_received_notes ─────────────────────────────────────────────────
create table if not exists public.goods_received_notes (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organizations(id) on delete cascade,
  -- NOT NULL: a GRN without its PO is meaningless (see header note 2/3).
  purchase_order_id       uuid not null,
  number                  text not null,
  status                  text not null default 'draft'
    check (status in ('draft', 'posted', 'void')),
  -- WHO took delivery on site. Guarded to org members by the trigger below.
  received_by             uuid references public.users(id) on delete set null,
  delivery_date           date not null default current_date,
  -- the supplier's own delivery-note / ticket number, as written on the paper.
  delivery_note_reference text,
  -- free text by design — see header note 4.
  delivery_location       text,
  notes                   text,
  posted_at               timestamp with time zone,
  posted_by               uuid references public.users(id) on delete set null,
  voided_at               timestamp with time zone,
  voided_by               uuid references public.users(id) on delete set null,
  void_reason             text,
  created_by              uuid references public.users(id) on delete set null,
  created_at              timestamp with time zone not null default now(),
  updated_at              timestamp with time zone not null default now(),
  constraint goods_received_notes_org_number_key unique (org_id, number),
  -- child composite-FK target (goods_received_lines binds through it).
  constraint goods_received_notes_id_org_key unique (id, org_id),
  constraint goods_received_notes_po_org_fkey
    foreign key (purchase_order_id, org_id)
    references public.purchase_orders (id, org_id)
    on delete no action deferrable initially deferred,
  -- Correction is void-with-a-reason, never a silent edit: the reason is
  -- structurally required, not merely validated in the form.
  constraint goods_received_notes_void_reason_required
    check (status <> 'void' or (void_reason is not null and btrim(void_reason) <> '')),
  constraint goods_received_notes_posted_provenance
    check (status <> 'posted' or posted_at is not null)
);

create index if not exists goods_received_notes_org_idx
  on public.goods_received_notes (org_id, delivery_date desc);
create index if not exists goods_received_notes_po_idx
  on public.goods_received_notes (purchase_order_id, created_at desc);
-- the hot path: "what has been POSTED against this PO" (receipt derivation).
create index if not exists goods_received_notes_po_posted_idx
  on public.goods_received_notes (purchase_order_id) where status = 'posted';

drop trigger if exists goods_received_notes_set_updated_at on public.goods_received_notes;
create trigger goods_received_notes_set_updated_at before update on public.goods_received_notes
  for each row execute function public.tg_set_updated_at();

-- ── 4. goods_received_lines ─────────────────────────────────────────────────
-- One row per ORDERED line that arrived on this delivery. Both parents are
-- reached by composite FK, so a line can never straddle two tenants.
create table if not exists public.goods_received_lines (
  id                          uuid primary key default gen_random_uuid(),
  org_id                      uuid not null references public.organizations(id) on delete cascade,
  goods_received_note_id      uuid not null,
  purchase_order_line_item_id uuid not null,
  -- numeric(12,2) matches purchase_order_line_items.qty exactly, so a decimal
  -- unit (12.5 m³ of concrete) receives without a rounding fork. Never zero and
  -- never negative: a nil delivery is simply a line you do not add, and a
  -- return is a future credit-note concept, NOT a negative receipt.
  qty_received                numeric(12, 2) not null check (qty_received > 0),
  notes                       text,
  created_at                  timestamp with time zone not null default now(),
  constraint goods_received_lines_grn_org_fkey
    foreign key (goods_received_note_id, org_id)
    references public.goods_received_notes (id, org_id) on delete cascade,
  constraint goods_received_lines_po_line_org_fkey
    foreign key (purchase_order_line_item_id, org_id)
    references public.purchase_order_line_items (id, org_id)
    on delete no action deferrable initially deferred,
  -- one row per ordered line per delivery — receiving the same line twice on a
  -- single note is a data-entry error, not two events.
  constraint goods_received_lines_note_line_key
    unique (goods_received_note_id, purchase_order_line_item_id)
);

create index if not exists goods_received_lines_note_idx
  on public.goods_received_lines (goods_received_note_id);
create index if not exists goods_received_lines_po_line_idx
  on public.goods_received_lines (purchase_order_line_item_id);
create index if not exists goods_received_lines_org_idx
  on public.goods_received_lines (org_id);

-- ── 5. Lifecycle: born draft, provenance pinned, posted then immutable ───────
-- Shape borrowed from tg_ra_lifecycle (20261034) + tg_completion_certificates_
-- immutable (20261014). Born-draft is UNCONDITIONAL — even the service role and
-- the posting RPC create a draft first and transition it — so there is exactly
-- one way a GRN can become posted, and that way runs this gate.
create or replace function public.tg_goods_received_note_lifecycle()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_line_count integer;
  v_member_org uuid;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a goods received note is created as a draft, then posted'
        using errcode = 'check_violation';
    end if;
    if new.posted_at is not null or new.posted_by is not null
       or new.voided_at is not null or new.voided_by is not null then
      raise exception 'a new goods received note cannot carry posted/void provenance'
        using errcode = 'check_violation';
    end if;
  end if;

  -- received_by must be a member of the SAME org (mirrors the asset_assignments
  -- assignee guard, 20260925) — a receiver from another tenant would leak a name.
  if new.received_by is not null then
    select org_id into v_member_org
      from public.memberships
     where user_id = new.received_by and org_id = new.org_id;
    if v_member_org is null then
      raise exception 'goods received note: % is not a member of this org', new.received_by
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  -- ── UPDATE ────────────────────────────────────────────────────────────────
  -- void is terminal.
  if old.status = 'void' and new.status <> 'void' then
    raise exception 'a voided goods received note cannot be reinstated (GRN %)', old.id
      using errcode = 'check_violation';
  end if;

  -- draft may only be posted or voided; posted may only be voided.
  if old.status = 'draft' and new.status not in ('draft', 'posted', 'void') then
    raise exception 'a draft goods received note can only be posted or voided, not moved to %', new.status
      using errcode = 'check_violation';
  end if;
  if old.status = 'posted' and new.status not in ('posted', 'void') then
    raise exception 'a posted goods received note is evidence — correct it by voiding, not by moving it to %', new.status
      using errcode = 'check_violation';
  end if;

  -- draft -> posted: require substance, then PIN provenance server-side so
  -- posted_by/posted_at can be neither forged nor back-dated (JWT-gated, so the
  -- trusted service role may seed historical receipts — the 20261034 asymmetry).
  if old.status = 'draft' and new.status = 'posted' then
    select count(*) into v_line_count
      from public.goods_received_lines where goods_received_note_id = new.id;
    if v_line_count = 0 then
      raise exception 'cannot post an empty goods received note — record what arrived first'
        using errcode = 'check_violation';
    end if;
    if auth.uid() is not null then
      new.posted_by := auth.uid();
      new.posted_at := now();
    else
      new.posted_at := coalesce(new.posted_at, now());
    end if;
  end if;

  -- -> void: pin the void provenance the same way.
  if old.status <> 'void' and new.status = 'void' then
    if auth.uid() is not null then
      new.voided_by := auth.uid();
      new.voided_at := now();
    else
      new.voided_at := coalesce(new.voided_at, now());
    end if;
  end if;

  -- WRITE-ONCE: once the note leaves draft, every field that describes the
  -- delivery is frozen. Only the void columns may still move (draft -> void /
  -- posted -> void), which is the whole point of the correction path.
  if old.status <> 'draft' then
    if new.purchase_order_id is distinct from old.purchase_order_id
       or new.number is distinct from old.number
       or new.received_by is distinct from old.received_by
       or new.delivery_date is distinct from old.delivery_date
       or new.delivery_note_reference is distinct from old.delivery_note_reference
       or new.delivery_location is distinct from old.delivery_location
       or new.notes is distinct from old.notes
       or new.posted_at is distinct from old.posted_at
       or new.posted_by is distinct from old.posted_by then
      raise exception 'a posted goods received note is immutable — void it and record a new one (GRN %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  if old.status = 'void' then
    if new.void_reason is distinct from old.void_reason
       or new.voided_at is distinct from old.voided_at
       or new.voided_by is distinct from old.voided_by then
      raise exception 'the void record on GRN % is immutable', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists goods_received_notes_lifecycle on public.goods_received_notes;
create trigger goods_received_notes_lifecycle
  before insert or update on public.goods_received_notes
  for each row execute function public.tg_goods_received_note_lifecycle();

-- ── 6. Lines are only writable while their note is a DRAFT ──────────────────
-- The received quantities ARE the evidence; freezing the note but leaving its
-- lines editable would be a hole big enough to drive a lorry through.
create or replace function public.tg_goods_received_line_draft_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_grn    uuid;
  v_po_id  uuid;
begin
  v_grn := coalesce(new.goods_received_note_id, old.goods_received_note_id);
  select status into v_status from public.goods_received_notes where id = v_grn;
  if v_status is null then
    -- parent already gone (cascade) — nothing to protect.
    return coalesce(new, old);
  end if;
  if v_status <> 'draft' then
    raise exception 'goods received note % is % — its lines are immutable evidence', v_grn, v_status
      using errcode = 'check_violation';
  end if;

  -- The received line must point at a line item of THIS note's purchase order.
  -- The composite FKs already prove both sides share an org; this proves the
  -- line belongs to the ORDER being received, so a receipt can never be booked
  -- against an unrelated PO's line within the same tenant.
  if tg_op in ('INSERT', 'UPDATE') then
    select gn.purchase_order_id into v_po_id
      from public.goods_received_notes gn where gn.id = new.goods_received_note_id;
    if not exists (
      select 1 from public.purchase_order_line_items li
       where li.id = new.purchase_order_line_item_id
         and li.purchase_order_id = v_po_id
    ) then
      raise exception 'line % does not belong to the purchase order this note receives',
        new.purchase_order_line_item_id using errcode = 'check_violation';
    end if;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists goods_received_lines_draft_only on public.goods_received_lines;
create trigger goods_received_lines_draft_only
  before insert or update or delete on public.goods_received_lines
  for each row execute function public.tg_goods_received_line_draft_only();

-- ── 7. RLS — members S/I/U; admin delete of DRAFTS ONLY ─────────────────────
-- Mirrors purchase_orders (20261006) with ONE deliberate tightening: the delete
-- policy carries `status = 'draft'`. A posted GRN is evidence — even an owner
-- cannot make a delivery disappear; the only exit is void-with-a-reason, which
-- leaves the record and its history in place. That is stricter than the
-- "admins can delete" house default and is the correct posture for evidence.
alter table public.goods_received_notes enable row level security;
alter table public.goods_received_lines enable row level security;

drop policy if exists "grn: members can select" on public.goods_received_notes;
create policy "grn: members can select" on public.goods_received_notes
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "grn: members can insert" on public.goods_received_notes;
create policy "grn: members can insert" on public.goods_received_notes
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "grn: members can update" on public.goods_received_notes;
create policy "grn: members can update" on public.goods_received_notes
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "grn: admins can delete drafts" on public.goods_received_notes;
create policy "grn: admins can delete drafts" on public.goods_received_notes
  for delete to authenticated using (public.is_org_admin(org_id) and status = 'draft');

drop policy if exists "grn_lines: members can select" on public.goods_received_lines;
create policy "grn_lines: members can select" on public.goods_received_lines
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "grn_lines: members can insert" on public.goods_received_lines;
create policy "grn_lines: members can insert" on public.goods_received_lines
  for insert to authenticated with check (org_id in (select public.current_org_ids()));
drop policy if exists "grn_lines: members can update" on public.goods_received_lines;
create policy "grn_lines: members can update" on public.goods_received_lines
  for update to authenticated
  using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
drop policy if exists "grn_lines: members can delete" on public.goods_received_lines;
create policy "grn_lines: members can delete" on public.goods_received_lines
  for delete to authenticated using (org_id in (select public.current_org_ids()));
