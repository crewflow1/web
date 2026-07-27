-- H2-CIS M3 follow-up — close the last hole in the CIS basis freeze.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
-- 20261051000000 froze `cis_bill_details` (the labour/materials split and the VAT
-- treatment) once a live CIS payment lands against a bill, because the partial-
-- payment maths apportions the basis by `cumulative allocated / bill gross` and
-- moving the split halfway through makes the second payment inconsistent with the
-- first. See docs/cis-domain.md §9.
--
-- But it left `finances.amount` and `finances.vat_rate` mutable, on the stated
-- grounds that `finances` is the general cost ledger and a tax migration should
-- not police writes to it. The numerator was frozen and the denominator was not.
-- Editing the bill produced exactly the inconsistency the freeze exists to
-- prevent, one door over:
--
--   * the edit SUCCEEDED silently, so the bill and the tax facts already reported
--     to HMRC for it permanently disagreed, with nothing surfacing the divergence;
--   * `tg_supplier_payment_allocation_cis` then compared the bill against the
--     prior allocations' snapshots and refused the NEXT CIS payment ("bill % has
--     changed since it was part-paid under CIS"). Correct — it cannot
--     mis-apportion — but the only way out was to void every earlier CIS payment
--     on the bill, and the user found that out one step too late.
--
-- ── THE DECISION (docs/cis-domain.md §8) ────────────────────────────────────
-- Refuse the EDIT, at the source, in the database. Not a UI warning and not a
-- guided recovery flow, for three reasons:
--
--   1. §10 of the domain doc already commits to this layer: a posted payment's tax
--      facts are protected "by database triggers … not by application code alone".
--      A guard the app can forget is not the same guarantee. This one binds
--      PostgREST, service_role scripts, imports and any future background job
--      identically.
--   2. It is the same rule 20261051 already applies to the split, applied to the
--      number the split is subtracted FROM. Freezing one and not the other was an
--      inconsistency, not a policy.
--   3. It moves the error to the moment of the mistake, while the user still has
--      the context to fix it, and names the recovery path in the message. The
--      previous behaviour reported it at the next payment, against a different
--      bill line, to someone who may not have made the edit.
--
-- ── WHY THE BLAST RADIUS IS SMALL, AND VERIFIED ─────────────────────────────
-- `finances` is a widely used table, so the guard is deliberately narrow on both
-- axes:
--
--   * COLUMNS. Only `amount` and `vat_rate` — the two writable inputs to the CIS
--     basis. (`vat_total` is a STORED GENERATED column, `round(amount * vat_rate /
--     100, 2)`, so it has no independent write path.) `category`, `notes`,
--     `job_id`, `reference`, `bill_date`, `receipt_url` and everything else stay
--     freely editable on a part-paid bill, because none of them can move a
--     deduction. Recategorising or re-tagging a CIS bill still works.
--   * ROWS. Only bills carrying at least one NON-VOIDED allocation with
--     `cis_deduction is not null`. That predicate is false for every ordinary
--     expense, every non-CIS supplier bill, and every legacy M2 allocation posted
--     before the deduction engine existed. Voided payments do not count — voiding
--     is precisely how a bill is released for correction.
--
-- Every writer of `finances` was enumerated before writing this. The only path in
-- the codebase that updates `amount` or `vat_rate` at all is PATCH
-- /api/finances/[id]; it now translates this refusal into an actionable 409.
-- `app/api/finances/route.ts` (POST insert, and a receipt_url-only update),
-- `app/(app)/imports/actions.ts`, `app/(app)/purchase-orders/actions.ts` and
-- `server/services/expense-drafts.ts` are all INSERTs and are untouched by an
-- UPDATE trigger. DELETE of a part-paid bill was already refused before this
-- migration, by `supplier_payment_allocations_bill_fk` (NO ACTION), as was any
-- change to the bill's `org_id` or `supplier_id` — that composite FK references
-- `finances (id, org_id, supplier_id)`, so those two columns are already frozen
-- for free and are not re-checked here.
--
-- ── THE M2/M3 INVARIANT STILL HOLDS ─────────────────────────────────────────
-- 20261051's header states that CIS code never inserts, updates or deletes a
-- `finances` row, which is what keeps `lib/profitability/compute.ts` and
-- `computeVatQuarter` byte-identical. That remains true. This is a BEFORE UPDATE
-- trigger that either raises or returns NEW completely unmodified — it never
-- assigns to a field, never writes a row, and never runs on INSERT. CIS still
-- cannot move commercial cost or VAT reporting by a penny; it can now only refuse
-- to let someone ELSE move it out from under a filed deduction.
--
-- ── A SECOND DOOR INTO THE SAME ROOM, FOUND WHILE CLOSING THE FIRST ─────────
-- 20261051's freeze on `cis_bill_details` is written `if tg_op = 'UPDATE' and
-- v_paid and (...)`. It therefore does not cover INSERT — and a bill can legally
-- be part-paid with NO details row at all (that is the deliberate conservative
-- default: no row means no materials claimed, so the whole net value is labour,
-- which over-deducts rather than under-deducts). So:
--
--   1. part-pay a bill that has no details row  → snapshot freezes materials = 0
--   2. INSERT a details row claiming materials  → allowed, freeze not consulted
--   3. the basis has now moved after a deduction was reported from it
--
-- That is the identical defect this migration exists to fix, reached through a
-- different column, and it produced the identical dead end (the next CIS payment
-- is refused with "has changed since it was part-paid"). Fixing the bill value
-- and leaving this would make the freeze documented in docs/cis-domain.md §5
-- and §10 untrue, so the guard is replaced below to cover INSERT too. The rest of
-- its body is reproduced verbatim from 20261051000000 — only the freeze condition
-- and its message change.
--
-- NOTE FOR REVIEW: this second fix was NOT in the brief. It is included because
-- it is the same one-line predicate and shipping a half-applied freeze would be
-- worse than shipping neither. It is separable — reverting just section 2 leaves
-- section 1 correct and self-consistent.
--
-- ── ON THE NAME ─────────────────────────────────────────────────────────────
-- The guard is called `tg_finances_bill_value_guard`, not `..._cis_basis_freeze`,
-- even though CIS is the only thing it checks today. 20261054000000 adds a second,
-- non-CIS rule to the SAME function — a general settlement floor — and there must
-- only ever be ONE trigger policing `finances`, or every bill edit pays for two
-- scans of the allocation ledger and their precedence is expressed by nothing but
-- alphabetical trigger order. Naming it for its subject (the bill's value) rather
-- than for its first rule means 20261054000000 extends the body and touches
-- nothing else: no rename to chase, no function created here only to be dropped
-- one migration later.
--
-- Additive, idempotent and reversible. To roll back:
--   drop trigger if exists finances_bill_value_guard on public.finances;
--   drop function if exists public.tg_finances_bill_value_guard();
--   -- and restore tg_cis_bill_details_guard() from 20261051000000.


-- ═══════════════════════════════════════════════════════════════════════════
-- finances GUARD — the bill's VALUE is frozen once part-paid under CIS
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER is load-bearing, not decoration. `supplier_payments` and
-- `supplier_payment_allocations` are restricted under M2's RLS, so an invoker-
-- rights trigger would see ZERO allocation rows for a caller who cannot read the
-- payment ledger, `exists(...)` would return false, and the guard would silently
-- pass for exactly the users most likely to be editing an expense. The guard has
-- to give the same answer on every write path — including service_role, which
-- bypasses RLS entirely.
create or replace function public.tg_finances_bill_value_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Cheap exit first, and it is the overwhelmingly common case: if neither input
  -- to the CIS basis moved, this is an ordinary edit and no lookup is needed.
  -- Receipt stamping, recategorising and job re-tagging therefore cost nothing.
  if new.amount is not distinct from old.amount
     and new.vat_rate is not distinct from old.vat_rate
  then
    return new;
  end if;

  -- `a.org_id = old.org_id` is not redundant: it makes the partial index
  -- `supplier_payment_allocations_cis_idx (org_id, finance_id) where cis_deduction
  -- is not null` usable as a prefix scan, and the composite bill FK guarantees the
  -- two org_ids agree by construction anyway.
  if exists (
    select 1
      from public.supplier_payment_allocations a
      join public.supplier_payments p on p.id = a.payment_id
     where a.org_id = old.org_id
       and a.finance_id = old.id
       and a.cis_deduction is not null
       and p.voided_at is null
  ) then
    raise exception
      'bill % has been part-paid under CIS — its value and VAT rate are frozen because a deduction has already been calculated and reported from them. Void the CIS payments against this bill to change it, then re-post them',
      old.id using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function public.tg_finances_bill_value_guard() is
  'Refuses UPDATE of finances.amount / finances.vat_rate on a bill that carries a '
  'live (non-voided) CIS allocation. The CIS basis is apportioned across partial '
  'payments by cumulative-allocated / bill-gross, so moving the bill''s value '
  'after a deduction has been posted and reported would leave the frozen '
  'snapshots inconsistent with the bill they were derived from. Every other '
  'column on the bill stays editable. See docs/cis-domain.md sections 8, 9 and 10.';

-- Fires before `finances_set_updated_at` (same timing, and 'b' sorts before 's'),
-- so a refused edit never gets as far as stamping a new updated_at. Cosmetic
-- either way — the raise aborts the whole statement — but deliberate.
drop trigger if exists finances_bill_value_guard on public.finances;
create trigger finances_bill_value_guard
  before update on public.finances
  for each row execute function public.tg_finances_bill_value_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. cis_bill_details GUARD — the freeze now covers INSERT, not just UPDATE
-- ═══════════════════════════════════════════════════════════════════════════
-- Reproduced from 20261051000000 with ONE change: the freeze condition. See the
-- header for why an INSERT after part-payment is the same defect as an UPDATE.
-- The other two jobs (basis sanity, reverse-charge coherence) are unchanged.
create or replace function public.tg_cis_bill_details_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_net      numeric(12, 2);
  v_vat_rate numeric(5, 2);
  v_paid     boolean;
begin
  select amount, vat_rate into v_net, v_vat_rate
    from public.finances where id = new.finance_id;
  if not found then
    raise exception 'bill % not found', new.finance_id using errcode = 'check_violation';
  end if;

  if round(new.materials_amount + new.citb_levy_amount, 2) > coalesce(v_net, 0) then
    raise exception
      'materials (%) plus CITB levy (%) exceed the bill''s net value (%) — the CIS basis cannot be negative',
      new.materials_amount, new.citb_levy_amount, v_net
      using errcode = 'check_violation';
  end if;

  -- NOTE ON `%` IN raise: plpgsql reads `%` as a placeholder, so a literal
  -- percent sign has to be `%%`. Every message below spells the unit out in
  -- words instead — an error a support engineer misreads is worse than a plain one.
  if new.vat_treatment = 'reverse_charge' and coalesce(v_vat_rate, 0) <> 0 then
    raise exception
      'bill % charges VAT at a rate of % percent — under the domestic reverse charge the supplier charges no VAT, so set the bill''s VAT rate to 0 and record the reverse-charge rate here',
      new.finance_id, v_vat_rate
      using errcode = 'check_violation';
  end if;

  -- Frozen once a CIS payment has been posted against the bill. Voided payments
  -- do not count — voiding is precisely how you release a bill to be corrected.
  select exists (
    select 1
      from public.supplier_payment_allocations a
      join public.supplier_payments p on p.id = a.payment_id
     where a.finance_id = new.finance_id
       and a.cis_deduction is not null
       and p.voided_at is null
  ) into v_paid;

  -- INSERT is included now. A bill part-paid with no details row froze its
  -- snapshot at materials = 0; creating the row afterwards would move the basis a
  -- deduction has already been reported from, exactly as editing it would.
  if v_paid and tg_op = 'INSERT' then
    raise exception
      'bill % has already been part-paid under CIS with no labour/materials split, so its basis is frozen at materials of zero. Void the payment to record a split, then re-post it',
      new.finance_id using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and v_paid and (
       new.materials_amount        is distinct from old.materials_amount
    or new.citb_levy_amount        is distinct from old.citb_levy_amount
    or new.vat_treatment           is distinct from old.vat_treatment
    or new.reverse_charge_vat_rate is distinct from old.reverse_charge_vat_rate
  ) then
    raise exception
      'bill % has already been part-paid under CIS — its labour/materials split and VAT treatment are frozen. Void the payment to change them',
      new.finance_id using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  return new;
end $$;

-- The trigger itself is unchanged (already BEFORE INSERT OR UPDATE), so only the
-- function body needed replacing. Recreated anyway for a clean standalone replay.
drop trigger if exists cis_bill_details_guard on public.cis_bill_details;
create trigger cis_bill_details_guard
  before insert or update on public.cis_bill_details
  for each row execute function public.tg_cis_bill_details_guard();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. A NAMING DEPENDENCY THAT IS LOAD-BEARING — recorded, and now enforced
-- ═══════════════════════════════════════════════════════════════════════════
-- No schema change here. This section exists because the two BEFORE INSERT
-- triggers on `supplier_payment_allocations` have an ORDERING dependency that
-- nothing in their own definitions states, and both of those definitions live in
-- migrations that are already applied in production and so cannot be edited.
--
-- PostgreSQL fires triggers of the same timing and event in ALPHABETICAL ORDER
-- OF TRIGGER NAME. The current order is:
--
--   1. supplier_payment_allocation_guard   (20261047000000)  — CAP 1 + CAP 2.
--      Takes `select … from public.finances where id = new.finance_id FOR UPDATE`.
--      MUST SORT FIRST. That lock is what makes a concurrent bill edit block, and
--      what guarantees every later reader in this statement sees the CURRENT
--      COMMITTED bill rather than a value about to change underneath it.
--
--   2. supplier_payment_allocations_cis    (20261051000000)  — the CIS engine.
--      Reads the same bill WITHOUT a lock to derive the basis and check it
--      against the cis_bill_net / cis_bill_gross the caller declared.
--      MUST SORT AFTER the guard, for exactly that reason.
--
-- The order holds today only because `supplier_payment_allocation_guard` and
-- `supplier_payment_allocations_cis` first differ where `_` (0x5F) meets `s`
-- (0x73), and `_` sorts lower. That is an accident of naming carrying a
-- correctness guarantee, and renaming either trigger looks like a harmless
-- tidy-up.
--
-- IT IS NOT. Inverting the order was tested directly against Postgres, by
-- renaming the guard so it sorted second: the CIS trigger then read the bill at
-- £1,000 while a concurrent uncommitted edit took it to £2,000, the guard blocked
-- and re-read £2,000, and the allocation COMMITTED carrying cis_bill_net =
-- £1,000 against a £2,000 bill. Every later CIS payment on that bill was then
-- refused with "has changed since it was part-paid" — a deduction reported to
-- HMRC that its own bill no longer explains, reached through a race rather than
-- an edit, which is precisely what section 1 of this migration exists to prevent.
--
-- ENFORCED BY: __tests__/integration/rls/trigger-firing-order.test.ts. It reads
-- pg_trigger, identifies the two triggers BY WHAT THEIR FUNCTIONS DO (does the
-- body take `for update` on the bill?) rather than by name, and fails with an
-- explanation if the locking one stops sorting first. A rename cannot make that
-- test vacuous — it makes it fail.
--
-- The same warning is attached to the triggers themselves below, so it is visible
-- from `\d+ supplier_payment_allocations` to whoever is doing the renaming. These
-- are catalog comments only: no table, column, index, function or trigger is
-- created, altered or dropped by them.
comment on trigger supplier_payment_allocation_guard on public.supplier_payment_allocations is
  'CAP 1 + CAP 2 over-allocation guard (20261047000000). MUST SORT ALPHABETICALLY '
  'BEFORE supplier_payment_allocations_cis: this trigger takes FOR UPDATE on the '
  'bill, and the CIS trigger reads that bill unlocked, so if the CIS trigger ran '
  'first it could derive a deduction from a bill value a concurrent uncommitted '
  'edit was about to change. Renaming either trigger is a financial-correctness '
  'change, not a tidy-up. Enforced by '
  '__tests__/integration/rls/trigger-firing-order.test.ts; reasoning in '
  '20261053000000 section 3.';

comment on trigger supplier_payment_allocations_cis on public.supplier_payment_allocations is
  'CIS deduction engine (20261051000000). MUST SORT ALPHABETICALLY AFTER '
  'supplier_payment_allocation_guard: it reads the bill WITHOUT a lock to derive '
  'the CIS basis, and depends on that guard having already taken FOR UPDATE on '
  'the bill so the value read is the current committed one. Renaming either '
  'trigger is a financial-correctness change, not a tidy-up. Enforced by '
  '__tests__/integration/rls/trigger-firing-order.test.ts; reasoning in '
  '20261053000000 section 3.';
