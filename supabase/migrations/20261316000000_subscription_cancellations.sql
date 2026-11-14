-- Self-serve subscription cancellation — the CANCELLATION LEDGER.
--
-- WHAT THIS IS. One row per cancellation of an org's CrewFlow (SaaS)
-- subscription. It does three jobs that the existing schema cannot:
--
--   1. CLAIM. The owner-initiated cancel action inserts/updates a row to
--      `requested` BEFORE it calls Stripe. Two owners (or one double-click)
--      racing each other serialise on the org row lock inside
--      claim_subscription_cancellation() (next migration): exactly one caller
--      gets the claim, the other is told a cancellation is already in flight.
--
--   2. TOMBSTONE. Once a Stripe subscription id is `confirmed` cancelled it can
--      never grant access again. Stripe treats `canceled` as terminal, but
--      webhooks are delivered at-least-once and OUT OF ORDER: a
--      `customer.subscription.updated` (status active) created seconds before
--      the cancel can arrive minutes after it. Without a tombstone the webhook
--      handler flipped organizations.status back to 'active' — a cancelled
--      customer with free access forever. apply_stripe_subscription_state()
--      (next migration) refuses to apply a non-terminal status for a tombstoned
--      subscription id.
--
--   3. EXACTLY-ONCE REVOCATION. confirm_subscription_cancellation() (next
--      migration) flips organizations.status to 'cancelled' only on the FIRST
--      confirmation of a given subscription id, whichever of the server action
--      and the `customer.subscription.deleted` webhook gets there first. The
--      loser is a no-op, so HQ is notified once and the owner is emailed once.
--
-- A row with stripe_subscription_id NULL is a LOCAL-ONLY cancellation: the org
-- had no Stripe subscription at all (a founder-provisioned trial / manually
-- billed workspace). Those are not tombstones — an org can be reactivated and
-- cancel again — so uniqueness is enforced only for real subscription ids.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
-- It stores no money and moves no money. `refund_review` records that a refund
-- REVIEW is owed under the published terms ("Refunds are issued for unused
-- prepaid time when you cancel; pro-rata") — the refund itself is a human act
-- in Stripe. `details` holds the Stripe period bounds and a pro-rata ESTIMATE
-- for HQ; it is never shown to the customer and never used to charge or refund.
--
-- ── TENANT ISOLATION / ACCESS ───────────────────────────────────────────────
-- SERVICE-ROLE ONLY. RLS is enabled with NO policy, and every client grant is
-- revoked, so anon/authenticated cannot read or write it through the Data API.
-- The owner-facing surface reads it server-side through the admin client AFTER
-- deriving the org from the caller's own session + membership.
-- data-api:exempt:subscription_cancellations — deliberately service-role-only.
--
-- requested_by is a plain uuid (no FK): the ledger must survive the deletion of
-- the user who cancelled. requested_by_email + reason are the only PII columns;
-- both match the GDPR anonymise column pattern, and the table is classified
-- `erasure_anonymise` in lib/gdpr/org-tables.json (row kept, PII scrubbed).
--
-- Additive and reversible. To roll back (after reverting the application code):
--   drop table public.subscription_cancellations;

create table if not exists public.subscription_cancellations (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references public.organizations(id) on delete cascade,
  -- The Stripe subscription this cancellation terminates. NULL = local-only
  -- (the org had no Stripe subscription).
  stripe_subscription_id text,
  -- requested → the claim is held and the Stripe call is (or was) in flight.
  -- confirmed → Stripe confirmed termination (or there was nothing in Stripe).
  -- failed    → the Stripe call failed; nothing changed; retryable.
  state                  text not null default 'requested'
                           check (state in ('requested', 'confirmed', 'failed')),
  -- Who initiated it: the org owner in-app, or Stripe (dashboard cancel /
  -- dunning exhausted) observed through the webhook.
  source                 text not null
                           check (source in ('owner', 'stripe_webhook')),
  requested_by           uuid,
  requested_by_email     text,
  -- Optional free-text reason the owner chose to give. Never required.
  reason                 text check (reason is null or length(reason) <= 1000),
  -- organizations.status immediately before access was revoked.
  prior_org_status       text,
  -- Lease stamp for an in-flight claim (see claim_subscription_cancellation).
  claimed_at             timestamptz,
  confirmed_at           timestamptz,
  confirmed_via          text
                           check (confirmed_via is null or confirmed_via in ('action', 'webhook')),
  -- True when THIS confirmation is the one that flipped the org to 'cancelled'.
  access_revoked         boolean not null default false,
  -- A refund REVIEW is owed under the terms (pending) / done (resolved) / n.a.
  refund_review          text not null default 'not_applicable'
                           check (refund_review in ('not_applicable', 'pending', 'resolved')),
  details                jsonb not null default '{}'::jsonb,
  last_error             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- A real Stripe subscription id is tombstoned at most once per org. Partial:
-- local-only rows (NULL id) may repeat across reactivate → cancel cycles.
create unique index if not exists subscription_cancellations_org_sub_uniq
  on public.subscription_cancellations (org_id, stripe_subscription_id)
  where stripe_subscription_id is not null;

create index if not exists subscription_cancellations_org_idx
  on public.subscription_cancellations (org_id, created_at desc);

drop trigger if exists subscription_cancellations_set_updated_at on public.subscription_cancellations;
create trigger subscription_cancellations_set_updated_at
  before update on public.subscription_cancellations
  for each row execute function public.tg_set_updated_at();

-- Service-role only: RLS on, no policy, no client grant.
alter table public.subscription_cancellations enable row level security;
revoke all on table public.subscription_cancellations from public, anon, authenticated;
grant all on table public.subscription_cancellations to service_role;
