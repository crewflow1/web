-- Extend the activity_log capture surface to include the customers table.
--
-- Every other core entity (jobs, quotes, invoices, finances, leads) writes
-- to activity_log via a SECURITY DEFINER trigger. Customers were the
-- conspicuous gap — adding them here keeps the audit trail complete and
-- makes the in-app activity feed faithful.
--
-- Actions emitted:
--   - customer.created   on INSERT
--   - customer.updated   on UPDATE of any user-editable field
--   - customer.deleted   on DELETE
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS
-- before CREATE TRIGGER.

create or replace function public._tg_customers_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_fields text[] := '{}';
begin
  if TG_OP = 'INSERT' then
    perform _record_activity(
      NEW.org_id,
      'customer.created',
      'customers',
      NEW.id,
      jsonb_build_object(
        'name', NEW.name,
        'email', NEW.email,
        'phone', NEW.phone
      )
    );
    return NEW;
  elsif TG_OP = 'UPDATE' then
    -- Only emit an event when a user-editable field actually changed.
    -- updated_at always changes via tg_set_updated_at, so we skip that.
    if NEW.name  is distinct from OLD.name  then changed_fields := array_append(changed_fields, 'name');  end if;
    if NEW.email is distinct from OLD.email then changed_fields := array_append(changed_fields, 'email'); end if;
    if NEW.phone is distinct from OLD.phone then changed_fields := array_append(changed_fields, 'phone'); end if;
    if NEW.notes is distinct from OLD.notes then changed_fields := array_append(changed_fields, 'notes'); end if;
    if array_length(changed_fields, 1) is not null then
      perform _record_activity(
        NEW.org_id,
        'customer.updated',
        'customers',
        NEW.id,
        jsonb_build_object('fields', changed_fields, 'name', NEW.name)
      );
    end if;
    return NEW;
  elsif TG_OP = 'DELETE' then
    perform _record_activity(
      OLD.org_id,
      'customer.deleted',
      'customers',
      OLD.id,
      jsonb_build_object('name', OLD.name)
    );
    return OLD;
  end if;
  return null;
end;
$$;

drop trigger if exists customers_activity_trigger on public.customers;
create trigger customers_activity_trigger
  after insert or update or delete on public.customers
  for each row execute function _tg_customers_activity();
