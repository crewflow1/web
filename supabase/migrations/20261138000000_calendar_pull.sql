-- Calendar two-way sync — the PULL substrate (inbound events + provider webhook
-- watch channels). This is the DB half of the deferred follow-up documented in
-- server/services/calendar-connections.ts (the push side shipped in 20261097).
--
-- WHAT THIS IS. Two additive, org-scoped tables that back the INBOUND direction
-- of calendar sync:
--   • calendar_watch_channels — one row per (org, connection) recording a
--     provider push-notification channel (Google events.watch / Microsoft
--     subscription): its provider handle, the verification secret we set at
--     registration (so an inbound notification can be authenticated), the
--     incremental-sync cursor, and the channel expiry.
--   • calendar_pulled_events — the internal representation of events fetched FROM
--     the provider (events.list / calendarView) so scheduling has awareness of
--     external commitments, with a `is_crewflow_origin` flag so events CrewFlow
--     itself pushed are never re-imported (dedup).
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- Nothing is ever written here while the integration is dark. The pull composer
-- (server/services/calendar-pull.ts) refuses before any provider fetch when the
-- provider is not connectable (no client credentials + FEATURE_CALENDAR_CONNECT),
-- and the webhook receiver refuses the same way. A watch channel row exists only
-- after a real, credential-gated registration; a pulled-event row only after a
-- real, credential-gated pull. Until activation both tables stay empty.
--
-- ── THE VERIFICATION TOKEN IS A SECRET (service-role-only on read) ───────────
-- calendar_watch_channels.verification_token is the shared secret an inbound
-- provider notification is checked against (Google channel token / Microsoft
-- clientState). Like the OAuth token columns on calendar_connections (20261097),
-- it is encrypted application-side before write AND stripped from the
-- authenticated read surface by a COLUMN-LEVEL privilege at the foot of this
-- migration — only service_role can read it. RLS is row-level, not column-level,
-- so the column privilege is what actually protects the secret from a member
-- `select=verification_token` over PostgREST.
--
-- ── ORG-BOUND VIA A COMPOSITE FK ────────────────────────────────────────────
-- Both tables carry their OWN org_id AND a COMPOSITE foreign key to
-- calendar_connections(id, org_id) (the candidate key calendar_connections_id_org_key
-- from 20261097), so Postgres refuses any row whose org_id does not match the org
-- of its connection — a cross-org watch channel or pulled event is structurally
-- impossible, exactly as calendar_event_links is bound.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the calendar_connections posture) ─
-- Org-pinned; every member may READ so the team sees sync state; only an admin
-- (or, at activation, the service role for background sync) may WRITE. DB-enforced.
--
-- Additive and reversible. To roll back:
--   drop table public.calendar_pulled_events;
--   drop table public.calendar_watch_channels;

-- ── calendar_watch_channels ──────────────────────────────────────────────────
create table if not exists public.calendar_watch_channels (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  connection_id       uuid not null,
  provider            text not null check (provider in ('google', 'microsoft')),
  -- The provider-side channel handle. Google: the channel id we mint at watch()
  -- registration; Microsoft: the subscription id Graph returns. Unique globally
  -- so an unauthenticated inbound notification resolves to exactly one row.
  channel_id          text not null,
  -- Google returns a resourceId required to STOP the channel; Microsoft has none.
  resource_id         text,
  -- The verification secret we set at registration (Google channel `token` /
  -- Microsoft `clientState`). A SECRET: encrypted application-side before write,
  -- and stripped from the authenticated read surface below. Null only until the
  -- (credential-gated) registration writes it.
  verification_token  text,
  -- Incremental-sync cursor (Google nextSyncToken). Null for a full-window pull
  -- or a provider (Microsoft calendarView) that has no snapshot sync token.
  sync_token          text,
  -- CHANNEL LIFECYCLE.
  --   inactive — no live channel (the only state reachable dark). Default.
  --   active   — a live provider channel is registered.
  --   expired  — the channel passed its expiry and needs re-registration.
  --   error    — the last registration / notification handling failed.
  status              text not null default 'inactive'
                        check (status in ('inactive', 'active', 'expired', 'error')),
  expiration          timestamptz,
  last_notified_at    timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One watch channel per connection (a re-register upserts this row).
  constraint calendar_watch_channels_connection_uniq unique (connection_id),
  -- The channel id is the unauthenticated inbound lookup key — globally unique.
  constraint calendar_watch_channels_channel_uniq unique (channel_id),
  -- ORG-BINDING: the connection must belong to the SAME org as this channel.
  constraint calendar_watch_channels_connection_fk
    foreign key (connection_id, org_id)
    references public.calendar_connections (id, org_id) on delete cascade
);

create index if not exists calendar_watch_channels_org_idx
  on public.calendar_watch_channels (org_id);
create index if not exists calendar_watch_channels_connection_idx
  on public.calendar_watch_channels (connection_id);

drop trigger if exists calendar_watch_channels_set_updated_at on public.calendar_watch_channels;
create trigger calendar_watch_channels_set_updated_at before update on public.calendar_watch_channels
  for each row execute function public.tg_set_updated_at();

alter table public.calendar_watch_channels enable row level security;

drop policy if exists "calendar_watch_channels: members can select" on public.calendar_watch_channels;
create policy "calendar_watch_channels: members can select" on public.calendar_watch_channels
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "calendar_watch_channels: admins can insert" on public.calendar_watch_channels;
create policy "calendar_watch_channels: admins can insert" on public.calendar_watch_channels
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "calendar_watch_channels: admins can update" on public.calendar_watch_channels;
create policy "calendar_watch_channels: admins can update" on public.calendar_watch_channels
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "calendar_watch_channels: admins can delete" on public.calendar_watch_channels;
create policy "calendar_watch_channels: admins can delete" on public.calendar_watch_channels
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── calendar_pulled_events ───────────────────────────────────────────────────
-- The internal representation of events fetched FROM the provider. Normalised,
-- deterministic, org- and connection-bound. `is_crewflow_origin` marks an event
-- CrewFlow itself pushed (matched on the stored external event id or the CrewFlow
-- marker in its body) so scheduling never treats our own pushed jobs as external
-- commitments (dedup). `is_busy` mirrors provider transparency/showAs for
-- free-busy scheduling awareness.
create table if not exists public.calendar_pulled_events (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  connection_id       uuid not null,
  -- The provider-side event handle (Google event id / Microsoft event id).
  external_event_id   text not null,
  -- Provider stable cross-instance id (Google iCalUID / Microsoft iCalUId), if any.
  ical_uid            text,
  summary             text,
  location            text,
  -- Normalised absolute instants (UTC). Null for an all-day / date-only bound.
  starts_at           timestamptz,
  ends_at             timestamptz,
  is_all_day          boolean not null default false,
  -- Provider status: confirmed | tentative | cancelled (best-effort passthrough).
  status              text,
  -- Does this event BLOCK time? (Google transparency / Microsoft showAs.) Drives
  -- free-busy scheduling awareness.
  is_busy             boolean not null default true,
  -- DEDUP: true when this external event is one CrewFlow pushed (matched on the
  -- stored external event id in calendar_event_links, or the CrewFlow marker in
  -- its body). Scheduling ignores these so a pushed job is never double-counted.
  is_crewflow_origin  boolean not null default false,
  etag                text,
  -- Provider last-modified instant, for change detection across pulls.
  provider_updated_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One row per (connection, external event): a re-pull UPDATES, never duplicates.
  constraint calendar_pulled_events_conn_event_uniq
    unique (connection_id, external_event_id),
  -- ORG-BINDING: the connection must belong to the SAME org as this event.
  constraint calendar_pulled_events_connection_fk
    foreign key (connection_id, org_id)
    references public.calendar_connections (id, org_id) on delete cascade
);

create index if not exists calendar_pulled_events_org_idx
  on public.calendar_pulled_events (org_id);
create index if not exists calendar_pulled_events_connection_idx
  on public.calendar_pulled_events (connection_id);
-- Scheduling reads the window of busy, non-CrewFlow events for an org.
create index if not exists calendar_pulled_events_window_idx
  on public.calendar_pulled_events (org_id, starts_at, ends_at);

drop trigger if exists calendar_pulled_events_set_updated_at on public.calendar_pulled_events;
create trigger calendar_pulled_events_set_updated_at before update on public.calendar_pulled_events
  for each row execute function public.tg_set_updated_at();

alter table public.calendar_pulled_events enable row level security;

drop policy if exists "calendar_pulled_events: members can select" on public.calendar_pulled_events;
create policy "calendar_pulled_events: members can select" on public.calendar_pulled_events
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "calendar_pulled_events: admins can insert" on public.calendar_pulled_events;
create policy "calendar_pulled_events: admins can insert" on public.calendar_pulled_events
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "calendar_pulled_events: admins can update" on public.calendar_pulled_events;
create policy "calendar_pulled_events: admins can update" on public.calendar_pulled_events
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "calendar_pulled_events: admins can delete" on public.calendar_pulled_events;
create policy "calendar_pulled_events: admins can delete" on public.calendar_pulled_events
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the verification-token readback exclusion ────────
-- RLS is ROW-level, so the member-read policy above would otherwise let a member
-- `select=verification_token` over PostgREST. That is a secret (it authenticates
-- inbound provider notifications). Exclude it from the authenticated / anon read
-- surface with a COLUMN privilege — the exact idiom used for the calendar_connections
-- token columns (20261097) and accounting_connections (20261095). Adding a new
-- column does NOT expose it: it must be named in the grant below. Only SELECT is
-- rebuilt; INSERT / UPDATE / DELETE keep their default grants so the admin-write
-- RLS policies remain the write authority. Idempotent (replays cleanly on reset).

-- anon: no surface on either table at all.
revoke all on table public.calendar_watch_channels from anon;
revoke all on table public.calendar_pulled_events from anon;

-- authenticated: drop table-wide SELECT on calendar_watch_channels, then grant
-- SELECT on every column EXCEPT verification_token. service_role keeps its default
-- full grants and stays the ONLY reader of the secret (at activation).
revoke select on table public.calendar_watch_channels from authenticated;
grant select (
  id, org_id, connection_id, provider, channel_id, resource_id, sync_token,
  status, expiration, last_notified_at, last_synced_at, last_error,
  created_at, updated_at
) on public.calendar_watch_channels to authenticated;

-- calendar_pulled_events carries no secret; keep its default authenticated SELECT
-- (member-read RLS is the boundary). Only anon is stripped above.
