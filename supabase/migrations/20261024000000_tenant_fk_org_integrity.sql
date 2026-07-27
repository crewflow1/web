-- Release-hardening — close the remaining bare-FK cross-tenant integrity gaps.
--
-- Adversarial pre-release review found three tables whose job_id/customer_id are
-- BARE single-column FKs: RLS checks only the row's own org_id, never the org of
-- the job/customer it points at. Every sibling table (purchase_orders 20261011,
-- risk_assessments 20261018, permits 20261019, finances bills 20261009,
-- invoice_payments 20260911) already enforces this in the DB. These three did not:
--
--   • completion_certificates (20261014) — job_id + customer_id.  A member of org A
--     could POST a cert (via PostgREST, bypassing the app) referencing org B's job
--     + customer. Not a confidentiality leak (the row stays in org A; the portal
--     read is org-pinned), but it is a cross-tenant WRITE and lets org A squat
--     org B's `one_live_per_job` unique slot — a cross-org DoS on cert issuance.
--   • blueprints (20261015) — job_id.  Inert today (org-scoped unique + storage RLS
--     + RLS-blocked joins), fixed for doctrine consistency.
--   • payments (20261010) — customer_id.  Inert today (no portal read path), fixed
--     for doctrine consistency.
--
-- Fix: BEFORE INSERT/UPDATE guards mirroring tg_purchase_order_org_integrity — NOT
-- composite FKs (these are ON DELETE SET NULL and org_id is NOT NULL, so a composite
-- FK would force ON DELETE CASCADE and wrongly delete the row when the job/customer
-- is removed). SECURITY DEFINER + pinned search_path. Null links are allowed (skip).
-- Also org-scopes completion_certificates_one_live_per_job so the uniqueness is a
-- per-(org,job) invariant. All target tables are RC-new + empty in prod → no lock/scan.

create or replace function public.tg_completion_certificate_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'completion certificate: job % is not in this org', new.job_id
        using errcode = 'check_violation';
    end if;
  end if;
  if new.customer_id is not null then
    select org_id into v_org from public.customers where id = new.customer_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'completion certificate: customer % is not in this org', new.customer_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists completion_certificates_org_integrity on public.completion_certificates;
create trigger completion_certificates_org_integrity
  before insert or update on public.completion_certificates
  for each row execute function public.tg_completion_certificate_org_integrity();

-- One live cert per (org, job): now that job_id is org-validated a job belongs to a
-- single org, but scope the uniqueness by org so the slot can never be squatted.
drop index if exists public.completion_certificates_one_live_per_job;
create unique index if not exists completion_certificates_one_live_per_job
  on public.completion_certificates (org_id, job_id)
  where status = 'issued' and job_id is not null;

create or replace function public.tg_blueprint_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.job_id is not null then
    select org_id into v_org from public.jobs where id = new.job_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'blueprint: job % is not in this org', new.job_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists blueprints_org_integrity on public.blueprints;
create trigger blueprints_org_integrity
  before insert or update on public.blueprints
  for each row execute function public.tg_blueprint_org_integrity();

create or replace function public.tg_payment_customer_org_integrity()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if new.customer_id is not null then
    select org_id into v_org from public.customers where id = new.customer_id;
    if v_org is null or v_org <> new.org_id then
      raise exception 'payment: customer % is not in this org', new.customer_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists payments_customer_org_integrity on public.payments;
create trigger payments_customer_org_integrity
  before insert or update on public.payments
  for each row execute function public.tg_payment_customer_org_integrity();
