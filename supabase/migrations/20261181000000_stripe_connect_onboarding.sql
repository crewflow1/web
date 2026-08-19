-- MP W2 — tenant Stripe Connect ONBOARDING capability state (DARK).
--
-- WHAT THIS IS. The portal invoice-payment path (20261120) shipped BUILT-DARK:
-- a customer can pay a tenant's invoice ON that tenant's connected Stripe account
-- once org_payment_connections.status = 'connected'. But NOTHING created a
-- connected account or wrote that row — the only way to 'connected' was a manual
-- DB insert. This migration is the DB half of the missing onboarding: it lets the
-- tenant onboarding flow record a Stripe connected account's real CAPABILITY
-- STATE (the values Stripe returns from accounts.retrieve) so the two-switch gate
-- can flip to 'connected' honestly — only when Stripe says the account can charge.
--
-- 20261120 created org_payment_connections with { status, stripe_account_id,
-- account_name, default_currency, connected_by, connected_at, last_error, ... }
-- but no per-capability columns and a status CHECK of
-- ('disconnected','connected','error'). Express/Standard onboarding is a
-- multi-step hosted flow: an account can EXIST (stripe_account_id set) yet not be
-- able to accept charges until the tenant finishes Stripe's form. That interim
-- state is neither 'disconnected' nor 'connected' nor an 'error' — it is
-- 'pending'. So this migration is additive:
--
--   1. add the capability columns Stripe reports — charges_enabled,
--      payouts_enabled, details_submitted — plus last_synced_at (when we last
--      polled accounts.retrieve). All default to the SAFEST value (false / null),
--      so an existing row (there are none in prod — the feature is dark) is
--      unchanged and cannot suddenly read as chargeable.
--
--   2. widen the status CHECK to admit 'pending' (account created, onboarding not
--      yet complete). The 'connected' state is now bound to Stripe's OWN
--      charges_enabled: the onboarding service only writes status='connected' when
--      accounts.retrieve reports charges_enabled = true, so the pay-now gate
--      (status === 'connected') can never open on an account Stripe would refuse.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- This migration WRITES NOTHING and creates no account. Onboarding refuses before
-- any Stripe call while the feature flag (NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS) is
-- off OR the platform Connect key (STRIPE_CONNECT_SECRET_KEY) is absent — which is
-- ALWAYS, today. A 'pending'/'connected' row exists only after a real, gated
-- onboarding by an org admin. The pre-existing connected-needs-account CHECK still
-- holds: a 'connected' row must still name a Stripe connected account.
--
-- Additive and reversible. To roll back:
--   alter table public.org_payment_connections drop constraint org_payment_connections_status_check;
--   alter table public.org_payment_connections add constraint org_payment_connections_status_check
--     check (status in ('disconnected', 'connected', 'error'));
--   alter table public.org_payment_connections
--     drop column if exists charges_enabled,
--     drop column if exists payouts_enabled,
--     drop column if exists details_submitted,
--     drop column if exists last_synced_at;

-- ============================================================================
-- 1. Capability columns — the real state Stripe reports for the account
-- ============================================================================
-- IF NOT EXISTS keeps this safe to re-run and safe if a later baseline ever
-- folds these in. Defaults are the SAFEST reading: a row is not chargeable until
-- Stripe says so.
alter table public.org_payment_connections
  add column if not exists charges_enabled   boolean not null default false,
  add column if not exists payouts_enabled   boolean not null default false,
  add column if not exists details_submitted boolean not null default false,
  add column if not exists last_synced_at    timestamptz;

comment on column public.org_payment_connections.charges_enabled is
  'Stripe accounts.retrieve.charges_enabled — the account can accept charges. The onboarding service ties status=connected to this being true.';
comment on column public.org_payment_connections.payouts_enabled is
  'Stripe accounts.retrieve.payouts_enabled — the account can receive payouts.';
comment on column public.org_payment_connections.details_submitted is
  'Stripe accounts.retrieve.details_submitted — the tenant finished the hosted onboarding form.';
comment on column public.org_payment_connections.last_synced_at is
  'When accounts.retrieve was last polled to refresh the capability columns above.';

-- ============================================================================
-- 2. Admit 'pending' to the status CHECK (account created, onboarding incomplete)
-- ============================================================================
-- 'pending' carries a stripe_account_id but is NOT yet chargeable — the pay-now
-- gate checks status='connected', so a pending account cannot take money. Widen
-- the CHECK additively; the default stays 'disconnected'.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'org_payment_connections_status_check'
  ) then
    alter table public.org_payment_connections
      drop constraint org_payment_connections_status_check;
  end if;
  alter table public.org_payment_connections
    add constraint org_payment_connections_status_check
    check (status in ('disconnected', 'pending', 'connected', 'error'));
end $$;

-- The pre-existing connected-needs-account CHECK (20261120) is untouched: a
-- 'connected' row must still name a Stripe connected account. A 'pending' row
-- also always names one in practice (the account is created before the row is
-- written), but the constraint only binds the strongest state, 'connected'.
