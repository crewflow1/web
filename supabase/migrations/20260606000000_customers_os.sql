-- CrewFlow HQ — Customers OS (HQ-3).
--
-- Adds the financial / lifecycle / health fields the Customers OS
-- detail page reads + writes. Every field is additive + idempotent;
-- existing rows are backfilled to safe defaults so the page renders
-- something sensible for every org from the moment this migration
-- lands, before anyone has manually filled in numbers.
--
-- Stripe-related columns (`stripe_customer_id`, `stripe_subscription_id`,
-- `billing_email`) are added now even though Stripe isn't wired up —
-- the CEO directive asks for "future compatibility with Stripe", so
-- having the columns means the wiring PR doesn't need a destructive
-- alter later.
--
-- All columns stay org-scoped and editable only via the service-role
-- admin client (the columns aren't exposed in the customer-facing
-- /settings page until we explicitly decide to).

-- ------------------------------------------------------------------
-- Financials
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists setup_fee_status text not null default 'pending'
    check (setup_fee_status in ('pending', 'sent', 'paid', 'waived', 'refunded')),
  add column if not exists setup_fee_paid_at timestamp with time zone,
  add column if not exists mrr_gbp numeric(10, 2) not null default 0,
  add column if not exists ltv_gbp numeric(10, 2) not null default 0,
  add column if not exists currency text not null default 'GBP';

-- Backfill MRR for orgs that are already active or trial — every
-- customer is on the £500/mo flat plan today. Don't touch rows that
-- already have a non-zero value.
update public.organizations
   set mrr_gbp = 500
 where mrr_gbp = 0
   and status in ('active', 'trial');

-- ------------------------------------------------------------------
-- Onboarding / migration progress
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists onboarding_percent smallint not null default 0
    check (onboarding_percent between 0 and 100),
  add column if not exists migration_percent smallint not null default 0
    check (migration_percent between 0 and 100),
  add column if not exists migration_eta date,
  add column if not exists migration_stage text,
  add column if not exists onboarding_owner_id uuid references public.users(id) on delete set null;

-- ------------------------------------------------------------------
-- Usage + health
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists last_login_at timestamp with time zone,
  add column if not exists health_score smallint not null default 50
    check (health_score between 0 and 100),
  add column if not exists health_recomputed_at timestamp with time zone;

-- ------------------------------------------------------------------
-- Stripe future-compat (no logic yet; columns only)
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists billing_email text;

-- Useful indexes for the customers list filter / sort.

create index if not exists organizations_setup_fee_status_idx
  on public.organizations (setup_fee_status, created_at desc);

create index if not exists organizations_health_idx
  on public.organizations (health_score asc, status);

create index if not exists organizations_last_login_idx
  on public.organizations (last_login_at desc nulls last);
