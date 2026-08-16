-- P3W2 — Self-serve tenant billing / plan management (Stripe, DARK).
--
-- WHAT THIS IS. The DB substrate for "let a tenant admin change their own plan"
-- — upgrade / downgrade / cancel through Stripe's Billing Portal + Checkout,
-- instead of the mailto-to-hello@crewflow.uk that is the only path today. It
-- reuses CrewFlow's OWN SaaS-billing Stripe integration (lib/stripe/client.ts,
-- STRIPE_SECRET_KEY, the /api/webhooks/stripe route + its billing_events
-- idempotency). It is DELIBERATELY SEPARATE from:
--
--   • the DEMO setup-fee checkout (lib/stripe/demo-checkout.ts) — pre-org, one
--     off £1,000, keyed on demo_id; untouched here; and
--   • P2 PORTAL invoice payments (org_payment_connections / invoice_payment_
--     intents, STRIPE_CONNECT_SECRET_KEY, /api/webhooks/stripe-invoice) — the
--     tenant→CUSTOMER payment rail; a different key, route and client; untouched.
--
-- ONE new table:
--
--   org_subscriptions — one row per org recording that org's CrewFlow SaaS
--     subscription: which named plan (plan_key), the Stripe subscription
--     lifecycle status, the Stripe customer/subscription handles, the current
--     billing period, and the cancel-at-period-end intent. This is the
--     durable projection the /api/webhooks/stripe handler upserts from
--     customer.subscription.* events, and the tenant billing surface reads.
--     The plan CATALOGUE itself (names + feature entitlements) lives in config
--     (lib/billing/plans.ts) — deterministic, testable, no seed data, and so no
--     pricing amount is ever invented in a migration; the real Stripe price for
--     a plan is resolved at runtime by its lookup_key.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- This migration WRITES NOTHING — no org_subscriptions row is created. The
-- billing-portal / plan-change server actions REFUSE-before-fetch (no Stripe
-- call) while the feature flag (NEXT_PUBLIC_FEATURE_SELF_SERVE_BILLING) is off
-- OR the SaaS Stripe key (STRIPE_SECRET_KEY) is absent — which is ALWAYS, today.
-- A row exists only after a real, gated activation drives a Stripe subscription.
-- The entitlement gate defaults to ALLOW while the feature is dark, so wiring an
-- entitlement check into existing code changes nothing in production until the
-- feature is deliberately switched on.
--
-- ── TENANT ISOLATION ────────────────────────────────────────────────────────
-- org_id is NOT NULL, cascades on org delete, and is UNIQUE (one subscription
-- projection per org). RLS: every member may READ their org's subscription;
-- NO authenticated write policy exists — all writes go through the service-role
-- webhook handler / server actions (admin client). Composite (id, org_id) key
-- is exposed for any future child FK (the invoices_id_org_key idiom).
--
-- Additive and reversible. To roll back:
--   drop table public.org_subscriptions;

-- ============================================================================
-- org_subscriptions — per-org CrewFlow SaaS subscription projection
-- ============================================================================
create table if not exists public.org_subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  -- The named plan this org is on. A CLOSED set kept in lockstep with the
  -- config catalogue (lib/billing/plans.ts) by a drift test — adding a plan
  -- means widening BOTH. 'trial' is the default an org starts on (matches
  -- organizations.plan default), reachable while dark.
  plan_key               text not null default 'trial'
                           check (plan_key in ('trial', 'starter', 'pro', 'enterprise')),
  -- The Stripe SUBSCRIPTION lifecycle status, mirrored verbatim from Stripe so
  -- the projection never lies about what Stripe believes. Closed set = the
  -- Stripe subscription.status enum. 'incomplete' is the state a fresh
  -- subscription sits in before its first payment succeeds.
  status                 text not null default 'incomplete'
                           check (status in (
                             'trialing', 'active', 'past_due', 'canceled',
                             'unpaid', 'incomplete', 'incomplete_expired', 'paused'
                           )),
  -- Stripe linkage. customer_id mirrors organizations.stripe_customer_id (kept
  -- here too so the projection is self-contained). subscription_id is UNIQUE
  -- when present so a redelivered webhook upserts the same row, never a dup.
  stripe_customer_id     text,
  stripe_subscription_id text,
  -- The Stripe price the active subscription bills on (price_...). Diagnostic
  -- linkage only — the plan_key is the source of truth for entitlements.
  stripe_price_id        text,
  -- Current billing period bounds, from the Stripe subscription.
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  -- The tenant asked to cancel at period end (portal "cancel"): access
  -- continues until current_period_end, then Stripe fires subscription.deleted.
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  -- One subscription projection per org.
  constraint org_subscriptions_org_uniq unique (org_id),
  -- Composite-FK target for any future child (the invoices_id_org_key idiom).
  constraint org_subscriptions_id_org_key unique (id, org_id),
  -- The Stripe subscription id is globally unique when set — the webhook
  -- upsert idempotency anchor.
  constraint org_subscriptions_sub_uniq unique (stripe_subscription_id)
);

create index if not exists org_subscriptions_org_idx
  on public.org_subscriptions (org_id);

create index if not exists org_subscriptions_customer_idx
  on public.org_subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;

drop trigger if exists org_subscriptions_set_updated_at on public.org_subscriptions;
create trigger org_subscriptions_set_updated_at before update on public.org_subscriptions
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members READ, service-role-only WRITE ──────────────────────────────
-- The subscription projection is SaaS billing state written exclusively by the
-- Stripe webhook handler / admin-gated server actions (service role), never by
-- an authenticated tenant directly — so there is a member SELECT policy and NO
-- insert/update/delete policy at all (service_role bypasses RLS). This mirrors
-- invoice_payment_intents' service-role-write posture.
alter table public.org_subscriptions enable row level security;

drop policy if exists "org_subscriptions: members can select" on public.org_subscriptions;
create policy "org_subscriptions: members can select" on public.org_subscriptions
  for select to authenticated using (org_id in (select public.current_org_ids()));

-- anon has no surface on billing state at all.
revoke all on table public.org_subscriptions from anon;
