-- ---------------------------------------------------------------------------
-- Customer↔organisation messaging — add the organisation actor.
-- ---------------------------------------------------------------------------
--
-- support_messages.author_kind had exactly two values:
--
--   'customer' — in Support OS terms, CrewFlow's customer = THE TENANT ORG
--   'hq'       — CrewFlow staff
--
-- That models one conversation: tenant ↔ CrewFlow HQ. The customer portal then
-- reused the same tables for a DIFFERENT conversation — end-customer ↔ tenant —
-- and there was no value meaning "the tenant, speaking to their own customer".
-- Consequences, all live before this migration:
--
--   * the tenant's reply (app/(app)/support/actions.ts) stamped 'customer', so
--     the portal rendered the builder's reply as the HOMEOWNER's own message;
--   * the only writer of 'hq' is /admin/support, so the one actor the portal
--     could attribute to `org.name` was CrewFlow — not the tenant.
--
-- Fix: add a third actor, 'org'. Deliberately a NEW value rather than
-- overloading an existing one — 'customer' keeps meaning exactly what Support
-- OS always meant by it, so the HQ helpdesk is untouched, and every
-- customer↔org message becomes trivially identifiable by `author_kind='org'`
-- + `support_tickets.customer_id is not null`. That is what keeps a future
-- domain split (moving these conversations to their own tables) a mechanical
-- query rather than an archaeology exercise.
--
-- Three objects must move together or an 'org' insert fails at runtime:
--   1. support_messages.author_kind        — the CHECK on the value itself
--   2. support_tickets.last_reply_kind     — the after-insert trigger copies
--                                            author_kind into it, so its
--                                            narrower CHECK would reject 'org'
--                                            and abort the INSERT
--   3. support_messages_insert RLS policy  — hard-codes `author_kind =
--                                            'customer'`, so RLS would refuse
--                                            the tenant's 'org' reply
--
-- NOT changed: `check (author_kind = 'hq' or internal = false)`. It already
-- does the right thing for 'org' — it forces internal = false, so an
-- organisation message can never be an internal note. Only HQ may go internal.

-- 1. The message actor ------------------------------------------------------
alter table public.support_messages
  drop constraint if exists support_messages_author_kind_check;
alter table public.support_messages
  add constraint support_messages_author_kind_check
  check (author_kind in ('customer', 'hq', 'org'));

-- 2. The ticket's denormalised copy -----------------------------------------
-- The trigger below writes `last_reply_kind = new.author_kind`, so this CHECK
-- is on the INSERT path for every message. Left narrower, it would reject 'org'
-- and roll the whole insert back.
alter table public.support_tickets
  drop constraint if exists support_tickets_last_reply_kind_check;
alter table public.support_tickets
  add constraint support_tickets_last_reply_kind_check
  check (last_reply_kind in ('customer', 'hq', 'org'));

-- 3. Let tenant members author an 'org' reply -------------------------------
-- Unchanged in every other respect: still org-scoped, still non-internal only,
-- still bound to the author's own auth.uid(). 'hq' remains impossible here —
-- only /admin/support (service-role) may speak as CrewFlow.
drop policy if exists support_messages_insert on public.support_messages;
create policy support_messages_insert on public.support_messages
  for insert with check (
    org_id in (select public.current_org_ids())
    and author_kind in ('customer', 'org')
    and internal = false
    and (author_id is null or author_id = auth.uid())
  );

-- 4. Status transitions stay trigger-owned ----------------------------------
-- 'org' is a responder in the customer↔org conversation, exactly as 'hq' is in
-- the tenant↔CrewFlow one, so it inherits the same nudges. Without this an org
-- reply would leave the ticket's status frozen — the DB must keep owning this
-- state, not the app.
create or replace function public._support_messages_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Internal HQ notes don't change reply telemetry — they're just
  -- side conversation.
  if new.internal then
    return new;
  end if;

  update public.support_tickets t
     set last_reply_at  = new.created_at,
         last_reply_kind = new.author_kind,
         -- Status nudges:
         --  * customer reply on a 'waiting_on_customer' ticket
         --    re-opens it to 'in_progress'.
         --  * a responder (HQ, or the org replying to its own customer)
         --    on an 'open' ticket flips it to 'in_progress'.
         --  * a responder on an 'in_progress' ticket flips it to
         --    'waiting_on_customer' (we just bounced the ball).
         status = case
           when new.author_kind = 'customer' and t.status = 'waiting_on_customer'
             then 'in_progress'
           when new.author_kind in ('hq', 'org') and t.status = 'open'
             then 'in_progress'
           when new.author_kind in ('hq', 'org') and t.status = 'in_progress'
             then 'waiting_on_customer'
           else t.status
         end,
         updated_at = now()
   where t.id = new.ticket_id;
  return new;
end $$;

drop trigger if exists support_messages_after_insert on public.support_messages;
create trigger support_messages_after_insert
  after insert on public.support_messages
  for each row execute function public._support_messages_after_insert();
