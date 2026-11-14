-- Concurrent payment inserts on ONE invoice deadlocked (40P01).
--
-- tg_invoice_payments_refuse_void (BEFORE INSERT) took `FOR SHARE` on the invoice row,
-- and _tg_invoice_payments_sync_status (AFTER INSERT) then UPDATEs that same invoice.
-- Two concurrent inserts each hold the shared lock and each wait for the other to
-- release it before upgrading — a lock-upgrade deadlock that Postgres only breaks after
-- deadlock_timeout, one victim at a time. Callers saw a spurious "try again", and under
-- load the cycle could take many seconds to drain.
--
-- Fix: take `FOR NO KEY UPDATE` up front. It is the same lock the status-sync UPDATE
-- needs, so concurrent payment inserts on one invoice now QUEUE on the invoice row and
-- run one after another; there is nothing left to upgrade and nothing to deadlock.
-- The void protection is unchanged in substance: a concurrent "void" UPDATE and a
-- payment insert still exclude each other on this row, and the status is read under
-- the lock. `FOR NO KEY UPDATE` does not block foreign-key checks (FOR KEY SHARE).
--
-- data-api:exempt: function body change only; no table, grant or policy is touched.
-- Rollback: restore `for share` (re-introduces the deadlock).

create or replace function public.tg_invoice_payments_refuse_void()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_status public.invoice_status;
begin
  select i.status into v_status
    from public.invoices i
   where i.id = new.invoice_id
     for no key update;
  if v_status = 'void' then
    raise exception 'payments cannot be recorded against a void invoice';
  end if;
  return new;
end $function$;
