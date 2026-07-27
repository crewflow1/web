-- H2-CIS M2 — the supplier MONEY-OUT cash ledger.
--
-- WHY THIS TABLE EXISTS AT ALL. CrewFlow has no money-out ledger. `payments`
-- and `invoice_payments` (20261010000000) are money-IN: `payments` carries
-- `customer_id`, its allocations point at `invoices`, and its guard trigger
-- syncs invoice paid-status. Overloading either for supplier settlement would
-- put a receipt and a disbursement in one table with opposite signs and one
-- shared status trigger — the classic way a ledger stops reconciling. So this
-- is a NEW, parallel, deliberately symmetrical engine, not a fork of that one:
-- the shapes (parent cash event + per-target allocations + FOR UPDATE guard +
-- SECURITY INVOKER atomic RPC) are copied on purpose so the two read alike.
--
-- WHAT A BILL IS. Unchanged from 20261009000000: **a supplier bill IS a
-- `public.finances` row** (supplier_id + optional purchase_order_id + reference
-- + bill_date). There is no supplier_bills table and this migration does not
-- create one. `finances.amount` is NET; the GROSS liability is
-- `amount + vat_total` (vat_total is a stored generated column). This ledger
-- settles that gross figure and NEVER writes to `finances`.
--
-- GENERAL, NOT CIS-ONLY. This is a payable cash engine for EVERY supplier. A
-- builder's merchant, plant hire and skip company all settle through it.
-- `cis_withheld` is simply 0 for them, and every constraint below holds with a
-- zero withholding. CIS is an OPTIONAL semantic layered on top (see the CIS
-- authority trigger), not the reason the table exists.
--
-- ── THE LOAD-BEARING FINANCIAL INVARIANT ────────────────────────────────────
-- CIS withholding does NOT reduce commercial cost. Pay a subcontractor £10,000
-- gross with £2,000 CIS withheld and £8,000 leaves the bank — but the JOB STILL
-- COST £10,000. The £2,000 is the subcontractor's tax, held by you for onward
-- remittance to HMRC; it is a liability, never margin. Booking it as a saving
-- would inflate every affected job's profit by the deduction and produce a
-- CrewFlow-invented profit that vanishes the moment HMRC is paid.
--
-- This migration enforces that STRUCTURALLY rather than by convention: cost
-- lives in `finances.amount`, this ledger is a separate table, and NOTHING here
-- inserts, updates or deletes a `finances` row — no trigger, no RPC, no
-- generated column, no view. `lib/profitability/compute.ts` sums
-- `finances.amount`; `lib/purchase-orders/billing.ts` sums bill net + VAT;
-- `lib/commercial/*` (H2-CASH) reads quotes / invoices / invoice_payments. None
-- of them can observe this table, so a supplier payment — CIS or not — cannot
-- move a cost, a margin or a debtor figure. Proven in
-- __tests__/integration/rls/supplier-payments.test.ts.
--
-- ── AUDITABILITY: WRITE-ONCE + VOID, NOT EDIT ───────────────────────────────
-- A recorded subcontractor payment is a tax record. Its `cis_withheld` figure
-- is what gets reported to HMRC on the monthly return (M4/M5) and what appears
-- on the subcontractor's payment & deduction statement — a document they use to
-- claim the deduction back. Silently rewriting a historical payment would
-- desynchronise a return that has already been filed and a statement already
-- issued, with no trace that it ever said something else.
--
-- So the financial fields are IMMUTABLE once posted and there is NO destructive
-- edit and NO delete. A mistake is corrected the way accountants correct one:
--   * VOID the payment (records who, when and why; the row stays forever), then
--   * RECORD A NEW, CORRECT PAYMENT.
-- A voided payment is excluded from every position and from both over-allocation
-- caps, so the corrected payment has room to be allocated. Voiding is one-way —
-- a voided row is terminal and cannot be un-voided or re-edited (the same
-- draft→terminal shape as 20261034000000). Allocations are frozen outright:
-- they cannot be updated at all, because "which bill did this money settle" is
-- exactly the fact a correction must not be able to rewrite in place.
--
-- Deletion is refused for EVERY role including service_role, with one exception
-- that is not a loophole: the row may go when its ORGANISATION goes, so tenant
-- teardown / GDPR erasure still works. The guard distinguishes the two cases by
-- looking for the parent org — during an org cascade the parent row is already
-- invisible to the child's delete, so a targeted delete is always refused and a
-- teardown always succeeds.
--
-- KNOWN UPSTREAM LIMITATION, PRE-EXISTING AND NOT INTRODUCED HERE: on this
-- schema `delete from organizations` ALREADY fails for any org holding a
-- `finances` row, because `_tg_finances_activity` fires on the cascade delete
-- and `_record_activity` then inserts an `activity_log` row referencing the
-- organisation that was just removed (activity_log_org_id_fkey). Verified
-- against a bare org + one finances row with none of this milestone's tables
-- involved. The org-absence branch of the guards below is therefore correct and
-- is exercised for an allocation-free payment, but the full with-allocations
-- teardown cannot complete until that upstream trigger is fixed — a fix that
-- belongs to the deferred GDPR/teardown workstream, not to a money migration.
-- Consequence to be aware of: while that defect stands, an org that has
-- supplier-payment allocations has no deletion path at all, because this ledger
-- (correctly) offers no row-by-row escape hatch.
--
-- ── RLS: ADMIN-ONLY, DELIBERATELY STRICTER THAN `payments` ──────────────────
-- `payments` (money-in) is member-writable. This is NOT, and the difference is
-- intentional. Recording a payment here asserts two things a member has no
-- authority to assert: that cash left the company's bank account, and that a
-- sum was withheld as another business's tax. The second creates an HMRC
-- liability. CIS M1 already set this boundary — `cis_subcontractors` is
-- admin-only (the staff_secrets shape) — and M4/M5 will compute monthly returns
-- from exactly this ledger, so it carries the same authority as the profile it
-- pays against.
--
-- Note what admin-only here does NOT hide: `finances` stays member-readable, so
-- job costs, PO billing and profitability are unchanged for every member. Only
-- the CASH and TAX layer is restricted. In a 5-50 person builder, paying bills
-- is an owner/office function; the labourer who records an expense receipt does
-- not settle the ledger. See the policies at the foot of this file.
--
-- Additive, idempotent and reversible. To roll back:
--   drop function if exists public.record_supplier_payment(uuid,uuid,date,text,text,numeric,numeric,text,jsonb);
--   drop table if exists public.supplier_payment_allocations;
--   drop table if exists public.supplier_payments;
--   drop function if exists public.tg_supplier_payment_allocation_guard();
--   drop function if exists public.tg_supplier_payment_allocations_frozen();
--   drop function if exists public.tg_supplier_payment_allocations_no_delete();
--   drop function if exists public.tg_supplier_payments_write_once();
--   drop function if exists public.tg_supplier_payments_no_delete();
--   drop function if exists public.tg_supplier_payments_cis_authority();
--   alter table public.finances drop constraint if exists finances_id_org_supplier_key;
-- (`suppliers_id_org_key` is left alone — cis_subcontractors also depends on it.)

-- ── composite-FK target on finances ──────────────────────────────────────────
-- ORG **AND SUPPLIER** BINDING, DECLARATIVELY. `finances` has PK (id) only, so
-- an allocation could otherwise name any bill in the database. Adding
-- (id, org_id, supplier_id) as a candidate key lets the allocation FK carry all
-- three columns at once, which enforces THREE separate things in one constraint
-- that no procedural code can be tricked past — it binds service_role too:
--
--   1. CROSS-ORG:      the bill must be in the allocation's org.
--   2. CROSS-SUPPLIER: the bill's supplier must be the PAYMENT's supplier (the
--                      allocation's supplier_id is itself FK-bound to the
--                      payment, so equality is transitive and total).
--   3. NOT-A-BILL:     `finances.supplier_id` is NULLABLE. The allocation's is
--                      NOT NULL, so a MATCH SIMPLE composite FK can NEVER match
--                      a finances row with no supplier. A plain cost with no
--                      payee is structurally unallocatable — you cannot settle
--                      a fuel receipt that names nobody.
--
-- And a customer invoice can never be a target because `invoices` is a
-- different table entirely; there is no column here that could name one.
--
-- WHY THIS AND NOT THE 20261024 SECURITY DEFINER ORG-MATCH TRIGGER: that pattern
-- was chosen there for ON DELETE SET NULL links over a NOT NULL org_id, where a
-- composite FK would have forced a cascade and destroyed the row. That objection
-- does not apply — these links are NOT NULL and must never be nulled. Where a
-- declarative FK is available it is strictly stronger: it holds for every role,
-- needs no plpgsql, and cannot be bypassed by a direct PostgREST write. A
-- trigger is used below only for the checks no FK can express (sums, locking,
-- immutability, CIS authority).
--
-- ON DELETE is deliberately left as NO ACTION rather than RESTRICT or CASCADE:
--   * CASCADE would let deleting a bill silently erase the record of paying it.
--   * RESTRICT checks immediately and would therefore BREAK org teardown, where
--     `finances` and the allocations are removed inside the same statement.
--   * NO ACTION defers its check to end-of-statement: a targeted `delete from
--     finances` with a payment against it is refused, while `delete from
--     organizations` (which removes both) succeeds. Both properties are tested.
--
-- Lock note: builds a unique index under a brief ACCESS EXCLUSIVE lock.
-- `finances` is a per-tenant cost list (thousands of rows at most for a 5-50
-- person builder), so this is negligible. Wrapped so re-runs are no-ops.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'finances_id_org_supplier_key'
  ) then
    alter table public.finances
      add constraint finances_id_org_supplier_key unique (id, org_id, supplier_id);
  end if;
end $$;

comment on constraint finances_id_org_supplier_key on public.finances is
  'Composite-FK target for supplier_payment_allocations (H2-CIS M2). Binds an '
  'allocation to a bill in the same org AND the same supplier in one constraint. '
  'Because supplier_id is nullable here and NOT NULL there, a finances row with '
  'no supplier can never be allocated against.';

-- ── supplier_payments — the cash event ───────────────────────────────────────
create table if not exists public.supplier_payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  supplier_id  uuid not null,

  -- The date the money actually left the account (not when it was typed in).
  paid_at      date not null,
  method       text not null default 'bank_transfer'
               check (method in ('bank_transfer', 'card', 'cash', 'cheque', 'other')),
  -- The bank/cheque reference. Part of the audit evidence, hence frozen below.
  reference    text,

  -- ── the settlement triple ─────────────────────────────────────────────────
  -- GROSS is what the payment SETTLES — the value knocked off the supplier's
  -- account, VAT included. CIS_WITHHELD is the subcontractor's tax you kept back
  -- for HMRC. NET_PAID is the cash that genuinely left the bank.
  --
  -- All three are stored rather than deriving net_paid as a GENERATED column, on
  -- the same principle as CIS M1's rate authority: a caller that sends an
  -- inconsistent triple should get an ERROR, not a silent correction to a number
  -- they did not ask for. The CHECK below makes the identity unforgeable while
  -- keeping the caller's arithmetic visible and auditable.
  --
  -- NOT MODELLED, DELIBERATELY: real CIS is deducted from the LABOUR element
  -- only — materials, plant hire, VAT and CIS-exempt costs are excluded from the
  -- deductible base. Splitting a bill into labour/materials is M3 work with its
  -- own domain rules, and shipping a half-right calculator that quietly deducts
  -- from materials would produce a WRONG return. So M2 stores the amount the
  -- operator actually withheld and does not compute it. Nothing here claims to.
  gross_amount numeric(12, 2) not null check (gross_amount >= 0),
  cis_withheld numeric(12, 2) not null default 0 check (cis_withheld >= 0),
  net_paid     numeric(12, 2) not null check (net_paid >= 0),

  notes        text,

  -- ── void (the correction mechanism — see the header) ──────────────────────
  voided_at    timestamptz,
  voided_by    uuid references public.users(id) on delete set null,
  void_reason  text,

  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- THE identity. net = gross − withheld, always, for every role.
  constraint supplier_payments_settlement_identity
    check (net_paid = gross_amount - cis_withheld),
  -- Implied by the identity plus net_paid >= 0, but stated so a violation names
  -- the real-world error ("you can't withhold more than you're settling").
  constraint supplier_payments_withheld_within_gross
    check (cis_withheld <= gross_amount),

  -- Cross-tenant-safe supplier link. NO ACTION (not RESTRICT): a targeted delete
  -- of a supplier you have paid is refused — the cash record outlives the
  -- address-book entry, which is the whole point of a ledger — but an org
  -- teardown, which removes both in one statement, still succeeds.
  constraint supplier_payments_supplier_fk
    foreign key (supplier_id, org_id) references public.suppliers (id, org_id),

  -- Composite-FK target for allocations: binds an allocation to this payment's
  -- org AND supplier in one constraint (see the allocations table).
  constraint supplier_payments_id_org_supplier_key unique (id, org_id, supplier_id),

  -- A void is evidenced or it isn't a void. `voided_by` is NOT required because
  -- its FK is ON DELETE SET NULL — a deleted user must not be able to
  -- retroactively invalidate a historical row.
  --
  -- NOTE THE EXPLICIT `void_reason is not null`. Without it this CHECK has a
  -- NULL hole and is worthless: `length(trim(null))` is NULL, so the second
  -- branch evaluates to `true and null` = NULL, and `false or NULL` = NULL —
  -- which a CHECK treats as SATISFIED. A reasonless void would sail through.
  -- (Caught by the smoke test; same class of trap CIS M1 documents on
  -- cis_subcontractors_rate_matches_status.)
  constraint supplier_payments_void_evidenced check (
    (voided_at is null and void_reason is null)
    or (
      voided_at is not null
      and void_reason is not null
      and length(trim(void_reason)) between 1 and 500
    )
  )
);

comment on table public.supplier_payments is
  'H2-CIS M2 — money-OUT cash ledger. One row per real-world payment to a '
  'supplier. GENERAL: works for every supplier; CIS withholding is optional and '
  'zero for non-subcontractors. Write-once: financial fields are immutable and '
  'the row can never be deleted — correct by voiding and re-recording. '
  'Admin-only RLS: this is cash and tax authority, not operational data.';
comment on column public.supplier_payments.gross_amount is
  'Value SETTLED against the supplier account, VAT included. NOT a cost — cost '
  'lives in finances.amount and this ledger never writes it.';
comment on column public.supplier_payments.cis_withheld is
  'Subcontractor tax withheld for onward remittance to HMRC. A LIABILITY, never '
  'margin: it must never reduce job cost or profit. 0 for non-CIS suppliers.';
comment on column public.supplier_payments.net_paid is
  'Cash that actually left the bank = gross_amount - cis_withheld (DB-enforced).';
comment on column public.supplier_payments.voided_at is
  'Set once, never cleared. A voided payment is terminal and is excluded from '
  'all positions and both over-allocation caps.';

create index if not exists supplier_payments_org_supplier_idx
  on public.supplier_payments (org_id, supplier_id, paid_at desc);
create index if not exists supplier_payments_org_paid_at_idx
  on public.supplier_payments (org_id, paid_at desc);
-- Partial index for the CIS monthly-return sweep M4/M5 will need.
create index if not exists supplier_payments_cis_idx
  on public.supplier_payments (org_id, paid_at)
  where cis_withheld > 0 and voided_at is null;

-- ── supplier_payment_allocations — payment → bill(s) ─────────────────────────
-- One row per bill this payment settles. `supplier_id` is carried here NOT as a
-- second source of truth but as the JOIN COLUMN that makes both bindings
-- declarative: it is FK-bound to the payment on one side and to the bill on the
-- other, so the two are forced equal by the database rather than by app code.
create table if not exists public.supplier_payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  payment_id  uuid not null,
  supplier_id uuid not null,
  -- The `finances` row being settled. Named finance_id, not bill_id, because a
  -- bill IS a finances row — the name should not imply a table that isn't there.
  finance_id  uuid not null,
  amount      numeric(12, 2) not null check (amount > 0),
  created_by  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),

  -- Binds org AND supplier to the parent payment. CASCADE is safe here precisely
  -- because the parent can only be deleted during org teardown (see the delete
  -- guard) — in normal operation a payment is voided, never removed, and its
  -- allocations are kept as the record of what the voided payment had claimed.
  constraint supplier_payment_allocations_payment_fk
    foreign key (payment_id, org_id, supplier_id)
    references public.supplier_payments (id, org_id, supplier_id) on delete cascade,

  -- Binds org AND supplier to the bill, and refuses a supplier-less finances row
  -- outright. NO ACTION — see the note on finances_id_org_supplier_key.
  constraint supplier_payment_allocations_bill_fk
    foreign key (finance_id, org_id, supplier_id)
    references public.finances (id, org_id, supplier_id),

  -- One line per bill per payment. Keeps the per-bill maths legible and stops a
  -- double-submitted line from reading as two genuine settlements.
  constraint supplier_payment_allocations_one_per_bill unique (payment_id, finance_id)
);

comment on table public.supplier_payment_allocations is
  'H2-CIS M2 — which supplier bills (finances rows) a supplier_payment settled. '
  'Frozen after insert: no UPDATE, no targeted DELETE. Correct by voiding the '
  'parent payment and recording a new one.';

create index if not exists supplier_payment_allocations_finance_idx
  on public.supplier_payment_allocations (finance_id);
create index if not exists supplier_payment_allocations_org_idx
  on public.supplier_payment_allocations (org_id);

-- ── CIS AUTHORITY — you cannot withhold tax from a non-subcontractor ─────────
-- Withholding CIS from a builders' merchant is not a rounding error, it is
-- deducting tax from a business that owes none. `cis_withheld > 0` therefore
-- requires the supplier to actually BE a CIS subcontractor, i.e. to have a
-- `cis_subcontractors` profile (CIS M1).
--
-- WHAT THIS DELIBERATELY DOES **NOT** DO: it does not require the profile's
-- CURRENT `deduction_rate` to be > 0, and it does not recompute the withheld
-- amount from that rate. The rate that governs a payment is the one that applied
-- ON THE DAY IT WAS MADE. A profile flagged `verification_required` today (rate
-- NULL) must not make last month's correctly-deducted payment unrecordable, and
-- a subcontractor who moves 30% → gross must not retro-invalidate history. The
-- present state of a profile is not authority over the past. So the check is
-- categorical ("is this a subcontractor at all?"), which is time-invariant, and
-- never arithmetic.
--
-- SECURITY DEFINER because `cis_subcontractors` is admin-only under RLS — the
-- guard must give the same answer on every write path, including service_role
-- and a future background job. Mirrors tg_finances_bill_org_integrity.
create or replace function public.tg_supplier_payments_cis_authority()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.cis_withheld > 0 and not exists (
    select 1 from public.cis_subcontractors c
     where c.org_id = new.org_id and c.supplier_id = new.supplier_id
  ) then
    raise exception
      'CIS cannot be withheld from supplier % — it has no CIS subcontractor record',
      new.supplier_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists supplier_payments_cis_authority on public.supplier_payments;
create trigger supplier_payments_cis_authority
  before insert on public.supplier_payments
  for each row execute function public.tg_supplier_payments_cis_authority();

-- ── WRITE-ONCE — the only permitted UPDATE is a void ─────────────────────────
-- Everything that determines what was paid, to whom, when, and how much tax was
-- withheld is frozen at INSERT. `notes` stays editable (annotation, not record);
-- the void triple may go from unset to set exactly once. Anything else raises,
-- for every role including service_role — RLS decides WHO may write, this
-- decides WHAT a write may say, and the two are independent controls.
create or replace function public.tg_supplier_payments_write_once()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Terminal: a voided payment is history and history does not move.
  if old.voided_at is not null then
    raise exception
      'supplier payment % is voided — a voided payment is final. Record a new payment instead',
      old.id using errcode = 'check_violation';
  end if;

  if new.id           is distinct from old.id
     or new.org_id       is distinct from old.org_id
     or new.supplier_id  is distinct from old.supplier_id
     or new.paid_at      is distinct from old.paid_at
     or new.method       is distinct from old.method
     or new.reference    is distinct from old.reference
     or new.gross_amount is distinct from old.gross_amount
     or new.cis_withheld is distinct from old.cis_withheld
     or new.net_paid     is distinct from old.net_paid
     or new.created_by   is distinct from old.created_by
     or new.created_at   is distinct from old.created_at
  then
    raise exception
      'supplier payment % is immutable once recorded — void it and record a corrected payment',
      old.id using errcode = 'check_violation';
  end if;

  -- A void must name its author even when it arrives as a direct PostgREST
  -- PATCH that "forgot" to. auth.uid() is NULL for service_role, which is
  -- correct: an unattributable void is recorded as unattributed, not as someone.
  if new.voided_at is not null and new.voided_by is null then
    new.voided_by := auth.uid();
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists supplier_payments_write_once on public.supplier_payments;
create trigger supplier_payments_write_once
  before update on public.supplier_payments
  for each row execute function public.tg_supplier_payments_write_once();

-- ── NO DELETE — except when the tenant itself goes ───────────────────────────
-- A cash/tax record is never removed by a user action. The single exception is
-- organisation teardown, so tenant deletion and GDPR erasure keep working.
--
-- HOW THE TWO ARE TOLD APART, RELIABLY: a cascading delete runs as a SEPARATE
-- command issued after the parent row is gone, so from inside this trigger the
-- organisation is already invisible. A targeted delete always sees it. No
-- session flags, no pg_trigger_depth() heuristics, nothing a caller can spoof.
create or replace function public.tg_supplier_payments_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'supplier payment % cannot be deleted — void it instead (the ledger is append-only)',
      old.id using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists supplier_payments_no_delete on public.supplier_payments;
create trigger supplier_payments_no_delete
  before delete on public.supplier_payments
  for each row execute function public.tg_supplier_payments_no_delete();

-- ── ALLOCATIONS ARE FROZEN OUTRIGHT ──────────────────────────────────────────
-- No editable field exists on an allocation: every column is either the money,
-- the binding, or the audit stamp. "Which bill did this settle" is precisely the
-- fact a correction must not rewrite in place, so there is no permitted UPDATE
-- at all — unlike the parent, which allows notes and the void.
create or replace function public.tg_supplier_payment_allocations_frozen()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception
    'supplier payment allocations are immutable (allocation %) — void the payment and record a corrected one',
    old.id using errcode = 'check_violation';
end $$;

drop trigger if exists supplier_payment_allocations_frozen on public.supplier_payment_allocations;
create trigger supplier_payment_allocations_frozen
  before update on public.supplier_payment_allocations
  for each row execute function public.tg_supplier_payment_allocations_frozen();

-- Deletable only when the parent payment or the whole org has already gone —
-- i.e. only as part of a cascade that is itself only reachable during teardown.
create or replace function public.tg_supplier_payment_allocations_no_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.supplier_payments where id = old.payment_id)
     and exists (select 1 from public.organizations where id = old.org_id) then
    raise exception
      'supplier payment allocation % cannot be deleted — void the payment instead',
      old.id using errcode = 'check_violation';
  end if;
  return old;
end $$;

drop trigger if exists supplier_payment_allocations_no_delete on public.supplier_payment_allocations;
create trigger supplier_payment_allocations_no_delete
  before delete on public.supplier_payment_allocations
  for each row execute function public.tg_supplier_payment_allocations_no_delete();

-- ── THE OVER-ALLOCATION + CONCURRENCY GUARD ──────────────────────────────────
-- Two caps, both race-free, mirroring tg_invoice_payments_no_over_allocate:
--
--   CAP 1  Σ allocations of a payment ≤ that payment's gross_amount.
--          (You cannot spend £1,200 of a £1,000 payment.)
--   CAP 2  Σ live allocations against a bill ≤ that bill's GROSS value
--          (finances.amount + vat_total).
--          (You cannot pay £1,200 against a £1,000 bill.)
--
-- CAP 2 counts only allocations whose parent payment is NOT voided — that is
-- what makes void-then-re-record work: the mistaken payment stops consuming the
-- bill's capacity the instant it is voided, so the corrected one fits.
--
-- CONCURRENCY. Both parents are locked FOR UPDATE before their sum is read, so
-- two concurrent allocations can never both read a stale "already allocated"
-- and both insert. LOCK ORDER IS ALWAYS PAYMENT-THEN-BILL, never the reverse:
-- that total order is what makes deadlock impossible when two transactions touch
-- the same pair from different directions. Without these locks the guard would
-- be advisory — each transaction would independently observe a total that was
-- true when it looked and false when it committed.
--
-- +0.005 tolerance: half a penny, below the resolution of numeric(12,2), so a
-- float-rounded amount arriving from the app can't read as an over-allocation.
-- Identical to lib/money's ALLOCATION_TOLERANCE, by design.
--
-- SECURITY DEFINER so the guard sees the true totals regardless of the caller's
-- RLS visibility — a partial view of sibling allocations would under-count and
-- let an over-allocation through.
create or replace function public.tg_supplier_payment_allocation_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_gross      numeric(12, 2);
  v_voided     timestamptz;
  v_allocated  numeric(12, 2);
  v_bill_gross numeric(12, 2);
begin
  -- ── CAP 1 — lock the payment FIRST (see lock order above) ────────────────
  select gross_amount, voided_at into v_gross, v_voided
    from public.supplier_payments where id = new.payment_id for update;
  if not found then
    raise exception 'supplier payment % not found', new.payment_id
      using errcode = 'check_violation';
  end if;
  if v_voided is not null then
    raise exception 'supplier payment % is voided and cannot be allocated', new.payment_id
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_allocated
    from public.supplier_payment_allocations
   where payment_id = new.payment_id and id <> new.id;

  if v_allocated + new.amount > v_gross + 0.005 then
    raise exception
      'supplier payment % over-allocated: % of % already allocated, cannot add %',
      new.payment_id, v_allocated, v_gross, new.amount
      using errcode = 'check_violation';
  end if;

  -- ── CAP 2 — then lock the bill ───────────────────────────────────────────
  -- Bill GROSS is what the supplier is owed: net amount plus its generated VAT.
  select round(amount + coalesce(vat_total, 0), 2) into v_bill_gross
    from public.finances where id = new.finance_id for update;
  if not found then
    raise exception 'bill % not found', new.finance_id using errcode = 'check_violation';
  end if;
  -- A zero/negative finances row is a credit note or a correction, not a
  -- payable. Refusing it explicitly beats letting CAP 2 fail with a confusing
  -- "over-allocated by £0.01" message.
  if v_bill_gross <= 0 then
    raise exception
      'bill % has no positive value to settle (gross %)', new.finance_id, v_bill_gross
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(a.amount), 0) into v_allocated
    from public.supplier_payment_allocations a
    join public.supplier_payments p on p.id = a.payment_id
   where a.finance_id = new.finance_id
     and a.id <> new.id
     and p.voided_at is null;

  if v_allocated + new.amount > v_bill_gross + 0.005 then
    raise exception
      'bill % over-paid: % of % already settled, cannot add %',
      new.finance_id, v_allocated, v_bill_gross, new.amount
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists supplier_payment_allocation_guard on public.supplier_payment_allocations;
create trigger supplier_payment_allocation_guard
  before insert on public.supplier_payment_allocations
  for each row execute function public.tg_supplier_payment_allocation_guard();

-- ── ATOMIC RECORD — payment + all its allocations in ONE transaction ─────────
-- SECURITY INVOKER, so RLS, both composite FKs and the guard trigger all apply
-- to the caller exactly as they would to a direct write. A definer function
-- here would hand every authenticated user the admin's write authority, which
-- is the opposite of the point.
--
-- The explicit is_org_admin() check is for the ERROR MESSAGE, not the control —
-- RLS refuses a non-admin either way, but "only an owner or admin…" is a far
-- better answer than a bare policy violation.
--
-- All-or-nothing: if any allocation trips a cap or a binding, the whole payment
-- rolls back. A half-recorded payment is worse than none.
create or replace function public.record_supplier_payment(
  p_org_id      uuid,
  p_supplier_id uuid,
  p_paid_at     date,
  p_method      text,
  p_reference   text,
  p_gross_amount numeric,
  p_cis_withheld numeric,
  p_notes       text,
  p_allocations jsonb
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_payment_id uuid;
  v_gross      numeric(12, 2);
  v_withheld   numeric(12, 2);
  v_alloc      record;
begin
  if p_org_id is null or not public.is_org_admin(p_org_id) then
    raise exception 'only an owner or admin can record a supplier payment'
      using errcode = 'insufficient_privilege';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' then
    raise exception 'allocations must be a json array' using errcode = 'invalid_parameter_value';
  end if;

  -- Round ONCE, here, so net_paid is derived from exactly the values stored —
  -- rounding gross and withheld independently of the difference is how a penny
  -- goes missing and the identity CHECK fires on an otherwise valid payment.
  v_gross    := round(coalesce(p_gross_amount, 0), 2);
  v_withheld := round(coalesce(p_cis_withheld, 0), 2);

  insert into public.supplier_payments (
    org_id, supplier_id, paid_at, method, reference,
    gross_amount, cis_withheld, net_paid, notes, created_by
  ) values (
    p_org_id, p_supplier_id, p_paid_at,
    coalesce(p_method, 'bank_transfer'), p_reference,
    v_gross, v_withheld, v_gross - v_withheld,
    p_notes, auth.uid()
  )
  returning id into v_payment_id;

  for v_alloc in
    select (elem->>'finance_id')::uuid as finance_id,
           (elem->>'amount')::numeric  as amount
      from jsonb_array_elements(p_allocations) as elem
  loop
    insert into public.supplier_payment_allocations
      (org_id, payment_id, supplier_id, finance_id, amount, created_by)
    values (
      p_org_id, v_payment_id, p_supplier_id, v_alloc.finance_id,
      round(v_alloc.amount, 2), auth.uid()
    );
  end loop;

  return v_payment_id;
end $$;

grant execute on function public.record_supplier_payment(
  uuid, uuid, date, text, text, numeric, numeric, text, jsonb
) to authenticated;

-- ── RLS — ADMIN ONLY (both tables). Justified at length in the header. ───────
-- One `for all` policy per table, the staff_secrets / cis_subcontractors shape:
-- a same-org member gets zero rows rather than a redacted row, and a direct
-- PostgREST caller bypassing the app is refused identically. No delete is
-- reachable through it regardless — the delete guards above refuse every role.
alter table public.supplier_payments enable row level security;
alter table public.supplier_payment_allocations enable row level security;

drop policy if exists "supplier_payments: admin all" on public.supplier_payments;
create policy "supplier_payments: admin all" on public.supplier_payments
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "supplier_payment_allocations: admin all" on public.supplier_payment_allocations;
create policy "supplier_payment_allocations: admin all" on public.supplier_payment_allocations
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));
