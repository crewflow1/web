-- Quality sprint:
--
-- 1. Extend the activity-log → notifications fan-out to include `job.%`,
--    so an auto-created job from a quote acceptance reaches the bell.
-- 2. Add audit columns to demo_requests so we can prove email delivery
--    for future submissions (no Resend message ID is stored today).

-- ---------------------------------------------------------------------------
-- 1. Fan-out trigger — add job.% to the org-wide branch
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

  if new.action like 'quote.%'
     or new.action like 'invoice.%'
     or new.action like 'time_entry.%'
     or new.action = 'leave.created'
     or new.action like 'payroll.%'
     or new.action like 'bank.%'
     or new.action like 'import.%'
     or new.action like 'lead.%'
     or new.action like 'job.%' then
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

  recipient_role := null;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. demo_requests audit columns — Resend message ID + email send timestamps
-- ---------------------------------------------------------------------------

alter table public.demo_requests
  add column if not exists notification_email_id text,
  add column if not exists notification_sent_at  timestamp with time zone,
  add column if not exists notification_error    text;
