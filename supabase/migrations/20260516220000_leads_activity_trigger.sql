-- Extend the activity_log capture surface to include the leads table.
--
-- The leads pipeline is the entry point to the revenue loop, so its
-- transitions belong in the same audit trail jobs/quotes/invoices/finances
-- already feed into.
--
-- Actions emitted:
--   - lead.created         on INSERT
--   - lead.stage_changed   on status update (with from/to)
--   - lead.assigned        on assigned_to change (with from/to)
--   - lead.deleted         on DELETE
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER.

create or replace function public._tg_leads_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id,
      'lead.created',
      'leads',
      NEW.id,
      jsonb_build_object(
        'source', NEW.source,
        'urgency', NEW.urgency,
        'service', NEW.service,
        'customer_id', NEW.customer_id,
        'estimated_value', NEW.estimated_value
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status then
      perform _record_activity(
        NEW.org_id,
        'lead.stage_changed',
        'leads',
        NEW.id,
        jsonb_build_object('from', OLD.status, 'to', NEW.status)
      );
    end if;
    if NEW.assigned_to is distinct from OLD.assigned_to then
      perform _record_activity(
        NEW.org_id,
        'lead.assigned',
        'leads',
        NEW.id,
        jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to)
      );
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id,
      'lead.deleted',
      'leads',
      OLD.id,
      jsonb_build_object('status', OLD.status)
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists leads_activity_trigger on public.leads;
create trigger leads_activity_trigger
  after insert or update or delete on public.leads
  for each row execute function _tg_leads_activity();
