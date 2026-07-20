-- WhatsApp AI Assistant (Milestone Ring 1) — inbound webhook replay/claim ledger.
--
-- Meta delivers each WhatsApp event AT-LEAST-ONCE and retries on any non-2xx, so
-- the webhook must be idempotent and concurrency-safe. This is the ingress claim
-- table, mirroring the billing_events / automation_runs claim protocol
-- (20260607 + the #353/#355 claim-before-act corrections) VERBATIM:
--
--   - `event_key` is UNIQUE — 'msg:<wamid>' for a message, 'status:<wamid>:<st>'
--     for a delivery/read status. A re-delivery collides here.
--   - The handler INSERTs (the atomic claim), and a concurrent/retry loser
--     reclaims ONLY a row that is `processed_at IS NULL` AND (failed OR its
--     `claimed_at` lease has expired). `processed_at` — never row existence — is
--     the sole proof of completion, so a crash mid-dispatch stays retryable
--     rather than being permanently swallowed (the #350/#355 lesson).
--   - Service-role only: RLS enabled, ZERO policies — same posture as
--     billing_events and the receptionist_* substrate. No tenant ever reads or
--     writes ingress rows; the org is resolved downstream by routing lookup.
--
-- Additive and dark: nothing reads this table until the Meta webhook route ships
-- behind NEXT_PUBLIC_FEATURE_WHATSAPP (default OFF).

create table if not exists public.whatsapp_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  -- Idempotency identity. UNIQUE so a re-delivery of the same message OR the same
  -- (message,status) transition collides and is claimed exactly once.
  event_key         text not null unique,
  kind              text not null check (kind in ('message', 'status')),
  -- Meta's message id (wamid.*) — the stable per-message identifier.
  wamid             text not null,
  -- For kind='status' only: sent | delivered | read | failed.
  status            text,
  -- Meta's phone_number_id — the routing key to an org (whatsapp_number_routes).
  phone_number_id   text,
  -- Resolved org, nullable: an unrouted number is ack-dropped, not rejected.
  org_id            uuid references public.organizations(id) on delete set null,
  payload           jsonb not null,
  -- The ONLY proof of completion. NULL = claimed but not finished = retryable.
  processed_at      timestamp with time zone,
  error_message     text,
  -- Lease clock: a 'claimed but unprocessed' row older than the handler's lease
  -- is orphaned and may be reclaimed by exactly one caller.
  claimed_at        timestamp with time zone,
  created_at        timestamp with time zone not null default now()
);

comment on column public.whatsapp_webhook_events.processed_at is
  'Sole proof of completion. Row existence is NOT proof — a crash mid-dispatch '
  'leaves this NULL so the retry re-runs, never silently drops (the #350/#355 rule).';
comment on column public.whatsapp_webhook_events.claimed_at is
  'In-flight lease clock. A processed_at-NULL row older than the handler lease is '
  'orphaned and reclaimable by exactly one caller.';

-- Operator lookups for stuck/in-flight ingress; excludes the completed majority.
create index if not exists whatsapp_webhook_events_inflight_idx
  on public.whatsapp_webhook_events (claimed_at)
  where processed_at is null;
create index if not exists whatsapp_webhook_events_org_idx
  on public.whatsapp_webhook_events (org_id, created_at desc);

alter table public.whatsapp_webhook_events enable row level security;
-- No policies: service-role / SECURITY DEFINER only, exactly like billing_events.
