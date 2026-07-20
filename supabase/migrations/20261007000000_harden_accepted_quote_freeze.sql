-- Release-recovery hardening — accepted-quote freeze status side-channel.
--
-- The freeze introduced in 20261004000000 gated on the LIVE status
-- (old.status = 'accepted'). Because quote status-transition legality is
-- app-layer only (no DB rule makes 'accepted' terminal), a writer with UPDATE
-- rights could bypass the freeze in two steps:
--   1. accepted -> sent   (amounts unchanged, so the amount-freeze passes),
--   2. now old.status <> 'accepted'  -> edit subtotal/vat_total/total or lines.
--
-- Fix: key the freeze on whether the quote has EVER been accepted
-- (accepted_at IS NOT NULL) rather than its current status, and freeze
-- accepted_at itself so it can't be nulled to re-open the record. This makes
-- the accepted commercial document immutable regardless of any later status
-- change — a true DB-enforced invariant.
--
-- Accept flow remains compatible: acceptQuoteByToken sets status + accepted_at
-- in one UPDATE while old.accepted_at is still NULL (freeze skips), then writes
-- job_id in a second UPDATE (amounts/accepted_at unchanged -> allowed). The
-- invoice snapshot only READS line items. CREATE OR REPLACE keeps the existing
-- triggers bound; only the function bodies change.

create or replace function public.tg_quotes_freeze_accepted()
returns trigger language plpgsql as $$
begin
  if old.accepted_at is not null then
    if new.subtotal is distinct from old.subtotal
       or new.vat_total is distinct from old.vat_total
       or new.total is distinct from old.total then
      raise exception 'quote % has been accepted; its amounts are frozen', old.id
        using errcode = 'check_violation';
    end if;
    -- accepted_at is the freeze key — it must not be cleared or moved.
    if new.accepted_at is distinct from old.accepted_at then
      raise exception 'quote % has been accepted; accepted_at is frozen', old.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create or replace function public.tg_quote_line_items_freeze_accepted()
returns trigger language plpgsql as $$
declare
  q_accepted_at timestamptz;
begin
  select accepted_at into q_accepted_at from public.quotes where id = new.quote_id;
  if q_accepted_at is not null then
    raise exception 'quote % has been accepted; its line items are frozen', new.quote_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
