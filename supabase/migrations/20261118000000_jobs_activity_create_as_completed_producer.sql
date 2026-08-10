-- Jobs activity→spine producer: emit job.completed on CREATE-as-completed.
--
-- DEFECT (C55 sibling on the hq_events spine): a job logged already-completed
-- from /jobs/new (createJob inserts directly with status='completed') fires the
-- jobs activity trigger's INSERT branch, which emitted ONLY 'job.created'.
-- 'job.status_changed' — the sole activity action the spine mapper
-- (public.hq_emit_from_activity) turns into the canonical 'job.completed' verb
-- (via p_action='job.status_changed' AND metadata.to='completed') — fired
-- EXCLUSIVELY in the UPDATE branch. Net: a create-as-completed job produced a
-- 'job.created' hq_events row but NEVER 'job.completed'. Since 'job.completed' is
-- an advertised, subscribable outbound-webhook verb (lib/webhooks/events.ts), a
-- subscribed endpoint would silently lose that completion once outbound webhooks
-- activate. This also restored automation/activity parity for the same case.
--
-- FIX (migrate-first, additive, idempotent): redefine public._tg_jobs_activity()
-- so the INSERT branch, when NEW.status='completed', ALSO records
-- 'job.status_changed' with {from: null, to: 'completed'} — in addition to the
-- unchanged 'job.created'. The mapper then produces 'job.completed' on
-- create-as-completed exactly as the UPDATE path does. Every other behaviour of
-- the function is preserved verbatim. Same in-transaction outbox contract; the
-- spine stays DARK behind hq_spine_dual_write_enabled() — this migration changes
-- no gate and produces no hq_events row until an operator flips the flag.
--
-- Engineering Bible: Ch.04 (event spine, producer contract), Ch.16 (append-only).

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
    -- Create-as-completed: also record the completion transition so the spine
    -- mapper emits 'job.completed', matching the UPDATE path. (from is NULL —
    -- there is no prior status on an insert.)
    if NEW.status = 'completed' then
      perform _record_activity(
        NEW.org_id,
        'job.status_changed',
        'jobs',
        NEW.id,
        jsonb_build_object('from', NULL, 'to', 'completed')
      );
    end if;
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
