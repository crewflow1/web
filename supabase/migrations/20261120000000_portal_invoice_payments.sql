-- P2 Payments — customer invoice payment in the portal (Stripe, DARK).
--
-- WHAT THIS IS. The DB substrate for "let a tenant's CUSTOMER pay their invoice
-- online" — a flow that does NOT exist today (the portal shows invoices as
-- view/PDF only; customers upload a bank-transfer proof matched by hand). It is
-- entirely SEPARATE from CrewFlow's own SaaS billing (lib/stripe/*,
-- billing_events, /api/webhooks/stripe), which stays untouched.
--
-- Two new tables + one additive constraint change:
--
--   1. org_payment_connections — one row per (org, provider) recording whether a
--      tenant has bound a Stripe CONNECT account to receive customer invoice
--      payments. The per-tenant SECOND SWITCH of the two-switch dark gate: with
--      no connected account a tenant cannot take a payment, whatever the flag.
--      The Stripe account id (acct_...) is NOT a secret (it is not a credential;
--      money moves via the PLATFORM key + this account header), so unlike the
--      banking/accounting substrates there are no token columns to strip.
--
--   2. invoice_payment_intents — the intent + reconciliation ledger. One row per
--      Checkout Session / PaymentIntent we create for an invoice, carrying the
--      Stripe ids, the connected account it was created on, the amount, a
--      lifecycle status, and — once the webhook settles it — the id of the
--      invoice_payments row it produced. This link is the IDEMPOTENCY anchor: a
--      settled intent (invoice_payment_id set) records nothing further, so a
--      redelivered webhook is a no-op and the money is never double-counted.
--
--   3. invoice_payments.source gains 'stripe' — a Stripe-settled receipt is
--      recorded into the SAME invoice_payments ledger the manual + bank_csv
--      paths use, so the invoice status trigger, the portal balance, and every
--      reconciliation surface already work with zero further change. The manual
--      bank-transfer-proof path is entirely unaffected.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- This migration WRITES NOTHING. No org_payment_connections row is created; the
-- pay-now action + webhook REFUSE-before-fetch while the feature flag
-- (NEXT_PUBLIC_FEATURE_PORTAL_PAYMENTS) is off, the platform Connect key
-- (STRIPE_CONNECT_SECRET_KEY) is absent, or the org has no connected account —
-- which is ALWAYS, today. A row exists only after a real, gated activation.
--
-- ── TENANT ISOLATION ────────────────────────────────────────────────────────
-- A customer paying credits EXACTLY their tenant's invoice: the intent is created
-- on the tenant's OWN Stripe connected account and carries org_id/invoice_id
-- metadata; the webhook cross-checks the settling event's `account` against the
-- intent's stripe_account_id AND the metadata org/invoice against the intent
-- before recording. Composite FKs (id, org_id) below make a cross-tenant
-- invoice/customer reference structurally impossible.
--
-- Additive and reversible. To roll back:
--   alter table public.invoice_payments drop constraint invoice_payments_source_check;
--   alter table public.invoice_payments add constraint invoice_payments_source_check
--     check (source in ('manual', 'bank_csv'));
--   drop table public.invoice_payment_intents;
--   drop table public.org_payment_connections;

-- ============================================================================
-- 1. invoice_payments.source — admit 'stripe' alongside 'manual' / 'bank_csv'
-- ============================================================================
-- The receipt of a Stripe-settled payment lands in the EXISTING ledger. Widen
-- the CHECK additively; the default stays 'manual', so nothing else changes.
do $$
begin
  if exists (
    select 1 from pg_constraint where conname = 'invoice_payments_source_check'
  ) then
    alter table public.invoice_payments drop constraint invoice_payments_source_check;
  end if;
  alter table public.invoice_payments
    add constraint invoice_payments_source_check
    check (source in ('manual', 'bank_csv', 'stripe'));
end $$;

-- ============================================================================
-- 2. org_payment_connections — per-org Stripe Connect binding (SWITCH 2)
-- ============================================================================
create table if not exists public.org_payment_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The payment provider this row binds the org to. A small, closed set;
  -- 'stripe' is the only member today (Stripe Connect).
  provider           text not null default 'stripe' check (provider in ('stripe')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no account bound (the only state reachable dark). Default.
  --   connected    — a Stripe connected account is bound (requires an account id).
  --   error        — the last connect/verify failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connected', 'error')),
  -- The tenant's Stripe CONNECTED ACCOUNT id (acct_...). NOT a secret — it is a
  -- public account handle, never a credential. Money moves via the platform
  -- Connect key + this account header, so nothing here needs column stripping.
  -- Nullable: absent until a real connection is bound.
  stripe_account_id  text,
  account_name       text,
  -- Default currency the tenant collects in (ISO 4217, lower-case for Stripe).
  default_currency   text not null default 'gbp',
  connected_by       uuid references public.users(id) on delete set null,
  connected_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One connection per provider per org. Re-connecting upserts this row.
  constraint org_payment_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for children (the invoices_id_org_key idiom).
  constraint org_payment_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without an account handle. There is no fake connected
  -- state: a connected row must name a Stripe connected account.
  constraint org_payment_connections_connected_needs_account check (
    status <> 'connected'
    or stripe_account_id is not null
  )
);

create index if not exists org_payment_connections_org_idx
  on public.org_payment_connections (org_id);

drop trigger if exists org_payment_connections_set_updated_at on public.org_payment_connections;
create trigger org_payment_connections_set_updated_at before update on public.org_payment_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
-- The bank_connections / accounting_connections posture: every member may READ
-- whether payments are connected; only an admin may bind/unbind an account.
alter table public.org_payment_connections enable row level security;

drop policy if exists "org_payment_connections: members can select" on public.org_payment_connections;
create policy "org_payment_connections: members can select" on public.org_payment_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "org_payment_connections: admins can insert" on public.org_payment_connections;
create policy "org_payment_connections: admins can insert" on public.org_payment_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "org_payment_connections: admins can update" on public.org_payment_connections;
create policy "org_payment_connections: admins can update" on public.org_payment_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "org_payment_connections: admins can delete" on public.org_payment_connections;
create policy "org_payment_connections: admins can delete" on public.org_payment_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- anon has no surface on org configuration at all.
revoke all on table public.org_payment_connections from anon;

-- ============================================================================
-- 3. invoice_payment_intents — the intent + reconciliation ledger (idempotency)
-- ============================================================================
create table if not exists public.invoice_payment_intents (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references public.organizations(id) on delete cascade,
  invoice_id                uuid not null,
  customer_id               uuid,
  -- The connected account the intent was created ON. The webhook cross-checks
  -- the settling event's `account` against this — the tenant-isolation anchor.
  stripe_account_id         text not null,
  -- Stripe object ids. The Checkout Session is created first; its PaymentIntent
  -- id is populated when known. Either is a valid idempotency key on settle.
  stripe_checkout_session_id text,
  stripe_payment_intent_id  text,
  amount                    numeric(12, 2) not null check (amount > 0),
  currency                  text not null default 'gbp',
  -- LIFECYCLE.
  --   created    — session minted, awaiting the customer (the only dark-reachable
  --                state — but no session is minted dark, so no row is written).
  --   processing — Stripe reports the charge in flight.
  --   succeeded  — settled; invoice_payment_id below names the recorded receipt.
  --   failed / canceled — terminal non-success.
  status                    text not null default 'created'
                              check (status in ('created', 'processing', 'succeeded', 'failed', 'canceled')),
  -- The invoice_payments row this intent produced on success. NULL until settled.
  -- Set-once is the IDEMPOTENCY anchor: the settle path records a receipt only
  -- while this is NULL, so a redelivered webhook records nothing and the money is
  -- never double-counted.
  invoice_payment_id        uuid references public.invoice_payments(id) on delete set null,
  -- The Stripe event id that settled this intent — audit + last-write provenance.
  settled_event_id          text,
  last_error                text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  -- Cross-tenant reference injection is structurally impossible: an intent can
  -- only reference an invoice / customer in its OWN org.
  constraint invoice_payment_intents_invoice_org_fkey
    foreign key (invoice_id, org_id) references public.invoices(id, org_id) on delete cascade,
  -- ON DELETE CASCADE (not SET NULL): a multi-column SET NULL would try to null
  -- org_id too, which is NOT NULL — the same reason invoices_customer_org_fkey
  -- (20260915) is CASCADE. Deleting a customer already cascades their invoices,
  -- which cascade these intents via the invoice FK above, so this rarely fires
  -- independently. customer_id stays nullable (a legacy quote-only invoice).
  constraint invoice_payment_intents_customer_org_fkey
    foreign key (customer_id, org_id) references public.customers(id, org_id) on delete cascade,
  -- IDEMPOTENCY at the DB: one intent per Stripe PaymentIntent / Session, and a
  -- given invoice_payments receipt is claimed by at most one intent.
  constraint invoice_payment_intents_pi_uniq unique (stripe_payment_intent_id),
  constraint invoice_payment_intents_session_uniq unique (stripe_checkout_session_id),
  constraint invoice_payment_intents_payment_uniq unique (invoice_payment_id),
  -- Composite-FK target for any future child (the invoices_id_org_key idiom).
  constraint invoice_payment_intents_id_org_key unique (id, org_id)
);

create index if not exists invoice_payment_intents_org_idx
  on public.invoice_payment_intents (org_id);
create index if not exists invoice_payment_intents_invoice_idx
  on public.invoice_payment_intents (invoice_id);
create index if not exists invoice_payment_intents_status_idx
  on public.invoice_payment_intents (org_id, status);

drop trigger if exists invoice_payment_intents_set_updated_at on public.invoice_payment_intents;
create trigger invoice_payment_intents_set_updated_at before update on public.invoice_payment_intents
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, SERVICE-ROLE write ───────────────────────────────────
-- Members may READ the intents against their org's invoices (so staff see a
-- pending/succeeded online payment on the invoice). Intents are created + settled
-- by the portal action + the webhook, both on the service-role admin client
-- (the customer portal has no Supabase JWT), so there is deliberately NO
-- authenticated INSERT/UPDATE/DELETE policy: a tenant JWT cannot forge, mutate,
-- or delete an intent over PostgREST. service_role (RLS-bypassing) is the sole
-- writer.
alter table public.invoice_payment_intents enable row level security;

drop policy if exists "invoice_payment_intents: members can select" on public.invoice_payment_intents;
create policy "invoice_payment_intents: members can select" on public.invoice_payment_intents
  for select to authenticated using (org_id in (select public.current_org_ids()));

-- anon has no surface at all; authenticated gets read-only (no write policy).
revoke all on table public.invoice_payment_intents from anon;
