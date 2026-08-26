-- Invoice VOID — the smallest correct operational-correction state.
--
-- WHY: the E2E acceptance audit found that correcting an ISSUED invoice
-- required a direct DB edit (the enum had no void/cancel member), which is
-- unacceptable with a real customer live. This adds a `void` terminal state
-- with an auditable trail, guarded so it can never destroy accounting
-- evidence:
--
--   • Only an invoice with NO recorded payments can be voided. `paid` and
--     `partially_paid` invoices are REFUSED — reversing received money is a
--     credit-note workflow (deliberately NOT built here; see the ledger).
--     This is enforced against invoice_payments rows, not just the status
--     value, so a stale status can't sneak a paid invoice through.
--   • `void` is TERMINAL — once void, the status can never change again.
--   • Payments can never be recorded against a void invoice.
--   • Reason + actor + timestamp are stamped on the row (server sets actor;
--     the trigger owns the timestamp so it can't be forged or omitted).
--
-- FINANCIAL EFFECT (by construction, no calculator changes): every financial
-- authority in lib/ is a POSITIVE allowlist over statuses — ISSUED_INVOICE_
-- STATUSES (accrual revenue / CT), OVERDUE_COLLECTABLE_STATUSES (overdue),
-- OUTSTANDING_STATUSES (receivables/aged debtors), and the cash-basis VAT sums
-- are payment-driven. `void` appears in none of them, so a voided invoice
-- drops out of revenue, receivables, ageing and forecasts automatically, and
-- can have contributed nothing to cash-basis VAT (voiding is only possible
-- with zero payments). Draft deletion is untouched (drafts can already be
-- deleted); void exists for the ISSUED-but-wrong case.

-- New enum value. Safe under Postgres 12+; existing values untouched.
alter type public.invoice_status add value if not exists 'void';

-- Audit columns. Nullable — only ever set on void.
alter table public.invoices
  add column if not exists voided_at  timestamptz,
  add column if not exists voided_by  uuid references auth.users (id) on delete set null,
  add column if not exists void_reason text;

-- The guard. BEFORE UPDATE so an illegal transition never lands.
create or replace function public.tg_invoices_void_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Terminal: a void invoice can never change status (or un-void).
  if old.status = 'void' and new.status is distinct from old.status then
    raise exception 'a void invoice is final and cannot change status';
  end if;

  if new.status = 'void' and old.status is distinct from 'void' then
    -- Money received ⇒ this is a credit-note problem, not a void.
    if old.status in ('paid', 'partially_paid') then
      raise exception 'an invoice with recorded payments cannot be voided — reverse the payment first or issue a correction';
    end if;
    -- Belt & braces: check the payments ledger itself, not just the status.
    if exists (select 1 from public.invoice_payments p where p.invoice_id = new.id) then
      raise exception 'an invoice with recorded payments cannot be voided — reverse the payment first or issue a correction';
    end if;
    if new.void_reason is null or length(btrim(new.void_reason)) = 0 then
      raise exception 'voiding an invoice requires a reason';
    end if;
    -- The trigger owns the timestamp; the caller cannot forge or omit it.
    new.voided_at := now();
  end if;

  -- The void audit fields only ever move as part of the void transition.
  if new.status is not distinct from old.status and old.status is distinct from 'void' then
    new.voided_at  := old.voided_at;
    new.voided_by  := old.voided_by;
    new.void_reason := old.void_reason;
  end if;

  return new;
end $$;

drop trigger if exists invoices_void_guard on public.invoices;
create trigger invoices_void_guard
  before update on public.invoices
  for each row execute function public.tg_invoices_void_guard();

-- No money can land on a void invoice. The status read takes FOR SHARE on the
-- invoice row so a concurrent `UPDATE … status='void'` serialises against this
-- insert: the payment either lands before the void (and the void guard then
-- sees it and refuses), or waits for the void to commit (and is refused here).
-- Closes the READ COMMITTED race where both could otherwise commit.
create or replace function public.tg_invoice_payments_refuse_void()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status public.invoice_status;
begin
  select i.status into v_status
    from public.invoices i
   where i.id = new.invoice_id
     for share;
  if v_status = 'void' then
    raise exception 'payments cannot be recorded against a void invoice';
  end if;
  return new;
end $$;

drop trigger if exists invoice_payments_refuse_void on public.invoice_payments;
create trigger invoice_payments_refuse_void
  before insert or update on public.invoice_payments
  for each row execute function public.tg_invoice_payments_refuse_void();
