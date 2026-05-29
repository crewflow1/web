-- ============================================================================
-- demo_requests — Stripe Checkout linkage for the setup-fee payment.
--
-- Launch-blocker fix (CEO directive 2026-05-29):
--   "Send setup payment" must generate/retrieve a real Stripe Checkout link
--   and the email must carry it so the customer can pay immediately with NO
--   manual intervention. Once paid, the Stripe webhook moves the demo to
--   payment_received automatically.
--
-- These columns let us:
--   1. Persist the Checkout Session so a re-send REUSES the still-open link
--      instead of spawning a fresh one every click (idempotent UX).
--   2. Let the webhook (checkout.session.completed) find the demo by id and
--      flip stripe_payment_status -> 'paid' + stamp setup_fee_paid_at.
--   3. Render the payment state on the HQ demo board / detail panel.
--
-- All additive + idempotent.
-- ============================================================================

alter table public.demo_requests
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_checkout_url        text,
  add column if not exists stripe_payment_status      text
    check (stripe_payment_status in ('pending', 'paid', 'expired'))
    default null,
  add column if not exists setup_fee_paid_at          timestamp with time zone;

-- Webhook looks the demo up by session id when the event fires.
create index if not exists demo_requests_stripe_session_idx
  on public.demo_requests (stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
