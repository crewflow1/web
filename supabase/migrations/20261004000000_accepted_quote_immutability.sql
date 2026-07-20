-- Commercial integrity — accepted-quote immutability.
--
-- Closes the flagged "mutable accepted commercial document" gap: `updateQuote`
-- reverts approved/sent/viewed → pending_approval but had NO guard for
-- `accepted`, so an accepted quote's amounts and line items could be edited
-- after the customer agreed them. A quote/variation, once accepted, is a firm
-- commercial agreement — its money figures and scope are now frozen AT THE
-- DATABASE (the action layer also refuses to edit accepted quotes; this is the
-- invariant behind that).
--
-- The accept flow is deliberately UNAFFECTED: acceptQuoteByToken sets
-- status/accepted_at/signature (old.status is still sent/viewed then, so the
-- money-freeze skips), then writes job_id (which is not a frozen column); the
-- invoice snapshot READS quote_line_items, never writes them. Only ADD/EDIT of
-- line items is frozen (not DELETE) so a quote's ON DELETE CASCADE still works.
-- Additive + reversible.

-- ── Freeze the accepted quote's money figures ────────────────────────────────
create or replace function public.tg_quotes_freeze_accepted()
returns trigger language plpgsql as $$
begin
  if old.status = 'accepted'
     and (new.subtotal is distinct from old.subtotal
          or new.vat_total is distinct from old.vat_total
          or new.total is distinct from old.total) then
    raise exception 'quote % is accepted; its amounts are frozen', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quotes_freeze_accepted on public.quotes;
create trigger quotes_freeze_accepted before update on public.quotes
  for each row execute function public.tg_quotes_freeze_accepted();

-- ── Freeze the accepted quote's scope (line items) ───────────────────────────
-- INSERT/UPDATE only: adding or editing a line on an accepted quote is refused.
-- DELETE is left to the parent's ON DELETE CASCADE (a bare manual line delete on
-- an accepted quote is already impossible via the app — updateQuote refuses it).
create or replace function public.tg_quote_line_items_freeze_accepted()
returns trigger language plpgsql as $$
declare
  q_status text;
begin
  select status into q_status from public.quotes where id = new.quote_id;
  if q_status = 'accepted' then
    raise exception 'quote % is accepted; its line items are frozen', new.quote_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists quote_line_items_freeze_accepted on public.quote_line_items;
create trigger quote_line_items_freeze_accepted
  before insert or update on public.quote_line_items
  for each row execute function public.tg_quote_line_items_freeze_accepted();
