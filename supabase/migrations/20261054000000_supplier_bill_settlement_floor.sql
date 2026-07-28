-- H2-CIS M2 follow-up — a bill may not be cut below the money already paid
-- against it.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
-- 20261047000000's CAP 2 caps Σ live allocations against a bill at that bill's
-- GROSS value (`amount + vat_total`). It is the guard that makes "you cannot pay
-- £1,200 against a £1,000 bill" true. But it is a BEFORE INSERT trigger on
-- `supplier_payment_allocations`, so it only ever runs when MONEY ARRIVES.
-- Nothing re-checked it when the BILL moved underneath payments already recorded
-- against it:
--
--   1. bill £1,000 gross, part-paid £900        → CAP 2 satisfied, 900 ≤ 1000
--   2. `update finances set amount = 100`       → nobody looks; it just succeeds
--   3. the ledger now says £900 was settled against a £100 bill
--
-- The edit SUCCEEDED silently and the supplier's position was wrong from that
-- moment on: `computeBillSettlement` reports the bill `over_paid` with £0
-- outstanding, and `computeSupplierPosition.outstanding` — which is deliberately
-- Σ of each bill's OWN remaining balance so that over-settling one bill cannot
-- appear to pay down another — quietly stops accounting for £800 of cash that
-- really did leave the bank. `lib/suppliers/payments.ts` models `over_paid`
-- specifically so a broken row still renders coherently, and its comment says
-- the state "should not persist (the DB refuses it)". Until this migration the
-- DB did not refuse it, so that was the one claim in the module that was untrue.
--
-- Reproduced end to end against real Postgres before it was fixed, through
-- service_role AND through an org admin under RLS: five bills in one suite run
-- ended up settled beyond their own value, the worst at nine times it. See
-- __tests__/integration/rls/supplier-payments.test.ts section 6.
--
-- ── WHY THIS IS NOT THE CIS FREEZE, AND MUST NOT BE ─────────────────────────
-- 20261053000000 already refuses UPDATE of `finances.amount` / `vat_rate` — but
-- ONLY for a bill carrying a live CIS allocation (`cis_deduction is not null`),
-- and it refuses the edit OUTRIGHT, in either direction, with void-and-repost as
-- the only way out. That severity is bought by what CIS is protecting: a
-- deduction that has already been calculated, reported to HMRC and issued to the
-- subcontractor on a payment & deduction statement. The number must not move at
-- all, so the bill is frozen and the exit is a ceremony.
--
-- Leaving ordinary supplier bills out of that freeze was correct scope
-- discipline, not an oversight, and this migration does not revisit it. A plain
-- builders'-merchant bill has no tax basis derived from it and nothing has been
-- filed anywhere. Freezing it would be a heavy answer to a light problem: it
-- would make "the invoice said 1,200, not 1,000" — an ordinary, frequent
-- correction — require voiding and re-posting a payment that was never wrong.
--
-- So this is a FLOOR, not a freeze, and it is strictly weaker than the CIS rule:
--
--   * an INCREASE is always allowed (it cannot over-settle anything);
--   * a REDUCTION is allowed right down to the settled total, to the penny;
--   * only a reduction BELOW the settled total is refused, and the message names
--     the two ways out — bill it for at least what you have paid, or void the
--     payments that no longer fit.
--
-- The two concerns therefore stay separate in the code, in the order they are
-- checked, and — most importantly — in what they SAY. A user told to void and
-- re-post when they only needed to re-cut the bill has been told the wrong
-- thing, and vice versa. Asserted in both directions by the integration suites.
--
-- ── ONE TRIGGER, NOT TWO ────────────────────────────────────────────────────
-- Both concerns are BEFORE UPDATE on `finances`, keyed on exactly the same two
-- columns, resolved by exactly the same lookup against exactly the same two
-- tables. Splitting them across two triggers would mean two scans of the
-- allocation ledger on every bill edit, an order dependency expressed only by
-- trigger name, and two places to keep the cheap-exit fast-path correct. So
-- 20261053000000's guard is EXTENDED, not duplicated: this migration is a
-- `create or replace` of the SAME function, `tg_finances_bill_value_guard`,
-- behind the SAME trigger, `finances_bill_value_guard`. Nothing is renamed and
-- nothing is dropped — 20261053000000 already named the guard for its subject
-- (the bill's value) rather than for its first rule, precisely so that this
-- migration would be a body change and nothing more.
--
-- The CIS branch below is reproduced from 20261053000000 character for
-- character, including its message, so the CIS behaviour and every test that
-- pins it are untouched.
--
-- ── WHY IT REFUSES "MAKING IT WORSE", NOT "BEING WRONG" ─────────────────────
-- The naive rule — refuse whenever the new gross is below the settled total —
-- would TRAP any row that is already broken. This defect has been live since M2
-- shipped, so a production database may well hold bills that are already settled
-- beyond their value; under the naive rule, correcting a £100 bill that carries
-- £900 of payments UP to £500 would be refused for still being short, and the
-- only row that needs fixing would be the one row that cannot be fixed.
--
-- So the guard refuses a reduction only when it BOTH lands below the settled
-- total AND lowers the gross. Every move toward the invariant is allowed, every
-- move away from it is refused, and the invariant can never be newly broken.
-- That branch is deliberately unreachable in a fresh database — with this guard
-- in place there is no longer a way to create an over-settled bill — which is
-- exactly the point of it. It was verified directly against Postgres with the
-- trigger disabled to manufacture the legacy state; the same framing
-- 20261053000000 uses for the "has changed since it was part-paid" branch it
-- keeps as defence in depth.
--
-- ── BLAST RADIUS, AND WHY IT IS SMALLER THAN IT LOOKS ───────────────────────
-- `finances` is the general cost ledger, so the guard stays narrow on both axes,
-- exactly as 20261053000000 does:
--
--   * COLUMNS. Only `amount` and `vat_rate` — the two writable inputs to the
--     gross payable. (`vat_total` is STORED GENERATED, `round(amount * vat_rate
--     / 100, 2)`, and has no independent write path.) `category`, `notes`,
--     `job_id`, `reference`, `bill_date`, `receipt_url` and everything else stay
--     freely editable on a part-paid bill. The cheap exit means an edit that
--     touches none of them costs nothing at all — no lookup, no scan.
--   * ROWS. Only bills carrying at least one NON-VOIDED allocation. That is
--     false for every ordinary expense and every unpaid bill, and a `finances`
--     row with no `supplier_id` can never have an allocation at all (M2's
--     composite bill FK is MATCH SIMPLE over a NOT NULL supplier_id, so a fuel
--     receipt naming nobody is structurally unallocatable). Recording and
--     editing ordinary costs is completely untouched.
--
-- Voided payments do not count, here as everywhere in this ledger: voiding is
-- precisely how a bill is released, and it drops the floor back to zero.
--
-- ── THE M2/M3 INVARIANT STILL HOLDS ─────────────────────────────────────────
-- 20261047000000's header states that the supplier ledger never inserts, updates
-- or deletes a `finances` row, which is what keeps `lib/profitability/compute.ts`
-- and `computeVatQuarter` byte-identical whatever happens in the cash layer.
-- That remains true. This is a BEFORE UPDATE trigger that either raises or
-- returns NEW completely unmodified — it never assigns to a field, never writes a
-- row, and never runs on INSERT. The ledger still cannot move commercial cost or
-- VAT reporting by a penny; it can now only refuse to let someone else move a
-- bill out from under money already paid against it.
--
-- ── CONCURRENCY — WHY NO LOCK IS TAKEN HERE, AND HOW THAT WAS PROVEN ────────
-- The dangerous interleaving is obvious: read the settled total, have someone
-- else commit an allocation, then commit a reduction that was legal against the
-- total you read and illegal against the one that now exists. A guard that only
-- ever ran sequentially would be advisory.
--
-- No explicit lock is taken here even so, because CAP 2 already serialises both
-- orderings on ONE object — the bill's own tuple in `finances`:
--
--   * BILL-EDIT FIRST, allocation second. The UPDATE holds an exclusive tuple
--     lock on the bill from the moment it writes. CAP 2's `select … from
--     finances … FOR UPDATE` blocks on it, and when the edit commits, CAP 2
--     re-reads the NEW gross and refuses the allocation that no longer fits.
--   * ALLOCATION FIRST, bill-edit second. CAP 2 holds the same tuple FOR UPDATE.
--     The bill UPDATE blocks. NOTE the mechanism precisely, because it is easy
--     to state wrongly: the BEFORE ROW trigger fires BEFORE the row lock is
--     taken, not after. The block happens in the update itself, and PostgreSQL
--     then runs EvalPlanQual against the newly committed row version and
--     RE-FIRES the BEFORE trigger. On that second firing the guard's `select
--     sum(…)` is a fresh query inside a VOLATILE plpgsql function, so under READ
--     COMMITTED it takes a NEW snapshot and sees the allocation that committed
--     while we were blocked. That fresh snapshot is the whole load-bearing
--     detail: without it the guard would wake up, re-read its own stale total of
--     zero, and wave the reduction through.
--
-- Deadlock is impossible because this guard locks nothing. 20261047000000's
-- payment-then-bill order is still the only lock order in the ledger and this
-- trigger never appears in it; it only ever reads `supplier_payments` and
-- `supplier_payment_allocations`, and a plain SELECT never waits on a row lock.
--
-- NONE OF THAT IS TAKEN ON TRUST. `scripts/verify-bill-value-guard-races.sh`
-- drives two real psql sessions with overlapping transactions and asserts, in
-- BOTH orderings, that the second session genuinely blocks — confirmed from
-- pg_stat_activity (wait_event_type='Lock'), not merely inferred from elapsed
-- time — and then refuses. Measured on a local stack: order-A blocked 1843 ms
-- then raised the settlement floor; order-B blocked 1851 ms then raised CAP 2;
-- the CIS ordering blocked 1832 ms then raised the freeze; 12 simultaneous
-- pairs fired in both directions produced no deadlock; and a final sweep
-- confirmed no bill in the fixture ended up settled beyond its gross. The
-- integration suite cannot do this — PostgREST is one transaction per request
-- and cannot hold one open — which is exactly why that harness exists.
--
-- Additive, idempotent and reversible. To roll back to the 20261053000000 state,
-- re-run 20261053000000 — it is a `create or replace` of this same function with
-- only the CIS branch, so replaying it removes the floor and leaves the freeze
-- intact. To remove both, follow that migration's own rollback block.


-- ═══════════════════════════════════════════════════════════════════════════
-- finances GUARD — the CIS basis freeze, and the settlement floor beneath it
-- ═══════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER is load-bearing, not decoration, for the same reason it is on
-- the guard this replaces. `supplier_payments` and `supplier_payment_allocations`
-- are admin-only under M2's RLS, so an invoker-rights trigger would see ZERO
-- allocation rows for a caller who cannot read the payment ledger — a member
-- editing an expense, which is the single most likely way to reach this code —
-- and both checks would silently pass for exactly those users. The guard has to
-- give the same answer on every write path, including service_role, which
-- bypasses RLS entirely.
create or replace function public.tg_finances_bill_value_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_settled   numeric(12, 2);
  v_new_gross numeric(12, 2);
  v_old_gross numeric(12, 2);
begin
  -- Cheap exit first, and it is the overwhelmingly common case: if neither input
  -- to the bill's value moved, this is an ordinary edit and no lookup is needed.
  -- Receipt stamping, recategorising and job re-tagging therefore cost nothing.
  if new.amount is not distinct from old.amount
     and new.vat_rate is not distinct from old.vat_rate
  then
    return new;
  end if;

  -- ── CONCERN 1 — the CIS basis freeze (20261053000000, verbatim) ──────────
  -- Checked FIRST because it is the stricter and more specific rule: a CIS bill
  -- is frozen in both directions, so an increase that the floor below would
  -- happily allow must still be refused here, and with the CIS message — that is
  -- the one that names the void-and-repost path the user actually has to take.
  --
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

  -- ── CONCERN 2 — the settlement floor ─────────────────────────────────────
  select coalesce(sum(a.amount), 0) into v_settled
    from public.supplier_payment_allocations a
    join public.supplier_payments p on p.id = a.payment_id
   where a.org_id = old.org_id
     and a.finance_id = old.id
     and p.voided_at is null;

  -- Nothing live is settled against it, so there is no floor to be under. This
  -- exit is REQUIRED, not merely an optimisation: allocation amounts are
  -- `check (amount > 0)` so v_settled is 0 exactly when the bill is unpaid, and
  -- without it a credit note or correction being taken NEGATIVE — a legitimate
  -- edit on an unallocated row, and one CAP 2 explicitly contemplates — would
  -- read as falling below a floor of zero and be refused.
  if v_settled = 0 then
    return new;
  end if;

  -- Gross is computed here exactly as CAP 2 computes it, so the two guards agree
  -- to the penny and a bill can never pass one and fail the other. NOTE the
  -- inner round(): `vat_total` is STORED GENERATED as `round(amount * vat_rate /
  -- 100, 2)` and CAP 2 reads that stored value, so the rounding has to happen in
  -- the same place. It CANNOT be read from NEW — a generated column is computed
  -- after BEFORE triggers run, so `new.vat_total` is NULL in here. (`old.vat_total`
  -- is the real stored value, but the whole question is what the row is becoming.)
  v_new_gross := round(new.amount + round(new.amount * new.vat_rate / 100, 2), 2);
  v_old_gross := round(old.amount + round(old.amount * old.vat_rate / 100, 2), 2);

  -- Refused only when the edit BOTH lands below the settled total AND lowers the
  -- gross — i.e. only when it makes things worse. See the header: the second
  -- clause is what stops a bill that is already over-settled, from before this
  -- guard existed, from being the one row nobody can repair.
  --
  -- ±0.005 is half a penny, below the resolution of numeric(12,2). Identical to
  -- CAP 2's tolerance and to lib/money's ALLOCATION_TOLERANCE, by design: a
  -- float-rounded amount arriving from the app must not read as a breach.
  if v_new_gross < v_settled - 0.005 and v_new_gross < v_old_gross - 0.005 then
    raise exception
      'bill % has % already settled against it by supplier payments, so its value cannot be reduced to % — bill it for at least what has been paid, or void the payments that no longer fit and record them again',
      old.id, v_settled, v_new_gross
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

comment on function public.tg_finances_bill_value_guard() is
  'Guards the two things that make a supplier bill''s value load-bearing, in one '
  'BEFORE UPDATE pass over finances.amount / finances.vat_rate. (1) CIS BASIS '
  'FREEZE (20261053000000): a bill carrying a live CIS allocation is frozen '
  'outright, in either direction, because a deduction has already been reported '
  'from it. (2) SETTLEMENT FLOOR (this migration): any other bill may still be '
  'corrected up or down, but not below the total already settled against it by '
  'non-voided supplier payments — that would leave 20261047000000''s CAP 2 '
  'violated, since CAP 2 only ever runs on allocation INSERT. Voided payments '
  'count for nothing under both rules. The two refusals are deliberately '
  'distinct: the CIS one requires void-and-repost, the floor does not. See '
  'docs/cis-domain.md sections 8, 9 and 10.';

-- The trigger is UNCHANGED from 20261053000000 — same name, same table, same
-- timing — because only the function body moved. It is recreated anyway so this
-- migration replays cleanly standing on its own, and so that a reader grepping
-- for the guard finds its wiring next to its logic. Fires before
-- `finances_set_updated_at` (same timing, and 'b' sorts before 's'), so a
-- refused edit never gets as far as stamping a new updated_at — cosmetic, since
-- the raise aborts the whole statement, but deliberate.
drop trigger if exists finances_bill_value_guard on public.finances;
create trigger finances_bill_value_guard
  before update on public.finances
  for each row execute function public.tg_finances_bill_value_guard();
