-- Programme E reconciliation fix — retention no-over-release, race-safe.
--
-- tg_retention_release_guard (20261005) computes accrued + already-released
-- with plain sum()s and NO lock on the parent job. Under READ COMMITTED two
-- concurrent releases for the same job each read released = 0, each pass the
-- bound, and both commit → total released exceeds accrued (a TOCTOU the
-- migration header wrongly claimed "holds for every writer").
--
-- Fix: lock the parent job row (FOR UPDATE) before summing, so concurrent
-- releases to the same job SERIALISE — the same pattern used by the payment
-- over-allocation guard. Function body otherwise unchanged.

create or replace function public.tg_retention_release_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate     numeric;
  v_org      uuid;
  v_base     numeric;
  v_accrued  numeric;
  v_released numeric;
begin
  -- FOR UPDATE: serialise concurrent releases against the same job so the
  -- released-sum below can never miss an in-flight sibling.
  select retention_percent, org_id into v_rate, v_org
  from public.jobs where id = new.job_id for update;

  if v_org is null then
    raise exception 'retention release: job % not found', new.job_id
      using errcode = 'check_violation';
  end if;
  if new.org_id <> v_org then
    raise exception 'retention release: org mismatch for job %', new.job_id
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_base
  from public.invoices
  where job_id = new.job_id and status <> 'draft';
  v_accrued := round(v_rate / 100.0 * v_base, 2);

  select coalesce(sum(amount), 0) into v_released
  from public.retention_releases
  where job_id = new.job_id;

  if v_released + new.amount > v_accrued + 0.005 then
    raise exception
      'retention release exceeds held retention (accrued %, already released %, requested %)',
      v_accrued, v_released, new.amount
      using errcode = 'check_violation';
  end if;

  return new;
end $$;
