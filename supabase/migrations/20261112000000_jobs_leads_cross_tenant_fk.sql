-- Cross-tenant reference integrity for jobs + leads (hostile-audit 🔴).
--
-- The problem
-- -----------
-- jobs.customer_id / leads.customer_id are BARE FKs to the GLOBAL customers(id),
-- and jobs.assigned_to / leads.assigned_to are BARE FKs to the GLOBAL users(id).
-- The only tenant guard on the write path is `.eq("org_id", ctx.org.id)` on the
-- ROW being written — which constrains the org_id column the caller supplies,
-- never the customer/user the row POINTS AT. So a caller working in org A could
-- attach org B's customer_id, or a user who is not a member of org A, to an org A
-- job or lead. RLS cannot express this: it guards the row being written, not the
-- FK target. This is the invoices/#349 + invoice_payments/#351 defect class, now
-- closed for the CRM/jobs domain.
--
-- The shape — mirrors invoices (20260915000000) exactly
-- -----------------------------------------------------
--   customer_id: a COMPOSITE FK (customer_id, org_id) -> customers (id, org_id)
--     makes "a job/lead's customer must live in the job/lead's org" a DATABASE
--     invariant, enforced by Postgres for EVERY writer regardless of role — the
--     service-role/admin client included. customers already carries the
--     candidate key `customers_id_org_key` (id, org_id) that a composite FK
--     needs as its target (added by 20260915000000).
--
--   assigned_to: users has NO org_id column, so a composite FK is impossible.
--     Instead a BEFORE INSERT OR UPDATE trigger rejects a NEW.assigned_to that
--     is not a member of NEW.org_id. It mirrors FK re-check semantics — it runs
--     only when assigned_to (or org_id) actually changes — so a later edit to an
--     unrelated column never re-validates a stale assignee (a member who has
--     since left the org keeps their in-flight jobs editable; only SETTING or
--     CHANGING the assignee is gated). The bare users(id) FK + its ON DELETE SET
--     NULL are UNTOUCHED; this only adds the org-membership dimension.
--
-- ON DELETE semantics are PRESERVED
-- ---------------------------------
-- The original bare customer FKs on both tables were ON DELETE SET NULL (jobs:
-- 20260515150000; leads: baseline) — a deleted customer leaves the job/lead as
-- an unlinked audit record rather than deleting it. A plain composite
-- `on delete set null` would try to null BOTH referencing columns (customer_id
-- AND org_id), and org_id is NOT NULL, which would ABORT every customer delete.
-- So we use the PG15+ column-list form `on delete set null (customer_id)` — only
-- customer_id is nulled, org_id survives. (Same idiom as 20261084000000's
-- evidence-link FKs.) customer_id is nullable and the composite FK uses MATCH
-- SIMPLE, so a NULL customer_id is never checked — a job/lead with no customer is
-- valid, exactly as before.
--
-- Prod-data safety — MEASURED (linked project jzntbskdqdopzwdqwvkp, read-only):
-- 0 jobs and 0 leads with a cross-org customer_id; 0 jobs and 0 leads whose
-- assigned_to is not a member of the row's org. So both the FK swap and the
-- trigger apply cleanly against live data.
--
-- Additive and reversible:
--   alter table public.jobs  drop constraint jobs_customer_org_fkey;
--   alter table public.leads drop constraint leads_customer_org_fkey;
--   -- (optionally restore the bare FKs: references customers(id) on delete set null)
--   drop trigger  if exists jobs_assignee_member_guard  on public.jobs;
--   drop trigger  if exists leads_assignee_member_guard on public.leads;
--   drop function if exists public.tg_assignee_is_org_member();

-- ── 1. customers already has the candidate key the composite FK targets ──────
-- customers_id_org_key (id, org_id) was added by 20260915000000. Re-assert it
-- introspection-guarded so this migration is self-contained if run against a
-- database where that key is somehow absent.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_id_org_key'
  ) then
    alter table public.customers
      add constraint customers_id_org_key unique (id, org_id);
  end if;
end $$;

-- ── 2. jobs.customer_id → composite FK ──────────────────────────────────────
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'jobs_customer_id_fkey'
  ) then
    alter table public.jobs drop constraint jobs_customer_id_fkey;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_customer_org_fkey'
  ) then
    alter table public.jobs
      add constraint jobs_customer_org_fkey
      foreign key (customer_id, org_id)
      references public.customers (id, org_id)
      on delete set null (customer_id);
  end if;
end $$;

comment on constraint jobs_customer_org_fkey on public.jobs is
  'Tenant integrity: a job may reference only a customer in the same org. RLS '
  'cannot enforce this — it guards the row being written, not the customer the '
  'row points at. Mirrors invoices_customer_org_fkey (#349). ON DELETE SET NULL '
  '(customer_id) preserves the original bare FK''s semantics while keeping the '
  'NOT NULL org_id.';

-- ── 3. leads.customer_id → composite FK ─────────────────────────────────────
do $$ begin
  if exists (
    select 1 from pg_constraint where conname = 'leads_customer_id_fkey'
  ) then
    alter table public.leads drop constraint leads_customer_id_fkey;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'leads_customer_org_fkey'
  ) then
    alter table public.leads
      add constraint leads_customer_org_fkey
      foreign key (customer_id, org_id)
      references public.customers (id, org_id)
      on delete set null (customer_id);
  end if;
end $$;

comment on constraint leads_customer_org_fkey on public.leads is
  'Tenant integrity: a lead may reference only a customer in the same org. See '
  'jobs_customer_org_fkey.';

-- ── 4. assigned_to must be a member of the row''s org (jobs + leads) ─────────
-- users has no org_id, so a composite FK is impossible. A trigger enforces the
-- org-membership dimension for EVERY writer (service-role included — mirrors the
-- composite FK: there is no legitimate reason to assign a foreign-org user, and
-- the invoices/#351 proofs assert the FK holds even against the RLS-bypassing
-- service role). It runs only when assigned_to or org_id actually changes, so an
-- edit to an unrelated column never re-validates a stale assignee.
--
-- NOT security definer: `memberships` is readable here without elevated
-- privilege (the check is a plain EXISTS on the row's own org), matching the
-- house style of tg_stock_movements_authorised_write.
create or replace function public.tg_assignee_is_org_member()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.assigned_to is not null
     and (
       tg_op = 'INSERT'
       or new.assigned_to is distinct from old.assigned_to
       or new.org_id is distinct from old.org_id
     )
     and not exists (
       select 1 from public.memberships m
       where m.user_id = new.assigned_to
         and m.org_id = new.org_id
     )
  then
    raise exception
      'assigned_to % is not a member of org % — a job/lead may only be assigned to a member of its own organisation',
      new.assigned_to, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists jobs_assignee_member_guard on public.jobs;
create trigger jobs_assignee_member_guard
  before insert or update on public.jobs
  for each row execute function public.tg_assignee_is_org_member();

drop trigger if exists leads_assignee_member_guard on public.leads;
create trigger leads_assignee_member_guard
  before insert or update on public.leads
  for each row execute function public.tg_assignee_is_org_member();
