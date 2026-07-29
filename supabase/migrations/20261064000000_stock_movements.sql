-- O3 OPERATIONAL STOCK, part 2 of 3 — the APPEND-ONLY MOVEMENT LEDGER.
--
-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  THE ACCOUNTING BOUNDARY — UNCHANGED FROM 20261063000000, RESTATED       ║
-- ║  HERE BECAUSE THIS IS THE FILE SOMEBODY WILL BE TEMPTED TO EXTEND.       ║
-- ║                                                                          ║
-- ║  A stock movement is a QUANTITY MOVING BETWEEN PLACES. It is never a     ║
-- ║  cost, never a value, never a journal. NOTHING in this file writes to    ║
-- ║  `public.finances`, and no trigger here sits on it.                      ║
-- ║                                                                          ║
-- ║  Materials are ALREADY expensed by recordSupplierBill when the           ║
-- ║  supplier's invoice is recorded (20261009000000). Issuing 10 boards to   ║
-- ║  Job A therefore posts NO new expense — a second posting would           ║
-- ║  double-count the same spend against the same job. There is no unit      ║
-- ║  cost column anywhere in this milestone, so a valuation cannot be        ║
-- ║  computed even by accident. Stock valuation / COGS-on-issue is CEO       ║
-- ║  decision D1 and is UNDECIDED.                                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- ── APPEND-ONLY, AND WHAT THAT COSTS ────────────────────────────────────────
-- A movement is a statement about the physical world at a moment in time. It is
-- the same class of record as a supplier payment (20261047000000) and a posted
-- goods received note (20261059000000), and it gets the same treatment:
--
--   NO UPDATE  — a BEFORE UPDATE trigger refuses every field change outright.
--                Not "most fields": every field. There is nothing on a movement
--                that is a presentation detail; the notes explain the quantity
--                and rewriting them rewrites the explanation.
--   NO DELETE  — refused for EVERY role, service_role included, with the one
--                exception that is not a loophole: the row may go when its
--                ORGANISATION goes, so tenant teardown and GDPR erasure still
--                work. The two are told apart the way 20261047000000 tells them
--                apart — during a cascade the parent org is already invisible
--                from inside the trigger, so a targeted delete always sees it
--                and is always refused. No session flags, nothing spoofable.
--   CORRECTION — a mistake is fixed by INSERTING a `correction` movement that
--                names the movement it reverses (`corrects_movement_id`). The
--                original stays, visibly, for ever. That is the whole point:
--                "we thought 40 arrived, then found only 38" is two facts and a
--                stock system that can silently become one fact is a stock
--                system nobody can audit.
--
-- ── BALANCE IS DERIVED. THERE IS NO current_quantity, ANYWHERE ───────────────
-- `stock_balance(org, item, site)` sums `effect`; `stock_balances` is the view
-- over the same sum. A stored running total is a second source of truth, and
-- the day it disagrees with the ledger — a lost write, a restored backup, a
-- trigger that did not fire — it lies silently and for ever. Summing is also
-- fast enough by an enormous margin for the shape of tenant this serves: a
-- 5-50 person builder generates thousands of movements a year, not millions,
-- and the (org_id, stock_item_id, site_id) index below covers the sum exactly.
--
-- ── `effect`: THE SIGNED QUANTITY, ASSIGNED BY TRIGGER, THEN FROZEN ──────────
-- `qty` is always POSITIVE (CHECK qty > 0) — "how much moved" is not a signed
-- question, and letting a caller pass -5 to an issue is how a receipt becomes a
-- shrinkage. The DIRECTION comes from `movement_type`:
--
--     receipt · transfer_in · adjustment_in   →  +qty
--     issue   · transfer_out · adjustment_out →  -qty
--     correction                              →  -(effect of the movement it corrects)
--
-- The first six are pure functions of the type and are mirrored EXACTLY in
-- lib/stock/movements.ts (`movementSign`), so the number the app prints and the
-- number the database holds cannot diverge. `correction` is the one direction
-- that is NOT a function of its own row — it depends on the row it reverses —
-- so it is resolved once, at insert, by the trigger below and STORED. Storing
-- it (rather than joining at read time) is what keeps the balance a plain
-- `sum(effect)` with no correlated lookup, and the write-once trigger then
-- freezes it like every other column. This is a per-movement immutable derived
-- fact, NOT a running balance: nothing accumulates in it.
--
-- ── ORG BINDING IS STRUCTURAL WHEREVER IT CAN BE ─────────────────────────────
-- Composite FKs to (id, org_id) for every reference whose parent is mandatory,
-- so a cross-tenant movement is UNREPRESENTABLE for every role, service_role
-- included — the 20261059000000 note-2 reasoning. Where the reference is
-- OPTIONAL and must survive its parent (job_id), a composite FK is impossible
-- (ON DELETE SET NULL cannot coexist with a NOT NULL org_id in a composite FK,
-- the 20261011000000 constraint) and a BEFORE trigger guard does the job.
--
--   stock_item_id  composite → stock_items (id, org_id)          NOT NULL
--   site_id        composite → sites (id, org_id)                NOT NULL
--   grn_line_id    composite → goods_received_lines (id, org_id) nullable
--   corrects_movement_id composite → stock_movements (id, org_id) nullable
--   job_id         plain FK + trigger guard, ON DELETE SET NULL  nullable
--
-- All four composite FKs are `no action deferrable initially deferred`, NOT
-- restrict — 20261059000000 note 3, verbatim: RESTRICT can never be deferred,
-- so a `delete from organizations` that cascades the parent before the child
-- would abort tenant teardown outright. Deferring keeps the protection for a
-- real targeted delete (the orphan still exists at COMMIT → error) while
-- letting a teardown that removes both sides succeed.
--
-- ── WHY A VEHICLE IS NOT A STOCK LOCATION (this milestone) ───────────────────
-- Tempting, and wrong for now. `asset_assignments` already models CUSTODY of a
-- SERIALISED asset — one specific drill, held by one person or one van, with
-- `asset_assignments_one_open_idx` enforcing exactly one open assignment per
-- asset. That is an identity model: the thing is somewhere, and it is the same
-- thing when it comes back. Stock is a FUNGIBLE quantity model: 400 blocks are
-- not 400 identities and no one of them is "the" block. Bolting fungible
-- balances onto the custody table would either break its one-open invariant or
-- require a parallel quantity concept inside it, and bolting custody onto this
-- ledger would give a drill a balance of 1. They are different models of a
-- different question and this milestone keeps them apart. Van stock is a REAL
-- need and it is deferred debt, recorded here: the honest way in is a `sites`
-- kind or a first-class "mobile location", decided with the fleet lane, not a
-- vehicle_id column smuggled into this table.
--
-- ── WHY A JOB IS NOT A STOCK LOCATION ───────────────────────────────────────
-- `sites` deliberately excludes job sites (20261061000000's header: ownership,
-- lifecycle, cardinality, authority — four reasons, all still true). This
-- ledger takes that at its word. An ISSUE to a job is CONSUMPTION WITH JOB
-- PROVENANCE, not a transfer into a job-shaped location:
--
--   · the quantity leaves the company's stock and does not come back;
--   · `job_id` records WHY it left, so "what went to the Blackburn job" is
--     answerable, which is the actual question a builder asks;
--   · a job never has a balance, so nobody can be asked to count one, and a
--     job's stock can never go stale, negative, or need reconciling.
--
-- If material genuinely comes BACK off a job it is a `receipt`-shaped return to
-- the site it comes back to. That is a real gap and a deliberate one: a
-- return-from-job affordance is deferred debt (see docs/operational-stock.md),
-- because "did it come back or was it never used" is a stock-take question this
-- milestone does not yet ask.
--
-- Additive and reversible. To roll back:
--   drop view if exists public.stock_balances;
--   drop function if exists public.stock_balance(uuid, uuid, uuid);
--   drop trigger if exists stock_movements_activity on public.stock_movements;
--   drop function if exists public._tg_stock_movements_activity();
--   drop trigger if exists stock_movements_no_delete on public.stock_movements;
--   drop function if exists public.tg_stock_movements_no_delete();
--   drop trigger if exists stock_movements_append_only on public.stock_movements;
--   drop function if exists public.tg_stock_movements_append_only();
--   drop trigger if exists stock_movements_derive on public.stock_movements;
--   drop function if exists public.tg_stock_movements_derive();
--   drop table if exists public.stock_movements;
--   alter table public.goods_received_lines drop constraint if exists goods_received_lines_id_org_key;
--   alter table public.sites drop constraint if exists sites_id_org_key;

-- ── 1. Candidate keys the composite FKs need (additive; see 20261059 note 1) ─
-- A unique constraint on a SUPERSET of an existing PK can never reject a row,
-- so both of these are no-ops for existing data.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sites_id_org_key') then
    alter table public.sites add constraint sites_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'goods_received_lines_id_org_key') then
    alter table public.goods_received_lines
      add constraint goods_received_lines_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. stock_movements ──────────────────────────────────────────────────────
create table if not exists public.stock_movements (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  -- WHAT moved. Composite FK: a movement whose item belongs to another tenant
  -- is unrepresentable, for every role.
  stock_item_id uuid not null,

  -- WHERE it moved at. NOT NULL on purpose: a quantity with no place is a
  -- balance nowhere, and "we have 400 blocks, somewhere" is precisely the
  -- answer this milestone exists to replace. A movement always names the site
  -- whose balance it changes — an issue names the site the goods LEFT, a
  -- transfer is a PAIR of rows naming the two sites.
  site_id       uuid not null,

  movement_type text not null check (movement_type in (
    'receipt',        -- goods into a site (from a posted GRN line, or by hand)
    'issue',          -- goods out of a site, consumed (optionally to a job)
    'transfer_out',   -- goods leaving site A   ┐ always written as ONE pair,
    'transfer_in',    -- goods arriving site B  ┘ sharing transfer_group_id
    'adjustment_in',  -- stock-take / found: quantity created with no counterparty
    'adjustment_out', -- stock-take / loss:   quantity destroyed with no counterparty
    'correction'      -- reverses ONE earlier movement, named by corrects_movement_id
  )),

  -- HOW MUCH. Always positive; the sign lives in `effect` (header). 2dp to
  -- match goods_received_lines.qty_received and purchase_order_line_items.qty
  -- exactly, so 12.5 m³ of concrete crosses from order to receipt to stock
  -- without a rounding fork.
  qty           numeric(12, 2) not null check (qty > 0),

  -- THE SIGNED QUANTITY. Assigned by tg_stock_movements_derive on INSERT and
  -- frozen by tg_stock_movements_append_only thereafter; never supplied by a
  -- caller (the trigger overwrites whatever arrives, so forging is impossible).
  -- Balance = sum(effect). See the header for the sign rules.
  effect        numeric(12, 2) not null,

  -- WHEN it physically happened, which is not always when it was typed.
  occurred_at   timestamp with time zone not null default now(),

  -- WHO. One FK to users, deliberately: a second (`created_by`) would make
  -- `stock_movements → users` an ambiguous PostgREST embed pair and every bare
  -- `users(...)` embed on this table would PGRST201 — the incident pinned by
  -- __tests__/security/postgrest-embed-ambiguity.test.ts. The actor IS the
  -- creator here; there is no later editor, because there is no edit.
  actor_id      uuid references public.users(id) on delete set null,

  -- WHY. Free text, and REQUIRED for the three movement types that have no
  -- document behind them (both adjustments and a correction) — enforced by the
  -- CHECK below, not by the form. An adjustment with no reason is the exact
  -- shape a loss gets hidden in.
  notes         text check (notes is null or length(notes) <= 2000),

  -- ── provenance ────────────────────────────────────────────────────────────
  -- The posted GRN line these goods came off. Composite FK, so it can never
  -- name another tenant's delivery. Partial-unique below makes taking one
  -- delivery line into stock IDEMPOTENT.
  grn_line_id   uuid,

  -- WHY it left: the job it was issued to. NOT a location (header). Plain FK +
  -- trigger guard rather than composite, because losing a job must lose the
  -- LINK and never the movement — the ledger outlives every job run from it.
  job_id        uuid references public.jobs(id) on delete set null,

  -- THE FROZEN CONTRACT WITH THE M4 (material requests) LANE.
  -- PLAIN COLUMN, NO FOREIGN KEY — the M4 lane's `material_request_lines`
  -- table does not exist yet (it owns migration slots 20261066/67). Adding the
  -- FK is RECORDED DEFERRED DEBT: it belongs in the first M4 migration that
  -- creates the table, as
  --   alter table public.stock_movements
  --     add constraint stock_movements_mrl_org_fkey
  --     foreign key (material_request_line_id, org_id)
  --     references public.material_request_lines (id, org_id)
  --     on delete no action deferrable initially deferred;
  -- (which needs a material_request_lines_id_org_key candidate key). Until then
  -- this column is unvalidated by the database and is written ONLY by
  -- record_stock_issue's p_material_request_line_id parameter, whose signature
  -- is frozen for that lane.
  material_request_line_id uuid,

  -- The two halves of ONE transfer share this. Not an FK to anything — it is
  -- an identity for the pair, minted by record_stock_transfer.
  transfer_group_id uuid,

  -- The movement this one reverses. Composite self-FK, so a correction can
  -- never reach across tenants.
  corrects_movement_id uuid,

  created_at    timestamp with time zone not null default now(),

  -- Candidate key for the composite self-FK below.
  constraint stock_movements_id_org_key unique (id, org_id),

  constraint stock_movements_item_org_fkey
    foreign key (stock_item_id, org_id)
    references public.stock_items (id, org_id)
    on delete no action deferrable initially deferred,

  constraint stock_movements_site_org_fkey
    foreign key (site_id, org_id)
    references public.sites (id, org_id)
    on delete no action deferrable initially deferred,

  -- MATCH SIMPLE (the default): with grn_line_id null the constraint is not
  -- checked at all, which is exactly right for optional provenance. With it
  -- non-null both columns are non-null and the pair is enforced.
  constraint stock_movements_grn_line_org_fkey
    foreign key (grn_line_id, org_id)
    references public.goods_received_lines (id, org_id)
    on delete no action deferrable initially deferred,

  constraint stock_movements_corrects_org_fkey
    foreign key (corrects_movement_id, org_id)
    references public.stock_movements (id, org_id)
    on delete no action deferrable initially deferred,

  -- A reason is STRUCTURALLY required where there is no document behind the
  -- movement. Same shape as goods_received_notes_void_reason_required.
  constraint stock_movements_reason_required
    check (
      movement_type not in ('adjustment_in', 'adjustment_out', 'correction')
      or (notes is not null and btrim(notes) <> '')
    ),

  -- A correction names what it corrects; nothing else may.
  constraint stock_movements_correction_target
    check (
      (movement_type = 'correction') = (corrects_movement_id is not null)
    ),

  -- Only a transfer pair carries a group id.
  constraint stock_movements_transfer_group
    check (
      transfer_group_id is null
      or movement_type in ('transfer_out', 'transfer_in')
    ),

  -- Only a receipt can come off a delivery line.
  constraint stock_movements_grn_line_is_receipt
    check (grn_line_id is null or movement_type = 'receipt')
);

-- THE BALANCE INDEX. Every read this milestone performs — the per-site balance,
-- the item detail page, the low-stock sweep, and the negative-stock check
-- inside every outbound RPC — is `where org_id = ? and stock_item_id = ? [and
-- site_id = ?]`, so this covers all of them and the sum never touches the heap
-- ordering. org_id leads so it also serves the bare org_id predicate RLS applies.
create index if not exists stock_movements_balance_idx
  on public.stock_movements (org_id, stock_item_id, site_id);

-- "What has happened here lately" — the site page and the overview's recent feed.
create index if not exists stock_movements_org_recent_idx
  on public.stock_movements (org_id, occurred_at desc, id desc);

-- Provenance lookups: the GRN surface asks "is this delivery line in stock yet",
-- the job surface asks "what was issued to this job".
create index if not exists stock_movements_job_idx
  on public.stock_movements (job_id) where job_id is not null;
create index if not exists stock_movements_transfer_group_idx
  on public.stock_movements (transfer_group_id) where transfer_group_id is not null;
create index if not exists stock_movements_corrects_idx
  on public.stock_movements (corrects_movement_id) where corrects_movement_id is not null;

-- ── IDEMPOTENCY: ONE receipt movement per delivery line, EVER ────────────────
-- A double-submitted "receive into stock" (the storeman's thumb, a retried
-- request, a flaky signal in a yard) must add the delivery to stock ONCE. This
-- partial unique index is what makes that structural rather than hopeful: the
-- second attempt raises 23505 and record_stock_receipt_from_grn translates it
-- into "already in stock" — the operation is idempotent, not merely guarded.
--
-- DELIBERATE DEVIATION, STATED: the brief specified `... where movement_type =
-- 'receipt' and not corrected`. That predicate is not expressible without a
-- MUTABLE `corrected` column on this table, and a mutable column on an
-- append-only ledger is precisely the thing this file exists to refuse. It is
-- also unnecessary: every operational need the refinement would serve is
-- already served without it —
--   wrong SITE      → record_stock_transfer moves it; the goods are real and
--                     are already in the system.
--   wrong QUANTITY  → a `correction` reverses it, then an adjustment states the
--                     true figure with a reason.
--   never ARRIVED   → a `correction` reverses it, and then the GRN itself can
--                     be voided (the void guard in 20261065000000 refuses the
--                     void until exactly that correction exists), and the fresh
--                     GRN's NEW line ids are freely receivable.
-- So "not corrected" lands in the VOID GUARD, where it is a question about
-- another row and belongs, instead of in an index, where it would have cost the
-- ledger its immutability.
create unique index if not exists stock_movements_grn_line_receipt_uniq
  on public.stock_movements (grn_line_id)
  where movement_type = 'receipt' and grn_line_id is not null;

-- One correction per corrected movement. Without this, two operators each
-- reversing the same 40-block receipt take the balance 80 the wrong way.
create unique index if not exists stock_movements_corrects_uniq
  on public.stock_movements (corrects_movement_id)
  where corrects_movement_id is not null;

-- ── 3. Derivation + validation at INSERT ────────────────────────────────────
-- SECURITY DEFINER for the same reason tg_site_reference_org_integrity is: the
-- checks must read the TRUE owning org of the referenced job and the TRUE
-- effect of the corrected movement, not the subset the caller's RLS exposes.
-- It returns no data and its messages repeat only ids the caller supplied.
create or replace function public.tg_stock_movements_derive()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org    uuid;
  v_effect numeric(12, 2);
  v_type   text;
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
    select effect, movement_type into v_effect, v_type
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
    -- The reversal must be the WHOLE movement. A partial reversal is an
    -- adjustment with a reason, not a correction, and allowing "correct 10 of
    -- the 40" would let the same movement be whittled away in slices with no
    -- single row telling the truth about it.
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

drop trigger if exists stock_movements_derive on public.stock_movements;
create trigger stock_movements_derive
  before insert on public.stock_movements
  for each row execute function public.tg_stock_movements_derive();

-- ── 4. APPEND-ONLY: no update, ever ─────────────────────────────────────────
-- Every column, not most of them. There is no field on a movement that is
-- decoration: the notes explain the quantity, the timestamp places it, the
-- provenance justifies it. A ledger with an editable "notes" is a ledger whose
-- explanation can be rewritten after the fact.
create or replace function public.tg_stock_movements_append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'stock movement % is immutable — record a correction movement instead of editing it',
    old.id using errcode = 'check_violation';
end $$;

drop trigger if exists stock_movements_append_only on public.stock_movements;
create trigger stock_movements_append_only
  before update on public.stock_movements
  for each row execute function public.tg_stock_movements_append_only();

-- ── 5. NO DELETE — except when the tenant itself goes ───────────────────────
-- The 20261047000000 idiom, and it is load-bearing for org teardown exactly as
-- 20261052000000 documented: a cascading delete runs as a separate command
-- issued AFTER the parent row is gone, so from inside this trigger the
-- organisation is already invisible. A targeted delete always sees it. No
-- session flags, no pg_trigger_depth() heuristics, nothing a caller can spoof.
-- SECURITY DEFINER so the existence check is not filtered by the caller's RLS.
create or replace function public.tg_stock_movements_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'stock movement % cannot be deleted — the ledger is append-only. Record a correction movement instead',
      old.id using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists stock_movements_no_delete on public.stock_movements;
create trigger stock_movements_no_delete
  before delete on public.stock_movements
  for each row execute function public.tg_stock_movements_no_delete();

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
-- SELECT/INSERT for members; there is deliberately NO update policy and NO
-- delete policy at all. The triggers above already refuse both for every role,
-- and omitting the policies means a JWT caller is refused twice over — RLS
-- rejects the statement before the trigger is ever reached, so the error a
-- member sees is a clean "no rows" rather than a raw exception.
--
-- INSERT is open to members because the RPCs in 20261065000000 are SECURITY
-- INVOKER: they run as the caller and need the caller's own insert right. The
-- authority checks that matter (admin-only adjustments, negative-stock refusal,
-- non-posted GRNs) live in those functions, and a direct PostgREST insert that
-- bypasses them still cannot: forge a sign (the derive trigger overwrites
-- `effect`), cross a tenant (composite FKs), omit a reason (CHECK), or edit
-- anything afterwards. It CAN write an unserialised movement that drives a
-- balance negative — see 20261065000000's header for why that residue is
-- accepted and what closing it would cost.
alter table public.stock_movements enable row level security;

drop policy if exists "stock_movements: members can select" on public.stock_movements;
create policy "stock_movements: members can select" on public.stock_movements
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "stock_movements: members can insert" on public.stock_movements;
create policy "stock_movements: members can insert" on public.stock_movements
  for insert to authenticated with check (org_id in (select public.current_org_ids()));

-- ── 7. Balance — DERIVED, in exactly one place ──────────────────────────────
-- SECURITY INVOKER (the default, stated by its absence and asserted by the
-- security test). The caller's RLS therefore applies, which is both safe and
-- SOUND: `stock_movements: members can select` admits every row of the caller's
-- own org, so a member's sum is complete for their own tenant and empty for
-- everyone else's. A SECURITY DEFINER balance would be a privileged read of any
-- org's stock for anyone who could guess three uuids.
--
-- `coalesce(..., 0)`: an item that has never moved at a site has a balance of
-- zero, not null. "Nothing here" is a number.
create or replace function public.stock_balance(
  p_org_id  uuid,
  p_item_id uuid,
  p_site_id uuid
) returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(effect), 0)::numeric(12, 2)
    from public.stock_movements
   where org_id = p_org_id
     and stock_item_id = p_item_id
     and site_id = p_site_id;
$$;
grant execute on function public.stock_balance(uuid, uuid, uuid) to authenticated;

-- The same sum, for every (item, site) pair that has ever moved. A VIEW rather
-- than a materialised view: materialising it would reintroduce the stored
-- balance this milestone refuses, with a staleness window on top.
--
-- Views run with the privileges of their OWNER by default, which would bypass
-- the caller's RLS — so this one is explicitly `security_invoker`, making it
-- obey `stock_movements: members can select` exactly as a direct query would.
create or replace view public.stock_balances
with (security_invoker = true) as
  select org_id,
         stock_item_id,
         site_id,
         sum(effect)::numeric(12, 2) as quantity,
         max(occurred_at)            as last_movement_at,
         count(*)                    as movement_count
    from public.stock_movements
   group by org_id, stock_item_id, site_id;

grant select on public.stock_balances to authenticated;

-- ── 8. Tenant visibility for the movements that have no document ────────────
-- Triggers are the ONLY legal writers of activity_log (20260516200000). This
-- one is AFTER INSERT ONLY — never AFTER DELETE — so it can never sit on the
-- `delete from organizations` cascade path that 20261052000000 had to rescue.
--
-- Scoped to adjustments and corrections on purpose. A receipt has a delivery
-- note, an issue has a job, a transfer has its pair; those are self-explaining
-- and logging them would drown the feed. An adjustment is the one movement that
-- creates or destroys quantity with NO counterparty — it is the write that can
-- hide a loss, and it is the one the owner should see in their own feed.
create or replace function public._tg_stock_movements_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.movement_type in ('adjustment_in', 'adjustment_out', 'correction') then
    perform _record_activity(
      NEW.org_id, 'stock.' || NEW.movement_type, 'stock_movements', NEW.id,
      jsonb_build_object(
        'stock_item_id', NEW.stock_item_id,
        'site_id', NEW.site_id,
        'qty', NEW.qty,
        'effect', NEW.effect,
        'reason', NEW.notes,
        'corrects_movement_id', NEW.corrects_movement_id
      )
    );
  end if;
  return null;
end $$;

drop trigger if exists stock_movements_activity on public.stock_movements;
create trigger stock_movements_activity
  after insert on public.stock_movements
  for each row execute function public._tg_stock_movements_activity();

comment on table public.stock_movements is
  'Append-only operational quantity ledger. Balance is DERIVED (stock_balance / stock_balances) — there is no stored quantity anywhere. Posts NO cost anywhere: materials are already expensed by recordSupplierBill, so a second posting would double-count. See the 20261064000000 header.';
comment on column public.stock_movements.effect is
  'Signed quantity. Assigned by tg_stock_movements_derive on INSERT and frozen — never supplied by a caller. Balance = sum(effect).';
comment on column public.stock_movements.material_request_line_id is
  'FROZEN CONTRACT with the M4 material-requests lane. Plain column, NO foreign key — material_request_lines does not exist yet. Adding the composite FK is recorded deferred debt for the first M4 migration.';
comment on column public.stock_movements.job_id is
  'WHY the stock left, not WHERE it went. A job is not a stock location (20261061000000 excludes job sites); an issue is consumption with job provenance.';
