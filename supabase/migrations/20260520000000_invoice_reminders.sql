-- Phase: Invoice reminders v2 — four-stage automatic + manual.
--
-- Replaces the earlier one-shot payment_reminder_sent_at /
-- overdue_reminder_sent_at columns (which were never live in prod) with
-- a per-stage audit table. One row per (invoice, stage) for automatic
-- stages; manual sends can fire repeatedly.
--
-- Stages:
--   day_3   — Friendly reminder
--   day_7   — Payment reminder
--   day_14  — Invoice overdue
--   day_21  — Final reminder
--   manual  — operator clicked "Send reminder now"
--
-- The cron only fires for invoices with status != 'paid' AND sent_at <=
-- now() - (stage interval). Stop-on-paid is enforced by the cron query,
-- not by a status trigger.

create table if not exists public.invoice_reminders (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  stage         text not null check (stage in ('day_3', 'day_7', 'day_14', 'day_21', 'manual')),
  sent_at       timestamp with time zone not null default now(),
  recipient     text,
  email_id      text,
  created_at    timestamp with time zone not null default now()
);

-- Partial unique index — one row per stage per invoice, EXCEPT manual.
-- Manual sends can repeat (operator may resend multiple times).
create unique index if not exists invoice_reminders_unique_auto_stage
  on public.invoice_reminders (invoice_id, stage)
  where stage <> 'manual';

create index if not exists invoice_reminders_invoice_idx
  on public.invoice_reminders (invoice_id);

create index if not exists invoice_reminders_org_sent_idx
  on public.invoice_reminders (org_id, sent_at desc);

alter table public.invoice_reminders enable row level security;

-- RLS: members can read own org. INSERT/UPDATE/DELETE happen via cron
-- (service-role) or via authed endpoints; the policies allow member
-- writes for the manual-send path.
drop policy if exists "invoice_reminders: members select" on public.invoice_reminders;
create policy "invoice_reminders: members select" on public.invoice_reminders for select to authenticated
using (org_id in (select public.current_org_ids()));

drop policy if exists "invoice_reminders: members insert" on public.invoice_reminders;
create policy "invoice_reminders: members insert" on public.invoice_reminders for insert to authenticated
with check (org_id in (select public.current_org_ids()));

drop policy if exists "invoice_reminders: admins delete" on public.invoice_reminders;
create policy "invoice_reminders: admins delete" on public.invoice_reminders for delete to authenticated
using (public.is_org_admin(org_id));

-- Activity log: every reminder row → invoice.reminder_sent event so the
-- audit feed surfaces it without the cron needing to manually call the
-- _record_activity helper.
create or replace function public._tg_invoice_reminders_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id,
      'invoice.reminder_sent',
      'invoices',
      NEW.invoice_id,
      jsonb_build_object('stage', NEW.stage, 'recipient', NEW.recipient)
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists invoice_reminders_activity_trigger on public.invoice_reminders;
create trigger invoice_reminders_activity_trigger
  after insert on public.invoice_reminders
  for each row execute function _tg_invoice_reminders_activity();

-- Drop the old single-shot columns now that no live cron uses them.
-- Safe: the previous payment/overdue cron routes never ran in prod
-- (RESEND_API_KEY was never set during their window).
alter table public.invoices
  drop column if exists payment_reminder_sent_at,
  drop column if exists overdue_reminder_sent_at;

drop index if exists public.invoices_payment_reminder_pending_idx;
drop index if exists public.invoices_overdue_reminder_pending_idx;
