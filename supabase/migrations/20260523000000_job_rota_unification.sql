-- Wave 1 — Job ↔ Rota unification.
--
-- Decision: rota_entries is canonical for "who is working when". jobs.assigned_to
-- stays as a CONVENIENCE pointer ("primary assignee for this job"), but it
-- auto-syncs to rota_entries so the operator never has to enter both manually.
--
-- Behaviour:
--   - Setting jobs.assigned_to + scheduled_date creates a rota_entry
--     (default shift 08:00-17:00 UTC on the scheduled date) for that user,
--     unless one already exists for that user+job on that date.
--   - Changing jobs.scheduled_date updates the matching auto-created rota_entry.
--   - Clearing jobs.assigned_to does NOT auto-remove the rota_entry; the
--     operator removes shifts deliberately (rota = source of truth for
--     actuals; jobs.assigned_to is a hint).
--
-- Idempotent. No data loss on apply: existing rota_entries are unaffected.

create or replace function public._tg_jobs_rota_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default_start timestamp with time zone;
  v_default_end   timestamp with time zone;
  v_existing_id   uuid;
begin
  -- Only act when there's something to schedule.
  if NEW.assigned_to is null or NEW.scheduled_date is null then
    return NEW;
  end if;

  -- Did the relevant fields actually change?
  if TG_OP = 'UPDATE' then
    if NEW.assigned_to is not distinct from OLD.assigned_to
       and NEW.scheduled_date is not distinct from OLD.scheduled_date then
      return NEW;
    end if;
  end if;

  v_default_start := (NEW.scheduled_date::text || ' 08:00:00+00')::timestamp with time zone;
  v_default_end   := (NEW.scheduled_date::text || ' 17:00:00+00')::timestamp with time zone;

  -- Find an existing auto-managed entry for this job+user. (We match by
  -- (job_id, user_id) so editing scheduled_date moves the same row
  -- rather than creating a new one.)
  select id into v_existing_id
    from public.rota_entries
   where job_id = NEW.id
     and user_id = NEW.assigned_to
   limit 1;

  if v_existing_id is not null then
    update public.rota_entries
       set starts_at = v_default_start,
           ends_at = v_default_end
     where id = v_existing_id;
  else
    insert into public.rota_entries (
      org_id, user_id, job_id, starts_at, ends_at, notes, created_by
    ) values (
      NEW.org_id,
      NEW.assigned_to,
      NEW.id,
      v_default_start,
      v_default_end,
      'Auto-created from job assignment (default 08:00-17:00 — adjust as needed)',
      NEW.assigned_to
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists jobs_rota_sync_trigger on public.jobs;
create trigger jobs_rota_sync_trigger
  after insert or update on public.jobs
  for each row execute function public._tg_jobs_rota_sync();

-- Backfill: for every existing job with assigned_to + scheduled_date but no
-- matching rota_entry, create one. Safe to re-run.
insert into public.rota_entries (org_id, user_id, job_id, starts_at, ends_at, notes, created_by)
select
  j.org_id,
  j.assigned_to,
  j.id,
  (j.scheduled_date::text || ' 08:00:00+00')::timestamp with time zone,
  (j.scheduled_date::text || ' 17:00:00+00')::timestamp with time zone,
  'Backfilled from job assignment on migration apply (Wave 1)',
  j.assigned_to
from public.jobs j
where j.assigned_to is not null
  and j.scheduled_date is not null
  and not exists (
    select 1 from public.rota_entries r
    where r.job_id = j.id and r.user_id = j.assigned_to
  );

-- Add a comment to the column to remind future developers.
comment on column public.jobs.assigned_to is
  'Primary assignee. Convenience pointer — rota_entries is the canonical source of who is working when. A DB trigger auto-creates a default rota_entry when this is set alongside scheduled_date.';
