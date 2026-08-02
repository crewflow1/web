-- Bank connections — the OPEN-BANKING / bank-feed CONNECTION substrate.
--
-- WHAT THIS IS. One row per (org, aggregator) recording whether a tenant has
-- connected a bank account through an Open Banking aggregator (TrueLayer / Plaid
-- / Nordigen-GoCardless) and — once live — the non-secret connection handle
-- (institution + the aggregator's connection/item/requisition reference) plus the
-- OAuth tokens used to pull statements. It is the DB half of "connect your bank":
-- the fetched statements are mapped by lib/integrations/banking/statement-map.ts
-- ONTO the EXISTING bank_statements / bank_statement_lines tables (20260524), so
-- activation feeds the reconciliation UI that already exists — this table only
-- records WHICH bank each org is bound to. It clones the accounting_connections
-- posture (20261095) exactly.
--
-- ── FCA LEGAL BOUNDARY (BLOCKING, not an engineering gate) ───────────────────
-- Open Banking / Account Information Services are REGULATED in the UK: pulling a
-- customer's bank data requires FCA authorisation (or agent status under) as an
-- Account Information Service Provider (AISP), plus the aggregator contract. This
-- substrate is DARK precisely so no live bank connection can occur before that
-- authorisation exists. Go-live requires ALL of: (1) FCA AISP authorisation /
-- agent permission — a LEGAL gate, (2) an aggregator contract + credentials,
-- (3) the feature flag. This migration carves slots and writes NOTHING.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No token is ever written by this build. The OAuth exchange
-- (lib/integrations/banking/oauth.ts) REFUSES when the aggregator client
-- credentials are absent / the flag is off / no BANKING_PROVIDER is bound — which
-- is ALWAYS, today — so no code path reaches a `connected` row or a populated
-- token column. A row exists only after a real OAuth exchange, and that exchange
-- is unreachable without credentials. Until activation every column below except
-- org_id / provider / status('disconnected') stays null.
--
-- ── TOKENS AT REST ──────────────────────────────────────────────────────────
-- access_token / refresh_token are secrets. They are NULL today (dark) and are
-- AES-256-GCM encrypted application-side (lib/integrations/token-crypto.ts) BEFORE
-- they reach these columns once activated — the callback encrypts before the DB
-- write, exactly as the accounting substrate does. This migration only carves the
-- slots; it deliberately writes nothing, so there is no plaintext secret in the
-- schema and none can arrive dark.
--
-- ── TOKEN COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ───────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read access_token / refresh_token /
-- token_expires_at back over PostgREST. Those columns are stripped from the
-- authenticated (and anon) read surface by a COLUMN-LEVEL privilege at the foot
-- of this migration (the api_keys.key_hash / accounting_connections idiom): only
-- service_role can read them; members still read status / provider / handle.
--
-- ── CANNOT BE "CONNECTED" WITHOUT AN ACCOUNT ────────────────────────────────
-- A CHECK forbids status='connected' unless a connection handle (connection_ref)
-- is present. There is no way to fake a connected state — the DB refuses a
-- connected row that names no aggregator connection.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the accounting_connections posture)
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may READ
-- the connection state so the team sees whether the bank feed is wired up; only
-- an admin may WRITE, because connecting/disconnecting a bank is an admin act.
-- DB-enforced, not app-only.
--
-- Additive and reversible. To roll back:
--   drop table public.bank_connections;

-- ── bank_connections ─────────────────────────────────────────────────────────
create table if not exists public.bank_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The Open Banking aggregator this row binds the org to. A small, closed set.
  provider           text not null check (provider in ('truelayer', 'plaid', 'nordigen')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no bank bound (the only state reachable dark). Default.
  --   connecting   — an OAuth authorize redirect is in flight (state issued).
  --   connected    — a live bank is bound (requires a connection handle below).
  --   error        — the last connect/refresh failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- NON-SECRET connection handles — member-readable. The bank the tenant chose
  -- and the aggregator's connection reference (TrueLayer connection id, Plaid
  -- item_id, Nordigen requisition id). Nullable: absent until a real exchange
  -- resolves the connection. These carry NO credential.
  institution_id     text,
  institution_name   text,
  connection_ref     text,
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
  -- One connection per aggregator per org. Re-connecting upserts this row.
  constraint bank_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for any future child (the accounting_connections idiom).
  constraint bank_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a connection handle. There is no fake connected
  -- state: a connected row must name an aggregator connection reference.
  constraint bank_connections_connected_needs_handle check (
    status <> 'connected'
    or connection_ref is not null
  )
);

create index if not exists bank_connections_org_idx
  on public.bank_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists bank_connections_set_updated_at on public.bank_connections;
create trigger bank_connections_set_updated_at before update on public.bank_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
-- The accounting_connections posture: every member may READ whether the bank feed
-- is connected; only an admin may INSERT/UPDATE/DELETE, because binding or
-- removing a bank is an admin act. DB-enforced so /rest/v1 is not open to any
-- member holding a JWT.
alter table public.bank_connections enable row level security;

drop policy if exists "bank_connections: members can select" on public.bank_connections;
create policy "bank_connections: members can select" on public.bank_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "bank_connections: admins can insert" on public.bank_connections;
create policy "bank_connections: admins can insert" on public.bank_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "bank_connections: admins can update" on public.bank_connections;
create policy "bank_connections: admins can update" on public.bank_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "bank_connections: admins can delete" on public.bank_connections;
create policy "bank_connections: admins can delete" on public.bank_connections
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
-- policies remain the authority for writes (writing a token is fine; READING it
-- back is what is forbidden). Idempotent — replays cleanly under `supabase db reset`.

-- anon: no surface on this table at all.
revoke all on table public.bank_connections from anon;

-- authenticated: drop table-wide SELECT, then grant SELECT on every column
-- EXCEPT access_token / refresh_token / token_expires_at. service_role keeps its
-- default full grants and stays the ONLY reader of the token columns (at
-- activation).
revoke select on table public.bank_connections from authenticated;
grant select (
  id, org_id, provider, status, institution_id, institution_name, connection_ref,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.bank_connections to authenticated;
