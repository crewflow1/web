-- Asset Management — Milestone 4c: safety-blocking custody.
--
-- Closes the loop between M4 inspections and M2 custody: an asset with a CURRENT
-- issued safety-critical FAIL is unsafe and must not be issued. Enforced at the
-- DATABASE by EXTENDING the existing custody guard (tg_asset_assignments_guard),
-- so it applies to BOTH check-out (insert) AND transfer-in (the SECURITY INVOKER
-- transfer RPC) with no action-layer change — the frontend can never bypass it.
--
-- "Current" = an issued safety-critical fail NOT cleared by a LATER issued
-- safety-critical pass (a passing re-inspection). This makes reinspection /
-- return-to-service fall out for free: record + issue a passing safety-critical
-- inspection and the asset becomes issuable again — no separate state to flip.
--
-- This migration ONLY adds the new block; every prior check (same-org asset,
-- active-status eligibility, job/vehicle/assignee references) is reproduced
-- verbatim, since CREATE OR REPLACE swaps the whole function.

create or replace function public.tg_asset_assignments_guard()
returns trigger language plpgsql as $$
declare
  a_status text;
  a_org uuid;
begin
  select status, org_id into a_status, a_org from public.assets where id = new.asset_id;
  if a_org is null or a_org <> new.org_id then
    raise exception 'asset % is not in org %', new.asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  -- A new OPEN assignment requires an ACTIVE asset (retired/sold/lost/stolen/
  -- written_off cannot be issued). Closing/cancelling is always allowed.
  if new.status = 'open' and a_status <> 'active' then
    raise exception 'asset % is % and cannot be assigned', new.asset_id, a_status
      using errcode = 'check_violation';
  end if;
  -- SAFETY BLOCK (M4c): a new OPEN assignment is refused while the asset has an
  -- issued safety-critical FAIL that a later issued safety-critical PASS has not
  -- cleared. Only issue-time is gated; closing/cancelling is always allowed.
  if new.status = 'open' and exists (
    select 1 from public.asset_inspections f
    where f.asset_id = new.asset_id and f.org_id = new.org_id
      and f.safety_critical and f.status = 'issued' and f.outcome = 'fail'
      and not exists (
        select 1 from public.asset_inspections p
        where p.asset_id = f.asset_id and p.org_id = f.org_id
          and p.safety_critical and p.status = 'issued'
          and p.outcome in ('pass', 'pass_with_defects')
          and coalesce(p.inspected_at, p.created_at) > coalesce(f.inspected_at, f.created_at)
      )
  ) then
    raise exception 'asset % has a failed safety inspection and cannot be issued', new.asset_id
      using errcode = 'check_violation';
  end if;
  if new.job_id is not null
     and not exists (select 1 from public.jobs where id = new.job_id and org_id = new.org_id) then
    raise exception 'job % is not in org %', new.job_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.vehicle_asset_id is not null
     and not exists (select 1 from public.assets where id = new.vehicle_asset_id and org_id = new.org_id) then
    raise exception 'vehicle asset % is not in org %', new.vehicle_asset_id, new.org_id
      using errcode = 'check_violation';
  end if;
  if new.assignee_id is not null
     and not exists (select 1 from public.memberships where user_id = new.assignee_id and org_id = new.org_id) then
    raise exception 'assignee % is not a member of org %', new.assignee_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- The trigger binding is unchanged (same function name); no need to re-create it,
-- but do so idempotently to keep the migration self-contained on a fresh DB.
drop trigger if exists asset_assignments_guard on public.asset_assignments;
create trigger asset_assignments_guard before insert or update on public.asset_assignments
  for each row execute function public.tg_asset_assignments_guard();

-- A partial index to keep the safety lookup cheap (the un-cleared fails per asset).
create index if not exists asset_inspections_open_fail_idx
  on public.asset_inspections (asset_id, org_id)
  where safety_critical and status = 'issued' and outcome = 'fail';
