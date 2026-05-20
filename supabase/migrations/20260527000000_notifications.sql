-- Wave 6 — Notifications centre
--
-- One row per per-user notification. Drives the bell icon + dropdown.
-- Members SELECT only their own rows; activity-log triggers fan out
-- via _record_activity (no change to existing call sites needed —
-- a separate after-insert trigger on activity_log creates a
-- notifications row for each org admin/owner + the relevant actor).

create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  type            text not null,
  title           text not null,
  body            text,
  action_url      text,
  related_table   text,
  related_id      uuid,
  read_at         timestamp with time zone,
  created_at      timestamp with time zone not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists "notifications: own select" on public.notifications;
create policy "notifications: own select" on public.notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "notifications: own update" on public.notifications;
create policy "notifications: own update" on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Fan-out from activity_log into notifications.
--
-- For each new activity_log row, decide who needs to know.
-- Rules (simple, deterministic):
--   - quote.*           → owners + admins
--   - invoice.*         → owners + admins
--   - import.*          → the actor only (avoid noise)
--   - time_entry.*      → owners + admins (so they can monitor)
--   - leave.created     → owners + admins
--   - leave.approved/rejected → the original requester
--   - job.assigned      → the assignee
--   - bank.*            → owners + admins
-- Anything that doesn't match → no notification (activity feed still
-- shows it).
-- ---------------------------------------------------------------------------

create or replace function public._tg_activity_log_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  recipient_role text;
  routed_user uuid;
  title_text text;
  body_text text;
  url_text text;
begin
  -- Build a friendly title/body from the activity row.
  title_text := initcap(replace(new.action, '.', ' '));
  body_text := coalesce(new.actor_name, 'system') || ' · ' || new.target_table;
  url_text := case new.target_table
    when 'quotes'        then '/quotes/' || new.target_id
    when 'invoices'      then '/invoices/' || new.target_id
    when 'jobs'          then '/jobs/' || new.target_id
    when 'leads'         then '/leads/' || new.target_id
    when 'imports'       then '/imports/' || new.target_id
    when 'leave_requests' then '/staff/leave'
    when 'payroll_runs'  then '/payroll/' || new.target_id
    when 'bank_statement_lines' then '/payments'
    when 'time_entries'  then '/me'
    else null
  end;

  -- Notify owners + admins for org-wide events.
  if new.action like 'quote.%'
     or new.action like 'invoice.%'
     or new.action like 'time_entry.%'
     or new.action = 'leave.created'
     or new.action like 'payroll.%'
     or new.action like 'bank.%'
     or new.action like 'import.%' then
    insert into public.notifications (org_id, user_id, type, title, body, action_url, related_table, related_id)
    select
      new.org_id,
      m.user_id,
      new.action,
      title_text,
      body_text,
      url_text,
      new.target_table,
      new.target_id
    from public.memberships m
    where m.org_id = new.org_id and m.role in ('owner', 'admin');
  end if;

  -- Targeted: leave decision → original requester.
  if new.action = 'leave.approved' or new.action = 'leave.rejected' then
    select user_id into routed_user from public.leave_requests where id = new.target_id;
    if routed_user is not null then
      insert into public.notifications (org_id, user_id, type, title, body, action_url, related_table, related_id)
      values (
        new.org_id, routed_user, new.action, title_text, body_text, url_text,
        new.target_table, new.target_id
      );
    end if;
  end if;

  -- Targeted: job assigned → the assignee.
  if new.action = 'job.assigned' then
    select assigned_to into routed_user from public.jobs where id = new.target_id;
    if routed_user is not null then
      insert into public.notifications (org_id, user_id, type, title, body, action_url, related_table, related_id)
      values (
        new.org_id, routed_user, new.action, title_text, body_text, url_text,
        new.target_table, new.target_id
      );
    end if;
  end if;

  -- Suppress recipient_role to silence the unused warning under stricter pg builds.
  recipient_role := null;
  return new;
end;
$$;

drop trigger if exists activity_log_notify on public.activity_log;
create trigger activity_log_notify
  after insert on public.activity_log
  for each row execute function public._tg_activity_log_notify();
