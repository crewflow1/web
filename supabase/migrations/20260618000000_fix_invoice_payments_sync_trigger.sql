-- Fix the invoice_payments → invoices.status sync trigger.
--
-- The trigger defined in 20260524000000_payment_tracking.sql declares
-- `v_next text` and then does `update invoices set status = v_next`,
-- but `invoices.status` is the `invoice_status` enum. Postgres refuses
-- the implicit text→enum cast at runtime:
--
--   42804: column "status" is of type invoice_status but expression is of type text
--
-- Net effect in production: every `insert into invoice_payments`
-- raises an exception inside the AFTER trigger, aborting the payment
-- insert. The bug was discovered by the CrewFlow end-to-end lifecycle
-- test (scripts/e2e-lifecycle.sql) — no real payment had ever been
-- recorded in production through this path.
--
-- This migration redefines the trigger function with an explicit
-- `::public.invoice_status` cast on both the read and write paths.
-- No data-shape change.

create or replace function public._tg_invoice_payments_sync_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invoice_id   uuid;
  v_org_id       uuid;
  v_total        numeric(12, 2);
  v_paid         numeric(12, 2);
  v_current      public.invoice_status;
  v_next         public.invoice_status;
  v_paid_at      date;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);
  v_org_id := coalesce(new.org_id, old.org_id);

  select total, status into v_total, v_current
    from public.invoices where id = v_invoice_id;

  select coalesce(sum(amount), 0), max(paid_at) into v_paid, v_paid_at
    from public.invoice_payments where invoice_id = v_invoice_id;

  if v_paid >= v_total then
    v_next := 'paid'::public.invoice_status;
  elsif v_paid > 0 then
    v_next := 'partially_paid'::public.invoice_status;
  else
    if v_current in ('paid'::public.invoice_status, 'partially_paid'::public.invoice_status) then
      v_next := 'sent'::public.invoice_status; -- payments removed, revert
    else
      v_next := v_current; -- leave alone (draft / sent / awaiting_payment / overdue)
    end if;
  end if;

  if v_next is distinct from v_current or v_paid_at is distinct from null then
    update public.invoices
       set status = v_next,
           paid_at = case
             when v_next = 'paid'::public.invoice_status
               then v_paid_at::timestamp with time zone
             else null
           end
     where id = v_invoice_id;
  end if;

  return coalesce(new, old);
end;
$fn$;
