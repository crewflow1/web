-- Job CANCELLED — a real terminal state so cancelling work never means
-- deleting it.
--
-- WHY: the E2E acceptance audit found jobs had no cancelled state (only
-- new/in-progress/completed/blocked), so a cancelled project was either left
-- polluting active views as "blocked" (a hold, not a cancel) or hard-deleted
-- (destroying diary/safety/financial history). With a real customer live
-- that becomes routine DB surgery.
--
-- SEMANTICS:
--   • new / in-progress / blocked → cancelled: allowed (owner/admin via the
--     existing job-edit authority; RLS already limits job UPDATE to admins).
--   • completed → cancelled: REFUSED — finished, financially-finalised work
--     is history, not something to cancel. Correcting a mis-completed job is
--     an explicit status edit back to in-progress first (already supported),
--     which keeps the two corrections distinct and deliberate.
--   • cancelled is TERMINAL except for an explicit reopen to 'new' (mistake
--     recovery — cancelling the wrong job must not need DB surgery either).
--     Reopening clears the cancellation audit fields.
--   • Nothing cascades: documents, diary, safety records, costs and invoices
--     all remain attached and readable; operational "active" views exclude
--     the job because every such view allowlists active statuses.
--
-- FINANCIAL EFFECT: none by construction — job status gates no financial
-- calculation (costing/profit read finances/time/stock by job id regardless
-- of status), and active-view exclusion is presentation.

alter table public.jobs
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancelled_by  uuid references auth.users (id) on delete set null,
  add column if not exists cancel_reason text;

-- Widen the CHECK (the constraint is unnamed in 20260515150000 → auto-named).
alter table public.jobs drop constraint if exists jobs_status_check;
alter table public.jobs
  add constraint jobs_status_check
  check (status in ('new', 'in-progress', 'completed', 'blocked', 'cancelled'));

create or replace function public.tg_jobs_cancel_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- A job can be cancelled, never BORN cancelled: an INSERT with
  -- status='cancelled' would skip the audit stamp entirely. Refuse it.
  if tg_op = 'INSERT' then
    if new.status = 'cancelled' then
      raise exception 'a job cannot be created as cancelled — create it, then cancel it';
    end if;
    return new;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if old.status = 'completed' then
      raise exception 'a completed job cannot be cancelled — reopen it first if it was completed by mistake';
    end if;
    -- The trigger owns the timestamp (can't be forged or omitted).
    new.cancelled_at := now();
  end if;

  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    -- Explicit reopen path: cancelled → new only (mistake recovery).
    if new.status <> 'new' then
      raise exception 'a cancelled job can only be reopened to "new"';
    end if;
    new.cancelled_at  := null;
    new.cancelled_by  := null;
    new.cancel_reason := null;
  end if;

  -- Outside a cancel/reopen transition the audit fields don't move.
  if new.status is not distinct from old.status and old.status is distinct from 'cancelled' then
    new.cancelled_at  := old.cancelled_at;
    new.cancelled_by  := old.cancelled_by;
    new.cancel_reason := old.cancel_reason;
  end if;

  return new;
end $$;

drop trigger if exists jobs_cancel_guard on public.jobs;
create trigger jobs_cancel_guard
  before insert or update on public.jobs
  for each row execute function public.tg_jobs_cancel_guard();
