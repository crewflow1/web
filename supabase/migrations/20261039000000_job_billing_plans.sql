-- H2-CASH — Billing Plans (deposit / staged / milestone payment schedules).
--
-- The layer ABOVE invoices: a builder carves a job's contract into stages
-- (deposit, first fix, on completion, …) and each stage GENERATES A NORMAL
-- INVOICE via the existing authority. The plan stores NO money of its own —
-- invoices + payments stay the single source of truth for value and cash.
--
-- Model (UK construction, 5–50-person firms):
--   * Stage amounts are NET (ex-VAT). VAT is added per stage on top at its rate.
--   * Stages PARTITION the contract: Σ(stage net) ≤ basis (the ex-VAT contract).
--     A deposit is simply the first slice; a later stage bills a further,
--     non-overlapping slice (never "earned less deposit" — no credit machinery).
--   * Retention is withheld from each certified stage by the EXISTING retention
--     engine (unchanged); it is not a stage here.
--
-- Reuse, never fork: invoices (public.invoices + next_invoice_number),
-- payment allocation (invoice_payments + allocate_payment), retention
-- (lib/retentions + retention_releases). No provider, bucket, cron or env added.
--
-- Additive + reversible. To roll back:
--   drop function public.generate_stage_invoice(uuid, date);
--   drop table public.job_billing_stages;  drop table public.job_billing_plans;
--   drop type public.billing_stage_basis; drop type public.billing_stage_kind;
--   drop type public.billing_plan_structure;
-- Migrate-first safe: the app reads these tables best-effort; absent → no plan.

-- ── enums ───────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_type where typname = 'billing_plan_structure') then
    create type public.billing_plan_structure as enum ('full','deposit_balance','staged','milestone','progress');
  end if;
  if not exists (select 1 from pg_type where typname = 'billing_stage_kind') then
    create type public.billing_stage_kind as enum ('deposit','stage','balance');
  end if;
  if not exists (select 1 from pg_type where typname = 'billing_stage_basis') then
    create type public.billing_stage_basis as enum ('fixed','percent');
  end if;
end $$;

-- ── job_billing_plans ────────────────────────────────────────────────────────
create table if not exists public.job_billing_plans (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  structure    public.billing_plan_structure not null default 'staged',
  -- Ex-VAT contract basis snapshot at creation + the ceiling for Σ(stage net).
  -- 0 == "no ceiling" (ad-hoc / progress). The LIVE contract value stays owned
  -- by lib/commercial/cash.ts; this is a stable ceiling, not a second truth.
  basis_amount numeric(12,2) not null default 0 check (basis_amount >= 0),
  status       text not null default 'active' check (status in ('active','cancelled')),
  notes        text,
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Composite-FK target so stages bind (plan_id, org_id) — cross-tenant safe.
  constraint job_billing_plans_id_org_key unique (id, org_id)
);
-- One ACTIVE plan per job (a fresh plan requires cancelling the old one).
create unique index if not exists job_billing_plans_one_active
  on public.job_billing_plans (job_id) where status = 'active';
create index if not exists job_billing_plans_org_job_idx
  on public.job_billing_plans (org_id, job_id);

-- ── job_billing_stages ───────────────────────────────────────────────────────
create table if not exists public.job_billing_stages (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  plan_id           uuid not null,
  job_id            uuid not null references public.jobs(id) on delete cascade,
  sequence          int not null default 0,
  name              text not null check (length(trim(name)) > 0 and length(name) <= 120),
  kind              public.billing_stage_kind not null default 'stage',
  basis             public.billing_stage_basis not null default 'fixed',
  percent           numeric(5,2) check (percent is null or (percent >= 0 and percent <= 100)),
  amount            numeric(12,2) not null default 0 check (amount >= 0),  -- ex-VAT, resolved
  vat_rate          numeric(5,2) not null default 20 check (vat_rate in (0, 5, 20)),
  retention_applies boolean not null default true,
  due_date          date,
  milestone         text,
  -- The generated invoice (nullable until generated). SET NULL on invoice delete
  -- so a deleted invoice makes the stage re-invoiceable.
  invoice_id        uuid,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Composite-FK org binding (holds for service_role too): stage.org must equal
  -- its plan's org and its invoice's org — forged plan_id/invoice_id can't cross tenants.
  constraint job_billing_stages_plan_fk
    foreign key (plan_id, org_id) references public.job_billing_plans (id, org_id) on delete cascade,
  constraint job_billing_stages_invoice_fk
    foreign key (invoice_id, org_id) references public.invoices (id, org_id) on delete set null
);
-- Idempotency: a generated invoice belongs to EXACTLY ONE stage.
create unique index if not exists job_billing_stages_invoice_unique
  on public.job_billing_stages (invoice_id) where invoice_id is not null;
create index if not exists job_billing_stages_org_job_idx on public.job_billing_stages (org_id, job_id);
create index if not exists job_billing_stages_plan_idx    on public.job_billing_stages (plan_id, sequence);

-- ── org-integrity: the row's job must belong to the row's org ────────────────
-- (jobs has no (id, org_id) candidate key, so a composite FK isn't available for
--  job_id — use the SECURITY DEFINER org-match guard, the 20261024 pattern.)
create or replace function public.tg_billing_assert_job_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare j_org uuid;
begin
  select org_id into j_org from public.jobs where id = new.job_id;
  if j_org is null then
    raise exception 'billing plan/stage references a non-existent job';
  end if;
  if j_org is distinct from new.org_id then
    raise exception 'a billing row org must match its job''s org';
  end if;
  -- A stage must belong to the SAME job as its plan (attribution integrity).
  if tg_table_name = 'job_billing_stages' then
    if (select job_id from public.job_billing_plans where id = new.plan_id) is distinct from new.job_id then
      raise exception 'a billing stage must belong to its plan''s job';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists job_billing_plans_assert_job_org on public.job_billing_plans;
create trigger job_billing_plans_assert_job_org before insert or update on public.job_billing_plans
  for each row execute function public.tg_billing_assert_job_org();
drop trigger if exists job_billing_stages_assert_job_org on public.job_billing_stages;
create trigger job_billing_stages_assert_job_org before insert or update on public.job_billing_stages
  for each row execute function public.tg_billing_assert_job_org();

-- ── immutability: a stage's money is frozen once it has been invoiced ─────────
-- (all roles — a committed bill can't be silently re-priced under a live invoice).
create or replace function public.tg_billing_stage_frozen_when_invoiced()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.invoice_id is not null then
    if new.amount is distinct from old.amount
       or new.vat_rate is distinct from old.vat_rate
       or new.percent is distinct from old.percent
       or new.basis is distinct from old.basis
       or new.kind is distinct from old.kind
       or new.retention_applies is distinct from old.retention_applies then
      raise exception 'a billing stage cannot be re-priced once it has been invoiced';
    end if;
    -- The stage↔invoice binding is immutable for tenants: only the FK cascade
    -- (the invoice itself being deleted) may unlink it. A manual relink or a
    -- manual null-out while the invoice still exists would let the stage be
    -- re-invoiced → a SECOND live invoice for one milestone. Distinguish the
    -- legitimate cascade (invoice gone) from tampering (invoice still present).
    if new.invoice_id is distinct from old.invoice_id then
      if new.invoice_id is not null then
        raise exception 'a billing stage cannot be relinked to a different invoice';
      end if;
      if exists (select 1 from public.invoices where id = old.invoice_id) then
        raise exception 'a billing stage cannot be unlinked from its live invoice';
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists job_billing_stages_frozen on public.job_billing_stages;
create trigger job_billing_stages_frozen before update on public.job_billing_stages
  for each row execute function public.tg_billing_stage_frozen_when_invoiced();
-- NOTE: a DELETE guard on invoiced stages was considered but rejected — a cascade
-- delete (job/plan/org teardown) fires the same BEFORE DELETE and would block
-- legitimate teardown. The freeze above is teardown-safe (cascade unlink sets
-- invoice_id null AFTER the invoice row is gone, which it allows). Residual (P3):
-- an admin directly deleting an invoiced stage orphans (does not hide) its
-- invoice — the invoice survives and stays visible to the customer.

-- ── invariant: Σ(stage net) ≤ plan basis (unless basis == 0 = no ceiling) ─────
-- FOR UPDATE-locks the plan so concurrent stage writes serialise (TOCTOU-safe,
-- mirrors the retention over-release guard). +0.005 half-penny tolerance.
create or replace function public.tg_billing_stage_within_basis()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_basis numeric(12,2); v_sum numeric(12,2);
begin
  select basis_amount into v_basis from public.job_billing_plans where id = new.plan_id for update;
  if v_basis is null or v_basis <= 0 then return new; end if;  -- no ceiling
  select coalesce(sum(amount), 0) into v_sum
    from public.job_billing_stages
    where plan_id = new.plan_id and id is distinct from new.id;
  if round(v_sum + new.amount, 2) > round(v_basis, 2) + 0.005 then
    raise exception 'billing stages (%) would exceed the contract basis (%)', round(v_sum + new.amount, 2), v_basis;
  end if;
  return new;
end $$;
drop trigger if exists job_billing_stages_within_basis on public.job_billing_stages;
create trigger job_billing_stages_within_basis before insert or update on public.job_billing_stages
  for each row execute function public.tg_billing_stage_within_basis();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- A billing plan is job-level commercial CONFIGURATION → admin writes (owner/
-- admin), members read. This is DB-enforced (is_org_admin in the write policies),
-- so the admin boundary survives a direct-PostgREST caller (closing the app-only
-- -gate gap). Generating a stage invoice is admin too (via the RPC's own check).
alter table public.job_billing_plans enable row level security;
alter table public.job_billing_stages enable row level security;

create policy job_billing_plans_select on public.job_billing_plans
  for select to authenticated using (org_id in (select public.current_org_ids()));
create policy job_billing_plans_insert on public.job_billing_plans
  for insert to authenticated with check (public.is_org_admin(org_id));
create policy job_billing_plans_update on public.job_billing_plans
  for update to authenticated using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy job_billing_plans_delete on public.job_billing_plans
  for delete to authenticated using (public.is_org_admin(org_id));

create policy job_billing_stages_select on public.job_billing_stages
  for select to authenticated using (org_id in (select public.current_org_ids()));
create policy job_billing_stages_insert on public.job_billing_stages
  for insert to authenticated with check (public.is_org_admin(org_id));
create policy job_billing_stages_update on public.job_billing_stages
  for update to authenticated using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
create policy job_billing_stages_delete on public.job_billing_stages
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── generate_stage_invoice: atomic, idempotent, admin-only ───────────────────
-- Reuses the invoice authority exactly: quote_id NULL, job_id + customer from the
-- job, ex-VAT amount + per-stage VAT, sequential number via next_invoice_number,
-- one descriptive line item, status 'draft'. CAS on invoice_id (FOR UPDATE) makes
-- a double-click / two-admin race generate ONE invoice. total is never written
-- (generated). SECURITY DEFINER with an explicit admin check — no orphan on denial.
create or replace function public.generate_stage_invoice(p_stage_id uuid, p_due_date date default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_stage    public.job_billing_stages%rowtype;
  v_customer uuid;
  v_number   text;
  v_vat      numeric(12,2);
  v_due      date;
  v_invoice  uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;

  select * into v_stage from public.job_billing_stages where id = p_stage_id for update;
  if not found then raise exception 'billing stage not found'; end if;
  if not public.is_org_admin(v_stage.org_id) then
    raise exception 'only an owner or admin can generate a stage invoice';
  end if;
  if (select status from public.job_billing_plans where id = v_stage.plan_id) <> 'active' then
    raise exception 'the billing plan is not active';
  end if;
  if v_stage.invoice_id is not null then raise exception 'this stage has already been invoiced'; end if;
  if v_stage.amount <= 0 then raise exception 'a stage must have a positive amount to invoice'; end if;

  select customer_id into v_customer from public.jobs where id = v_stage.job_id;
  if v_customer is null then
    raise exception 'this job has no customer — set a customer on the job before invoicing';
  end if;

  v_number := public.next_invoice_number(v_stage.org_id);
  v_vat := round(v_stage.amount * v_stage.vat_rate / 100.0, 2);
  v_due := coalesce(p_due_date, v_stage.due_date, ((now() at time zone 'utc')::date + 14));

  insert into public.invoices (org_id, job_id, quote_id, customer_id, number, amount, vat_total, status, due_date, notes)
    values (v_stage.org_id, v_stage.job_id, null, v_customer, v_number, v_stage.amount, v_vat, 'draft', v_due, v_stage.name)
    returning id into v_invoice;

  insert into public.invoice_line_items (invoice_id, org_id, description, qty, unit, unit_price, vat_rate, line_total, sort_order)
    values (v_invoice, v_stage.org_id, v_stage.name, 1, 'item', v_stage.amount, v_stage.vat_rate, v_stage.amount, 0);

  update public.job_billing_stages set invoice_id = v_invoice where id = p_stage_id;
  return v_invoice;
end $$;

revoke all on function public.generate_stage_invoice(uuid, date) from public;
grant execute on function public.generate_stage_invoice(uuid, date) to authenticated;
