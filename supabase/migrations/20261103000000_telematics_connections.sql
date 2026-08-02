-- Telematics connections — the GPS / TELEMATICS CONNECTION substrate for the
-- Fleet "vehicle location + odometer feed" integration.
--
-- WHAT THIS IS. One row per (org, provider) recording whether a tenant has
-- connected their telematics account through a fleet-telematics aggregator
-- (Samsara / Verizon Connect) and — once live — the non-secret connection handle
-- (the provider account id) plus the OAuth tokens used to pull vehicle
-- location/odometer feeds. It is the DB half of "connect your telematics
-- account": a live feed would map fetched readings by
-- lib/integrations/telematics/reading-map.ts ONTO the append-only
-- `telematics_readings` table below, keyed to the EXISTING `fleet_vehicles`
-- register (20261056), so activation feeds a screen that already knows the
-- vehicles — this table only records WHICH telematics account each org is bound
-- to. It clones the bank_connections posture (20261100) exactly.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No token is ever written by this build. The OAuth exchange
-- (lib/integrations/telematics/oauth.ts) REFUSES when the aggregator client
-- credentials are absent / the flag is off / no TELEMATICS_PROVIDER is bound —
-- which is ALWAYS, today — so no code path reaches a `connected` row or a
-- populated token column. A row exists only after a real OAuth exchange, and that
-- exchange is unreachable without credentials. Until activation every column
-- below except org_id / provider / status('disconnected') stays null.
--
-- ── ACTIVATION (config + a CEO provider choice, not engineering) ─────────────
-- Go-live requires ALL of: (1) a telematics provider ACCOUNT + OAuth client
-- credentials (TELEMATICS_CLIENT_ID / TELEMATICS_CLIENT_SECRET), (2) a bound
-- TELEMATICS_PROVIDER naming which aggregator this deployment uses — a CEO /
-- product decision, not this train's to make, and (3) the feature flag
-- NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT="true". Plus INTEGRATION_TOKEN_ENCRYPTION_KEY
-- (shared) so tokens are encrypted at rest. No code change reaches the live path.
--
-- ── TOKENS AT REST ──────────────────────────────────────────────────────────
-- access_token / refresh_token are secrets. They are NULL today (dark) and are
-- AES-256-GCM encrypted application-side (lib/integrations/token-crypto.ts) BEFORE
-- they reach these columns once activated — the callback encrypts before the DB
-- write, exactly as the accounting/banking substrates do. This migration only
-- carves the slots; it deliberately writes nothing, so there is no plaintext
-- secret in the schema and none can arrive dark.
--
-- ── TOKEN COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ───────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read access_token / refresh_token /
-- token_expires_at back over PostgREST. Those columns are stripped from the
-- authenticated (and anon) read surface by a COLUMN-LEVEL privilege at the foot
-- of this migration (the api_keys.key_hash / accounting_connections /
-- bank_connections idiom): only service_role can read them; members still read
-- status / provider / handle.
--
-- ── CANNOT BE "CONNECTED" WITHOUT AN ACCOUNT ────────────────────────────────
-- A CHECK forbids status='connected' unless a connection handle
-- (external_account_id) is present. There is no way to fake a connected state —
-- the DB refuses a connected row that names no telematics account.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the bank_connections posture) ───
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may READ
-- the connection state so the team sees whether the telematics feed is wired up;
-- only an admin may WRITE, because connecting/disconnecting a telematics account
-- is an admin act. DB-enforced, not app-only.
--
-- Additive and reversible. To roll back:
--   drop table public.telematics_readings;
--   drop table public.telematics_connections;
--   alter table public.fleet_vehicles drop constraint if exists fleet_vehicles_asset_org_key;
-- (Dropping fleet_vehicles_asset_org_key is safe only once no other table references it.)

-- ── composite-FK target on fleet_vehicles ─────────────────────────────────────
-- `fleet_vehicles` has PK (asset_id) and no (asset_id, org_id) candidate key, so a
-- cross-tenant-safe composite FK from telematics_readings is not yet expressible.
-- Add it — the assets_id_org_key precedent (20261056), and for the same reason: a
-- DECLARATIVE composite FK is enforced for EVERY role including service_role,
-- needs no procedural code, and cannot be bypassed by a direct PostgREST write. A
-- forged vehicle_id from another tenant simply has no matching (asset_id, org_id)
-- row, so a reading can never point at a vehicle belonging to a different org —
-- regardless of what the app (or a live feed) sends. Wrapped so re-runs are no-ops.
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'fleet_vehicles_asset_org_key'
  ) then
    alter table public.fleet_vehicles add constraint fleet_vehicles_asset_org_key unique (asset_id, org_id);
  end if;
end $$;

-- ── telematics_connections ────────────────────────────────────────────────────
create table if not exists public.telematics_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The telematics aggregator this row binds the org to. A small, closed set.
  provider           text not null check (provider in ('samsara', 'verizon_connect')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no account bound (the only state reachable dark). Default.
  --   connecting   — an OAuth authorize redirect is in flight (state issued).
  --   connected    — a live account is bound (requires a connection handle below).
  --   error        — the last connect/refresh failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- NON-SECRET connection handle — member-readable. The telematics provider
  -- account id (Samsara org id / Verizon Connect account id). Nullable: absent
  -- until a real exchange resolves the account. Carries NO credential.
  external_account_id text,
  -- OAuth tokens. NULL today (dark) and encrypted application-side before write
  -- once activated (see "TOKENS AT REST"). Never populated without a real token
  -- exchange, which is unreachable without aggregator credentials.
  access_token       text,
  refresh_token      text,
  token_expires_at   timestamptz,
  -- Provenance + operational metadata.
  connected_by       uuid references public.users(id) on delete set null,
  connected_at       timestamptz,
  last_sync_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One connection per provider per org. Re-connecting upserts this row.
  constraint telematics_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for any child (telematics_readings below).
  constraint telematics_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a connection handle. There is no fake connected
  -- state: a connected row must name a telematics account.
  constraint telematics_connections_connected_needs_handle check (
    status <> 'connected'
    or external_account_id is not null
  )
);

create index if not exists telematics_connections_org_idx
  on public.telematics_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists telematics_connections_set_updated_at on public.telematics_connections;
create trigger telematics_connections_set_updated_at before update on public.telematics_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
-- The bank_connections posture: every member may READ whether the telematics feed
-- is connected; only an admin may INSERT/UPDATE/DELETE, because binding or
-- removing a telematics account is an admin act. DB-enforced so /rest/v1 is not
-- open to any member holding a JWT.
alter table public.telematics_connections enable row level security;

drop policy if exists "telematics_connections: members can select" on public.telematics_connections;
create policy "telematics_connections: members can select" on public.telematics_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "telematics_connections: admins can insert" on public.telematics_connections;
create policy "telematics_connections: admins can insert" on public.telematics_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "telematics_connections: admins can update" on public.telematics_connections;
create policy "telematics_connections: admins can update" on public.telematics_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "telematics_connections: admins can delete" on public.telematics_connections;
create policy "telematics_connections: admins can delete" on public.telematics_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the token-column readback exclusion ──────────────
-- RLS is ROW-level: the member-read SELECT policy above authorises the ROW, not
-- the columns, so a member could `select=access_token,refresh_token,...` over
-- PostgREST and read the tokens back. Those are secrets. Exclude them from the
-- authenticated / anon read surface with a COLUMN privilege — the exact idiom
-- used for bank_connections (20261100), accounting_connections (20261095),
-- api_keys.key_hash (20261086) and the outbound_webhooks signing secret (20261087).
--
-- MECHANISM. Supabase's default privileges grant table-WIDE SELECT on new public
-- tables to anon + authenticated, and a bare column-level REVOKE has NO effect
-- while that table-wide grant stands. So we REVOKE the table-level SELECT and
-- GRANT SELECT back on exactly the non-token columns. Adding a new column does
-- NOT expose it — it must be named in the grant below. Only SELECT is rebuilt:
-- INSERT / UPDATE / DELETE keep their default grants so the admin-write RLS
-- policies remain the authority for writes (writing a token is fine; READING it
-- back is what is forbidden). Idempotent — replays cleanly under `supabase db reset`.

-- anon: no surface on this table at all.
revoke all on table public.telematics_connections from anon;

-- authenticated: drop table-wide SELECT, then grant SELECT on every column
-- EXCEPT access_token / refresh_token / token_expires_at. service_role keeps its
-- default full grants and stays the ONLY reader of the token columns (at
-- activation).
revoke select on table public.telematics_connections from authenticated;
grant select (
  id, org_id, provider, status, external_account_id,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.telematics_connections to authenticated;

-- ── telematics_readings — the append-only vehicle feed a live pull populates ───
-- WHAT THIS IS. One row per location/odometer sample a live telematics feed
-- reports for a vehicle. DARK today: no code path writes here (the OAuth exchange
-- refuses without credentials, so no connection is ever `connected`, so no feed
-- runs). At activation, an ingest path (service-role: a webhook or cron) maps a
-- provider payload through lib/integrations/telematics/reading-map.ts onto these
-- rows, keyed to the fleet_vehicles register the product already renders.
--
-- ── #456 ORG-PINNED + COMPOSITE-FK VEHICLE BINDING ──────────────────────────
-- Both foreign keys are COMPOSITE (…, org_id), so a reading can never bind to a
-- vehicle or a connection belonging to a different organisation — the DB refuses
-- the cross-tenant row declaratively, for every role including service_role. This
-- is the load-bearing tenant control on the feed, not decoration.
--
-- ── APPEND-ONLY (immutable rows) ────────────────────────────────────────────
-- A telematics reading is a historical fact — a sample at a moment. It is never
-- edited. A BEFORE UPDATE trigger raises, so rows are immutable once written.
-- DELETE is deliberately NOT blocked: org teardown cascades from organizations,
-- and a retention/erasure job (service-role) must be able to purge — an UPDATE
-- block is the append-only guarantee, a DELETE block would break cascade teardown.
create table if not exists public.telematics_readings (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The vehicle this reading is for. `vehicle_id` is a fleet_vehicles.asset_id.
  vehicle_id         uuid not null,
  -- The connection that produced this reading (provenance). Composite-FK'd so it
  -- cannot name another org's connection.
  connection_id      uuid not null,
  -- The provider's own event/sample id — the idempotency key a live ingest uses
  -- to dedupe re-delivered samples (unique per org below).
  source_event_id    text,
  -- The sample instant, as the provider reported it.
  recorded_at        timestamptz not null,
  -- WGS84 location. Nullable: an odometer-only sample carries no fix.
  latitude           numeric(9,6) check (latitude is null or latitude between -90 and 90),
  longitude          numeric(9,6) check (longitude is null or longitude between -180 and 180),
  -- Odometer in MILES (UK) — matches fleet_vehicles.odometer_miles. Nullable: a
  -- location-only sample carries no odometer.
  odometer_miles     integer check (odometer_miles is null or odometer_miles between 0 and 3000000),
  created_at         timestamptz not null default now(),

  -- THE cross-tenant controls (see header): both FKs carry org_id.
  constraint telematics_readings_vehicle_org_fk
    foreign key (vehicle_id, org_id) references public.fleet_vehicles (asset_id, org_id)
    on update cascade on delete cascade,
  constraint telematics_readings_connection_org_fk
    foreign key (connection_id, org_id) references public.telematics_connections (id, org_id)
    on update cascade on delete cascade,

  -- A sample with no location AND no odometer carries no signal — refuse it.
  constraint telematics_readings_has_signal check (
    latitude is not null or longitude is not null or odometer_miles is not null
  ),
  -- A latitude without a longitude (or vice-versa) is not a fix.
  constraint telematics_readings_latlng_pair check (
    (latitude is null) = (longitude is null)
  ),
  -- Idempotency: one row per (org, connection, provider event) so a re-delivered
  -- sample is a no-op at the DB, not a duplicate.
  constraint telematics_readings_source_event_uniq unique (org_id, connection_id, source_event_id)
);

-- The hot read: a vehicle's recent track, newest-first.
create index if not exists telematics_readings_vehicle_time_idx
  on public.telematics_readings (org_id, vehicle_id, recorded_at desc);

-- ── APPEND-ONLY immutability trigger ─────────────────────────────────────────
-- Readings are historical facts; they are never edited. Raising on UPDATE makes
-- every row immutable for EVERY role (service-role included). DELETE is left to
-- RLS + cascade so org teardown / retention still work.
create or replace function public.tg_telematics_readings_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'telematics_readings rows are append-only and cannot be updated'
    using errcode = 'restrict_violation';
end $$;

drop trigger if exists telematics_readings_immutable on public.telematics_readings;
create trigger telematics_readings_immutable before update on public.telematics_readings
  for each row execute function public.tg_telematics_readings_immutable();

-- ── RLS — members read; writes are service-role only (the live feed) ──────────
-- A live feed ingests as service_role (a webhook/cron), so authenticated has NO
-- insert/update/delete policy — a tenant JWT can only READ its own org's readings.
-- Nothing is writable dark from any tenant surface; the feed is the sole writer,
-- and it is unreachable until activation.
alter table public.telematics_readings enable row level security;

drop policy if exists "telematics_readings: members can select" on public.telematics_readings;
create policy "telematics_readings: members can select" on public.telematics_readings
  for select to authenticated using (org_id in (select public.current_org_ids()));

-- anon: no surface on this table at all.
revoke all on table public.telematics_readings from anon;
