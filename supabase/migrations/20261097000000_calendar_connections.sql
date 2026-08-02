-- Calendar connections — the OAuth CONNECTION substrate for the "connect your
-- Google Calendar / Microsoft 365 calendar" integration (jobs + rota → calendar).
--
-- WHAT THIS IS. One row per (org, provider) recording whether a tenant has
-- connected their calendar account, and — once the connection is live — the
-- provider handle (`external_account_id`) and the OAuth tokens used to push to
-- it. A sibling table (`calendar_event_links`) records the bidirectional mapping
-- between a CrewFlow entity (a job or a rota entry) and the external calendar
-- event it was projected into, so a re-push updates the same event rather than
-- duplicating it. This is the DB half of "connect your calendar": the composer
-- (server/services/calendar-connections.ts) knows HOW to map a job/rota entry to
-- an event; these tables record WHICH account each org is bound to and WHICH
-- external event each local entity maps to.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No token is ever written by this build. The OAuth exchange
-- (lib/integrations/calendar/oauth.ts) REFUSES when the provider client
-- credentials are absent from the environment — which is ALWAYS, today — so no
-- code path reaches a `connected` row or a populated token column. A row exists
-- only after a real OAuth exchange, and that exchange is unreachable without
-- client credentials AND the FEATURE_CALENDAR_CONNECT flag. Until activation,
-- every column below except org_id / provider / status('disconnected') stays null.
--
-- ── CALENDAR-ONLY SCOPES ────────────────────────────────────────────────────
-- The activation credentials (below) are for a calendar-only OAuth client:
-- Google `https://www.googleapis.com/auth/calendar.events`, Microsoft
-- `Calendars.ReadWrite offline_access`. NO mail scopes are requested anywhere.
-- The Microsoft client is a SEPARATE app from the auth-only Azure SSO
-- (NEXT_PUBLIC_FEATURE_MICROSOFT_SSO) — a Graph calendar token, not a sign-in token.
--
-- ── TOKENS AT REST ──────────────────────────────────────────────────────────
-- access_token / refresh_token are secrets. They are NULL today (dark) and MUST
-- NOT be stored as plaintext when the integration is activated: the activation
-- step encrypts them application-side (envelope encryption with a KMS/Vault data
-- key, or pgsodium) BEFORE they reach these columns, exactly as the accounting
-- connection wave (20261095) documents. This migration only carves the slots; it
-- deliberately writes nothing, so there is no plaintext secret in the schema and
-- none can arrive dark.
--
-- ACTIVATION REQUIREMENT (BLOCKING, not yet satisfied). There is no
-- key-management utility in this repo today, so app-side token encryption is a
-- documented ACTIVATION gate, not a shipped capability. Before the callback
-- write (app/api/integrations/calendar/[provider]/callback/route.ts) is switched
-- live, a key-management decision (KMS/Vault vs pgsodium, key rotation, who holds
-- the data key) MUST be made and the exchange path MUST encrypt tokens
-- application-side before they reach access_token / refresh_token. Additionally,
-- the OAuth redirect_uri (derived per-request from the request origin in oauth.ts
-- today) MUST be origin-pinned to a trusted, allow-listed host at activation so a
-- spoofed Host/forwarded origin cannot redirect the code elsewhere. Neither is
-- reachable dark (no token is written while the exchange refuses without
-- credentials), but both are prerequisites for going live.
--
-- ── TOKEN COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ───────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read access_token / refresh_token /
-- token_expires_at back over PostgREST. Those columns are stripped from the
-- authenticated (and anon) read surface by a COLUMN-LEVEL privilege at the foot
-- of this migration (the accounting_connections / api_keys.key_hash idiom): only
-- service_role can read them; members still read status / provider / handle.
--
-- ── CANNOT BE "CONNECTED" WITHOUT AN ACCOUNT ────────────────────────────────
-- A CHECK forbids status='connected' unless a provider handle
-- (external_account_id) is present. There is no way to fake a connected state —
-- the DB refuses a connected row that names no account.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the accounting_connections posture)
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may READ
-- the connection state so the team sees whether the calendar is wired up; only an
-- admin may WRITE, because connecting/disconnecting a calendar provider is an
-- admin act. DB-enforced, not app-only.
--
-- ── EVENT LINKS ARE ORG-BOUND VIA A COMPOSITE FK ────────────────────────────
-- calendar_event_links carries its OWN org_id AND a COMPOSITE foreign key to
-- calendar_connections(id, org_id). Postgres therefore refuses any event link
-- whose org_id does not match the org of its connection — an event link can NEVER
-- be written under the wrong org, even by a bug in the writer. This is the same
-- composite-FK org-binding idiom used by the finances children.
--
-- Additive and reversible. To roll back:
--   drop table public.calendar_event_links;
--   drop table public.calendar_connections;

-- ── calendar_connections ─────────────────────────────────────────────────────
create table if not exists public.calendar_connections (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  -- The calendar provider this row binds the org to.
  provider            text not null check (provider in ('google', 'microsoft')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no account bound (the only state reachable dark). Default.
  --   connecting   — an OAuth authorize redirect is in flight (state issued).
  --   connected    — a live account is bound (requires a provider handle below).
  --   error        — the last connect/refresh failed; see last_error.
  status              text not null default 'disconnected'
                        check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- Provider account handle. Google returns an account email / resourceName;
  -- Microsoft a Graph user/principal id. Nullable: absent until a real OAuth
  -- exchange resolves the account.
  external_account_id text,
  -- OAuth tokens. NULL today (dark) and encrypted application-side before write
  -- once activated (see the "TOKENS AT REST" note above). Never populated without
  -- a real token exchange, which is unreachable without client creds + the flag.
  access_token        text,
  refresh_token       text,
  token_expires_at    timestamptz,
  -- Provenance + operational metadata.
  connected_by        uuid references public.users(id) on delete set null,
  connected_at        timestamptz,
  last_sync_at        timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One connection per provider per org. Re-connecting upserts this row.
  constraint calendar_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for calendar_event_links (org-binding idiom).
  constraint calendar_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a provider account handle. There is no fake
  -- connected state: a connected row must name a calendar account.
  constraint calendar_connections_connected_needs_handle check (
    status <> 'connected'
    or external_account_id is not null
  )
);

create index if not exists calendar_connections_org_idx
  on public.calendar_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists calendar_connections_set_updated_at on public.calendar_connections;
create trigger calendar_connections_set_updated_at before update on public.calendar_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
alter table public.calendar_connections enable row level security;

drop policy if exists "calendar_connections: members can select" on public.calendar_connections;
create policy "calendar_connections: members can select" on public.calendar_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "calendar_connections: admins can insert" on public.calendar_connections;
create policy "calendar_connections: admins can insert" on public.calendar_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "calendar_connections: admins can update" on public.calendar_connections;
create policy "calendar_connections: admins can update" on public.calendar_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "calendar_connections: admins can delete" on public.calendar_connections;
create policy "calendar_connections: admins can delete" on public.calendar_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── calendar_event_links ─────────────────────────────────────────────────────
-- The bidirectional mapping between a CrewFlow entity (a job or a rota entry) and
-- the external calendar event it was projected into. Carries its own org_id AND a
-- COMPOSITE FK to calendar_connections(id, org_id) so an event link can NEVER be
-- written under the wrong org. `local_kind` + `local_id` name the CrewFlow side;
-- `external_event_id` + `etag` name the provider side (etag drives conflict-safe
-- updates once two-way sync ships — a documented follow-up, NOT built here).
create table if not exists public.calendar_event_links (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  connection_id     uuid not null,
  -- The CrewFlow entity this event maps. 'job' → public.jobs.id;
  -- 'rota' → public.rota_entries.id. Kept as (kind,id) rather than two FK columns
  -- so one table spans both entity types.
  local_kind        text not null check (local_kind in ('job', 'rota')),
  local_id          uuid not null,
  -- The provider-side event handle + concurrency token.
  external_event_id text not null,
  etag              text,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- ORG-BINDING: the connection must belong to the SAME org as this link. The
  -- composite FK makes a cross-org event link structurally impossible.
  constraint calendar_event_links_connection_fk
    foreign key (connection_id, org_id)
    references public.calendar_connections (id, org_id) on delete cascade,
  -- One event link per (connection, local entity): a re-push updates, never
  -- duplicates.
  constraint calendar_event_links_conn_local_uniq
    unique (connection_id, local_kind, local_id)
);

create index if not exists calendar_event_links_org_idx
  on public.calendar_event_links (org_id);
create index if not exists calendar_event_links_local_idx
  on public.calendar_event_links (org_id, local_kind, local_id);
create index if not exists calendar_event_links_connection_idx
  on public.calendar_event_links (connection_id);

drop trigger if exists calendar_event_links_set_updated_at on public.calendar_event_links;
create trigger calendar_event_links_set_updated_at before update on public.calendar_event_links
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins (or service) write ────────────────────────────
-- Members may READ their org's event links; only admins may write. In practice
-- the composer writes under the caller's JWT (admin) or, at activation, under a
-- service role for background sync; either way the write is org-bound by the
-- composite FK above.
alter table public.calendar_event_links enable row level security;

drop policy if exists "calendar_event_links: members can select" on public.calendar_event_links;
create policy "calendar_event_links: members can select" on public.calendar_event_links
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "calendar_event_links: admins can insert" on public.calendar_event_links;
create policy "calendar_event_links: admins can insert" on public.calendar_event_links
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "calendar_event_links: admins can update" on public.calendar_event_links;
create policy "calendar_event_links: admins can update" on public.calendar_event_links
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "calendar_event_links: admins can delete" on public.calendar_event_links;
create policy "calendar_event_links: admins can delete" on public.calendar_event_links
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the token-column readback exclusion ──────────────
-- RLS is ROW-level: the member-read SELECT policy above authorises the ROW, not
-- the columns, so a member could `select=access_token,refresh_token,...` over
-- PostgREST and read the tokens back. Those are secrets. Exclude them from the
-- authenticated / anon read surface with a COLUMN privilege — the exact idiom
-- used for accounting_connections (20261095), api_keys.key_hash (20261086) and
-- the outbound_webhooks signing secret (20261087).
--
-- MECHANISM. Supabase's default privileges grant table-WIDE SELECT on new public
-- tables to anon + authenticated, and a bare column-level REVOKE has NO effect
-- while that table-wide grant stands. So we REVOKE the table-level SELECT and
-- GRANT SELECT back on exactly the non-token columns. Adding a new column does
-- NOT expose it — it must be named in the grant below. Only SELECT is rebuilt:
-- INSERT / UPDATE / DELETE keep their default grants so the admin-write RLS
-- policies remain the authority for writes. Idempotent — REVOKE of an absent
-- privilege and a repeated GRANT are both no-ops, so `supabase db reset` replays
-- cleanly.

-- anon: no surface on either table at all.
revoke all on table public.calendar_connections from anon;
revoke all on table public.calendar_event_links from anon;

-- authenticated: drop table-wide SELECT on calendar_connections, then grant
-- SELECT on every column EXCEPT access_token / refresh_token / token_expires_at.
-- service_role keeps its default full grants and stays the ONLY reader of the
-- token columns (at activation).
revoke select on table public.calendar_connections from authenticated;
grant select (
  id, org_id, provider, status, external_account_id,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.calendar_connections to authenticated;

-- calendar_event_links carries no secret; keep its default authenticated SELECT
-- (member-read RLS is the boundary). Only anon is stripped above.
