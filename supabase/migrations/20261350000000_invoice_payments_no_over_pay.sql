-- 20261350000000 — an invoice cannot be paid for more than it is worth (atomic guard)
--
-- PROBLEM. Nothing in the database stopped the payments recorded against one invoice from
-- adding up to more than its total. `invoice_payments_no_over_allocate` (20261010000000) keeps a
-- BANK PAYMENT from being split into more than its own amount; it says nothing about the
-- invoice's balance. The application now checks the balance before a manual payment
-- (`addInvoicePayment`), but a check-then-insert in the application cannot be atomic: two
-- payments submitted at the same instant both read the same balance and both insert. Measured
-- against real Postgres before this migration: five simultaneous £60 payments on a £100 invoice
-- were ALL accepted (£300 recorded), and a re-posted full payment doubled the money.
--
-- FIX. A BEFORE INSERT OR UPDATE row trigger that
--   1. takes the invoice's row lock (FOR NO KEY UPDATE — the same lock the void guard already
--      takes), so every writer to ONE invoice queues behind the previous one and, under READ
--      COMMITTED, the SUM that follows sees every payment committed before it;
--   2. refuses the row when (payments already recorded + this one) exceeds the invoice total
--      (half-a-penny tolerance, as the allocation guard uses).
-- It binds every writer alike: the manual action, the `allocate_payment` RPC (the refusal rolls
-- the whole allocation back, parent payment included), and any direct Data-API insert.
--
-- THE ONE EXEMPTION — money a payment provider has already taken. The portal card-payment
-- webhook records a Stripe settlement with the service role and `source = 'stripe'`. If the
-- customer pays by card while the office records the same invoice as paid by transfer, the card
-- money HAS been collected: refusing its ledger row would lose the record of real money and make
-- Stripe retry the webhook for days. So a row written by the SERVER (not `authenticated` /
-- `anon`) with `source = 'stripe'` is always recorded; the over-collection is then visible on
-- the invoice and can be refunded. A signed-in user cannot claim the exemption by labelling
-- their own row `stripe`, and a server write with any other source is bound like everyone else.
--
-- BANK RECONCILIATION RETRIES keep their answer. One bank line may settle one payment
-- (`invoice_payments_bank_line_uniq`, 20261326000000); a retried or concurrent confirm of the
-- same line is refused with 23505 and the match flow treats that as already done. This trigger
-- runs before the unique index is checked, so it steps aside for a row whose bank line is
-- already matched and lets the index give its usual answer.
--
-- EXISTING ROWS. The trigger looks only at the row being written. An UPDATE is checked only
-- when it raises the amount or moves the payment to another invoice, so a note / reference edit
-- on an invoice that is already over-collected (legacy data, or the exemption above) is never
-- blocked; lowering an amount and deleting are never blocked. No existing row is rewritten.
--
-- TENANT SAFETY. SECURITY DEFINER (it must read the invoice regardless of the caller's RLS), so
-- it must not become an oracle for another company's balance: it evaluates only when the
-- invoice belongs to the row's own org AND (for a client caller) that org is one of the caller's
-- own. Anything else falls through untouched to the composite FK / RLS, which reject it with
-- their usual errors. RLS, grants and every other trigger are unchanged.
--
-- Additive and forward-only. Rollback (no data change):
--   drop trigger if exists invoice_payments_no_over_pay on public.invoice_payments;
--   drop function if exists public.tg_invoice_payments_no_over_pay();

create or replace function public.tg_invoice_payments_no_over_pay()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
  v_total  numeric(12, 2);
  v_paid   numeric(12, 2);
begin
  -- Provider-settled money recorded by the server is a fact; never refuse it.
  if new.source = 'stripe' and not v_client then
    return new;
  end if;

  -- An edit that neither raises the amount nor re-targets the payment cannot create an over-payment.
  if tg_op = 'UPDATE'
     and new.invoice_id = old.invoice_id
     and new.amount <= old.amount then
    return new;
  end if;

  -- Not the caller's company: say nothing here; the FK / RLS reject the row.
  if v_client and new.org_id not in (select public.current_org_ids()) then
    return new;
  end if;

  -- Serialise writers on this invoice, then read what is already recorded against it.
  select i.total into v_total
    from public.invoices i
   where i.id = new.invoice_id
     and i.org_id = new.org_id
     for no key update;
  if not found then
    return new; -- wrong org / missing invoice: the composite FK rejects it
  end if;

  -- A second row for a bank statement line that is ALREADY matched is a retry of that match, not
  -- a new payment. `invoice_payments_bank_line_uniq` refuses it with 23505, which the bank-match
  -- flow recognises as "already recorded" — let that answer stand rather than replacing it with
  -- a balance error. (Checked after the lock, so a concurrent first match is visible here.)
  if new.bank_line_id is not null and exists (
       select 1 from public.invoice_payments d
        where d.bank_line_id = new.bank_line_id and d.id <> new.id) then
    return new;
  end if;

  select coalesce(sum(p.amount), 0) into v_paid
    from public.invoice_payments p
   where p.invoice_id = new.invoice_id
     and p.id <> new.id;

  if v_paid + new.amount > v_total + 0.005 then
    raise exception
      'payment of % exceeds the % still owed on this invoice',
      to_char(new.amount, 'FM999999990.00'),
      to_char(greatest(v_total - v_paid, 0), 'FM999999990.00')
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- A trigger function is never called directly; keep it off the Data API.
revoke all on function public.tg_invoice_payments_no_over_pay() from public, anon, authenticated;

drop trigger if exists invoice_payments_no_over_pay on public.invoice_payments;
create trigger invoice_payments_no_over_pay
  before insert or update on public.invoice_payments
  for each row execute function public.tg_invoice_payments_no_over_pay();
