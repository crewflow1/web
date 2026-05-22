-- CrewFlow HQ — Billing OS (HQ-4).
--
-- Two new tables + one column on organizations.
--
--   public.billing_invoices — internal-side invoices CrewFlow issues
--     to its CUSTOMERS (the construction companies). Distinct from
--     public.invoices, which is the contractor invoicing THEIR end
--     customers. The naming is deliberately not-overlapping so a
--     future refactor doesn't have to disambiguate.
--
--   public.billing_events — Stripe webhook landing zone. Empty until
--     HQ-4-stripe lands; the table is in place now so webhooks can
--     start flowing without a destructive migration later.
--
--   organizations.next_renewal_at — when the next monthly bill is
--     due. Operator-managed today; Stripe-managed once webhooks are
--     wired up.
--
-- Both tables are service-role-only: RLS enabled with no policies,
-- access mediated through the /admin/* pages which gate on
-- isSuperAdminEmail.

-- ------------------------------------------------------------------
-- billing_invoices
-- ------------------------------------------------------------------

create table if not exists public.billing_invoices (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  -- 'setup_fee' = one-off £1,000 charge at onboarding.
  -- 'subscription' = the monthly £500/mo recurring charge.
  -- 'overage' = ad-hoc charges (later).
  kind            text not null check (kind in ('setup_fee', 'subscription', 'overage')),
  -- 'draft' = created internally, not yet sent to the customer.
  -- 'sent' = invoice sent (manually for now, Stripe later).
  -- 'paid' = paid in full.
  -- 'failed' = payment attempt failed (Stripe past_due / chargeback).
  -- 'refunded' = paid then refunded.
  -- 'void' = cancelled before payment.
  status          text not null default 'draft'
                  check (status in ('draft', 'sent', 'paid', 'failed', 'refunded', 'void')),
  amount_gbp      numeric(10, 2) not null check (amount_gbp >= 0),
  currency        text not null default 'GBP',
  due_date        date,
  -- Lifecycle stamps so we can render a per-invoice timeline + sort
  -- by activity later.
  sent_at         timestamp with time zone,
  paid_at         timestamp with time zone,
  failed_at       timestamp with time zone,
  voided_at       timestamp with time zone,
  -- For subscription invoices, the period the charge covers.
  period_start    date,
  period_end      date,
  -- Stripe linkage — populated by webhooks in a future PR.
  stripe_invoice_id    text,
  stripe_payment_intent_id text,
  -- Failure metadata (Stripe declined-code / our manual note).
  failure_reason  text,
  -- Free-form note the operator can leave.
  notes           text,
  created_by      uuid references public.users(id) on delete set null,
  created_at      timestamp with time zone not null default now(),
  updated_at      timestamp with time zone not null default now()
);

alter table public.billing_invoices enable row level security;
-- No policies → service-role only.

create index if not exists billing_invoices_org_idx
  on public.billing_invoices (org_id, created_at desc);

create index if not exists billing_invoices_status_idx
  on public.billing_invoices (status, due_date);

create index if not exists billing_invoices_outstanding_idx
  on public.billing_invoices (org_id)
  where status in ('sent', 'failed');

create unique index if not exists billing_invoices_stripe_id_idx
  on public.billing_invoices (stripe_invoice_id)
  where stripe_invoice_id is not null;

-- Keep updated_at honest on every UPDATE.
create or replace function public._billing_invoices_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists billing_invoices_touch on public.billing_invoices;
create trigger billing_invoices_touch
  before update on public.billing_invoices
  for each row execute function public._billing_invoices_touch();

-- ------------------------------------------------------------------
-- billing_events — Stripe webhook landing zone (HQ-4-stripe)
-- ------------------------------------------------------------------

create table if not exists public.billing_events (
  id              uuid primary key default gen_random_uuid(),
  -- Stripe's event id (evt_...) — unique so re-delivery is a no-op.
  event_id        text unique,
  -- 'invoice.paid', 'customer.subscription.deleted', etc.
  event_type      text not null,
  -- Which org this event affected (nullable because some Stripe
  -- events arrive before we've linked the customer).
  org_id          uuid references public.organizations(id) on delete set null,
  payload         jsonb not null,
  processed_at    timestamp with time zone,
  error_message   text,
  created_at      timestamp with time zone not null default now()
);

alter table public.billing_events enable row level security;
-- No policies → service-role only.

create index if not exists billing_events_org_idx
  on public.billing_events (org_id, created_at desc);

create index if not exists billing_events_unprocessed_idx
  on public.billing_events (event_type, created_at desc)
  where processed_at is null;

-- ------------------------------------------------------------------
-- organizations.next_renewal_at
-- ------------------------------------------------------------------

alter table public.organizations
  add column if not exists next_renewal_at timestamp with time zone;
