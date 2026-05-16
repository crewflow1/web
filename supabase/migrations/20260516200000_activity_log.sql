-- Slice 5: Activity feed — DB-trigger-captured audit log.
--
-- Captures mutating events across the product as rows in
-- public.activity_log. Triggers run AFTER the underlying mutation
-- and call the SECURITY DEFINER helper _record_activity().
--
-- Capture surface (CEO directive):
--   - jobs:     created / status_changed / assigned / rescheduled /
--               photos_changed / deleted
--   - quotes:   created / sent / viewed / accepted / declined
--   - invoices: created / sent / paid / overdue
--   - finances: created / updated / deleted
--
-- Why triggers (vs app-side):
--   - Captures Studio + RPC + service-role + future cron writes too.
--   - One source of truth; app code stays clean.
--   - auth.uid() survives across SECURITY DEFINER, so the JWT user is
--     preserved when reachable. Service-role writes (e.g., public quote
--     accept) record actor_id = null + a descriptive actor_name
--     (signature name for accept, "System" elsewhere).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE for
-- functions, DROP TRIGGER IF EXISTS before CREATE TRIGGER, DROP POLICY
-- IF EXISTS before CREATE POLICY.

-- ===========================================================================
-- activity_log table
-- ===========================================================================
create table if not exists public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  actor_id      uuid,
  actor_name    text,
  action        text not null,
  target_table  text not null,
  target_id     uuid not null,
  metadata      jsonb,
  created_at    timestamp with time zone not null default now()
);

create index if not exists activity_log_org_created_idx
  on public.activity_log (org_id, created_at desc);
create index if not exists activity_log_org_target_idx
  on public.activity_log (org_id, target_table, target_id);
create index if not exists activity_log_org_action_idx
  on public.activity_log (org_id, action, created_at desc);

alter table public.activity_log enable row level security;

-- Members of the org can read their org's feed. There's no INSERT/UPDATE/
-- DELETE policy: triggers are the only writers (they run as SECURITY
-- DEFINER which bypasses RLS for the insert).
drop policy if exists "activity_log: members can select" on public.activity_log;
create policy "activity_log: members can select"
on public.activity_log for select to authenticated
using (org_id in (select public.current_org_ids()));

-- ===========================================================================
-- _record_activity helper
-- ===========================================================================
create or replace function public._record_activity(
  p_org_id        uuid,
  p_action        text,
  p_target_table  text,
  p_target_id     uuid,
  p_metadata      jsonb default null,
  p_actor_override text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid;
  v_actor_name text;
begin
  v_actor_id := auth.uid();
  if p_actor_override is not null and p_actor_override <> '' then
    v_actor_name := p_actor_override;
  elsif v_actor_id is not null then
    select coalesce(full_name, email)
    into v_actor_name
    from public.users
    where id = v_actor_id;
  else
    v_actor_name := 'System';
  end if;

  insert into public.activity_log (
    org_id, actor_id, actor_name, action,
    target_table, target_id, metadata
  )
  values (
    p_org_id, v_actor_id, v_actor_name, p_action,
    p_target_table, p_target_id, p_metadata
  );
end;
$$;

-- ===========================================================================
-- jobs trigger
-- ===========================================================================
create or replace function public._tg_jobs_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id,
      'job.created',
      'jobs',
      NEW.id,
      jsonb_build_object('status', NEW.status, 'customer_id', NEW.customer_id)
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status then
      perform _record_activity(
        NEW.org_id, 'job.status_changed', 'jobs', NEW.id,
        jsonb_build_object('from', OLD.status, 'to', NEW.status)
      );
    end if;
    if NEW.assigned_to is distinct from OLD.assigned_to then
      perform _record_activity(
        NEW.org_id, 'job.assigned', 'jobs', NEW.id,
        jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to)
      );
    end if;
    if NEW.scheduled_date is distinct from OLD.scheduled_date then
      perform _record_activity(
        NEW.org_id, 'job.rescheduled', 'jobs', NEW.id,
        jsonb_build_object('from', OLD.scheduled_date, 'to', NEW.scheduled_date)
      );
    end if;
    if coalesce(array_length(NEW.photos, 1), 0)
       is distinct from coalesce(array_length(OLD.photos, 1), 0) then
      perform _record_activity(
        NEW.org_id, 'job.photos_changed', 'jobs', NEW.id,
        jsonb_build_object(
          'from_count', coalesce(array_length(OLD.photos, 1), 0),
          'to_count',   coalesce(array_length(NEW.photos, 1), 0)
        )
      );
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id, 'job.deleted', 'jobs', OLD.id,
      jsonb_build_object('status', OLD.status)
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists jobs_activity_trigger on public.jobs;
create trigger jobs_activity_trigger
  after insert or update or delete on public.jobs
  for each row execute function _tg_jobs_activity();

-- ===========================================================================
-- quotes trigger
-- ===========================================================================
create or replace function public._tg_quotes_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signer text;
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'quote.created', 'quotes', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'total', NEW.total,
        'customer_id', NEW.customer_id, 'lead_id', NEW.lead_id
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.sent_at is distinct from OLD.sent_at and NEW.sent_at is not null then
      perform _record_activity(
        NEW.org_id, 'quote.sent', 'quotes', NEW.id,
        jsonb_build_object('number', NEW.number, 'total', NEW.total)
      );
    end if;
    if NEW.viewed_at is distinct from OLD.viewed_at and NEW.viewed_at is not null then
      perform _record_activity(
        NEW.org_id, 'quote.viewed', 'quotes', NEW.id,
        jsonb_build_object('number', NEW.number),
        'Customer (public link)'
      );
    end if;
    if NEW.accepted_at is distinct from OLD.accepted_at and NEW.accepted_at is not null then
      v_signer := nullif(NEW.accept_signature ->> 'name', '');
      perform _record_activity(
        NEW.org_id, 'quote.accepted', 'quotes', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'signer', v_signer,
          'source', NEW.accept_signature ->> 'source'
        ),
        coalesce(v_signer, null)
      );
    end if;
    if NEW.declined_at is distinct from OLD.declined_at and NEW.declined_at is not null then
      perform _record_activity(
        NEW.org_id, 'quote.declined', 'quotes', NEW.id,
        jsonb_build_object('number', NEW.number)
      );
    end if;
    return NEW;
  end if;
  return null;
end;
$$;

drop trigger if exists quotes_activity_trigger on public.quotes;
create trigger quotes_activity_trigger
  after insert or update on public.quotes
  for each row execute function _tg_quotes_activity();

-- ===========================================================================
-- invoices trigger
-- ===========================================================================
create or replace function public._tg_invoices_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'invoice.created', 'invoices', NEW.id,
      jsonb_build_object(
        'number', NEW.number, 'total', NEW.total,
        'quote_id', NEW.quote_id
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status then
      -- emit a single status_changed (covers sent/paid/overdue transitions)
      perform _record_activity(
        NEW.org_id, 'invoice.' || NEW.status, 'invoices', NEW.id,
        jsonb_build_object(
          'number', NEW.number, 'total', NEW.total,
          'from', OLD.status, 'to', NEW.status
        )
      );
    end if;
    return NEW;
  end if;
  return null;
end;
$$;

drop trigger if exists invoices_activity_trigger on public.invoices;
create trigger invoices_activity_trigger
  after insert or update on public.invoices
  for each row execute function _tg_invoices_activity();

-- ===========================================================================
-- finances trigger
-- ===========================================================================
create or replace function public._tg_finances_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id, 'finance.created', 'finances', NEW.id,
      jsonb_build_object(
        'amount', NEW.amount, 'vat_rate', NEW.vat_rate,
        'category', NEW.category, 'job_id', NEW.job_id
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    perform _record_activity(
      NEW.org_id, 'finance.updated', 'finances', NEW.id,
      jsonb_build_object(
        'amount', NEW.amount, 'category', NEW.category
      )
    );
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id, 'finance.deleted', 'finances', OLD.id,
      jsonb_build_object('amount', OLD.amount, 'category', OLD.category)
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists finances_activity_trigger on public.finances;
create trigger finances_activity_trigger
  after insert or update or delete on public.finances
  for each row execute function _tg_finances_activity();
