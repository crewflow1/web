-- Merchant connections — the BUILDERS' MERCHANT connection substrate for the
-- JP Corry / Jewson / Travis Perkins / Haldane Fisher integrations.
--
-- WHAT THIS IS. One row per (org, merchant) recording whether a tenant has
-- connected their trade account with a builders' merchant and — once live — the
-- non-secret connection handle (the org's trade ACCOUNT NUMBER) plus an optional
-- per-org account SECRET used to import price files and submit purchase orders.
-- It is the DB half of "connect your merchant account". A live link would map an
-- imported price file (lib/integrations/merchants/price-file.ts) ONTO
-- merchant_catalogue_items and submit orders (lib/integrations/merchants/cxml.ts)
-- through merchant_po_submissions — both created by the sibling migration
-- 20261124000001. This table only records WHICH merchant account each org is
-- bound to. It clones the telematics_connections posture (20261103) exactly.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No secret is ever written by this build. The connect substrate
-- (lib/integrations/merchants/connect.ts) reports every merchant NOT connectable
-- while the master flag is off / the credentials are absent / the endpoint is
-- absent — which is ALWAYS, today — and the adapters REFUSE before any network
-- call, so no code path reaches a `connected` row or a populated secret column. A
-- row exists only after a real connect handshake, which is unreachable without
-- credentials. Until activation every column except org_id / provider /
-- status('disconnected') stays null.
--
-- ── ACTIVATION (config + a COMMERCIAL contract, not engineering) ─────────────
-- Go-live per merchant requires ALL of: (1) a trade-account INTEGRATION CONTRACT
-- with the merchant (the endpoint is provisioned per contract, not a public
-- host), (2) its credentials + endpoint (MERCHANT_<P>_API_KEY /
-- MERCHANT_<P>_ENDPOINT), and (3) the feature flag NEXT_PUBLIC_FEATURE_MERCHANTS
-- ="true". Plus INTEGRATION_TOKEN_ENCRYPTION_KEY (shared) so per-org account
-- secrets are encrypted at rest. No code change reaches the live path.
--
-- ── SECRETS AT REST ─────────────────────────────────────────────────────────
-- account_secret is a secret (a per-org account API token the merchant issues).
-- It is NULL today (dark) and is AES-256-GCM encrypted application-side
-- (lib/integrations/token-crypto.ts) BEFORE it reaches this column once activated
-- — the connect handshake encrypts before the DB write, exactly as the
-- accounting/banking/telematics substrates do. This migration only carves the
-- slot; it deliberately writes nothing, so there is no plaintext secret in the
-- schema and none can arrive dark.
--
-- ── SECRET COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ──────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read account_secret / secret_expires_at back over
-- PostgREST. Those columns are stripped from the authenticated (and anon) read
-- surface by a COLUMN-LEVEL privilege at the foot of this migration (the
-- telematics_connections / bank_connections / api_keys.key_hash idiom): only
-- service_role can read them; members still read status / provider / handle.
--
-- ── CANNOT BE "CONNECTED" WITHOUT AN ACCOUNT ────────────────────────────────
-- A CHECK forbids status='connected' unless a connection handle
-- (external_account_id) is present. There is no way to fake a connected state —
-- the DB refuses a connected row that names no trade account.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the telematics posture) ─────────
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may READ
-- the connection state so the team sees whether a merchant is wired up; only an
-- admin may WRITE, because connecting/disconnecting a merchant account is an admin
-- act. DB-enforced, not app-only.
--
-- Additive and reversible. To roll back:
--   drop table public.merchant_po_submissions;   -- (sibling migration)
--   drop table public.merchant_catalogue_items;   -- (sibling migration)
--   drop table public.merchant_connections;

-- ── merchant_connections ──────────────────────────────────────────────────────
create table if not exists public.merchant_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The builders' merchant this row binds the org to. A small, closed set.
  provider           text not null check (provider in ('jp_corry', 'jewson', 'travis_perkins', 'haldane_fisher')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no account bound (the only state reachable dark). Default.
  --   connecting   — a connect handshake is in flight.
  --   connected    — a live account is bound (requires a connection handle below).
  --   error        — the last connect/sync failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- NON-SECRET connection handle — member-readable. The org's trade ACCOUNT
  -- NUMBER with the merchant. Nullable: absent until a real connect resolves it.
  -- Carries NO credential.
  external_account_id text,
  -- Optional per-org account SECRET. NULL today (dark) and encrypted
  -- application-side before write once activated (see "SECRETS AT REST"). Never
  -- populated without a real connect handshake, unreachable without credentials.
  account_secret     text,
  secret_expires_at  timestamptz,
  -- Provenance + operational metadata.
  connected_by       uuid references public.users(id) on delete set null,
  connected_at       timestamptz,
  last_sync_at       timestamptz,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One connection per merchant per org. Re-connecting upserts this row.
  constraint merchant_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for any child (merchant_catalogue_items / _po_submissions).
  constraint merchant_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a connection handle. There is no fake connected
  -- state: a connected row must name a trade account.
  constraint merchant_connections_connected_needs_handle check (
    status <> 'connected'
    or external_account_id is not null
  )
);

create index if not exists merchant_connections_org_idx
  on public.merchant_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists merchant_connections_set_updated_at on public.merchant_connections;
create trigger merchant_connections_set_updated_at before update on public.merchant_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
-- The telematics_connections posture: every member may READ whether a merchant is
-- connected; only an admin may INSERT/UPDATE/DELETE, because binding or removing a
-- merchant account is an admin act. DB-enforced so /rest/v1 is not open to any
-- member holding a JWT.
alter table public.merchant_connections enable row level security;

drop policy if exists "merchant_connections: members can select" on public.merchant_connections;
create policy "merchant_connections: members can select" on public.merchant_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "merchant_connections: admins can insert" on public.merchant_connections;
create policy "merchant_connections: admins can insert" on public.merchant_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "merchant_connections: admins can update" on public.merchant_connections;
create policy "merchant_connections: admins can update" on public.merchant_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "merchant_connections: admins can delete" on public.merchant_connections;
create policy "merchant_connections: admins can delete" on public.merchant_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the secret-column readback exclusion ─────────────
-- RLS is ROW-level: the member-read SELECT policy above authorises the ROW, not
-- the columns, so a member could `select=account_secret,...` over PostgREST and
-- read the secret back. Those are secrets. Exclude them from the authenticated /
-- anon read surface with a COLUMN privilege — the exact idiom used for
-- telematics_connections (20261103), bank_connections (20261100),
-- accounting_connections (20261095) and api_keys.key_hash (20261086).
--
-- MECHANISM. Supabase's default privileges grant table-WIDE SELECT on new public
-- tables to anon + authenticated, and a bare column-level REVOKE has NO effect
-- while that table-wide grant stands. So we REVOKE the table-level SELECT and
-- GRANT SELECT back on exactly the non-secret columns. Adding a new column does
-- NOT expose it — it must be named in the grant below. Only SELECT is rebuilt:
-- INSERT / UPDATE / DELETE keep their default grants so the admin-write RLS
-- policies remain the authority for writes. Idempotent — replays cleanly.

-- anon: no surface on this table at all.
revoke all on table public.merchant_connections from anon;

-- authenticated: drop table-wide SELECT, then grant SELECT on every column
-- EXCEPT account_secret / secret_expires_at. service_role keeps its default full
-- grants and stays the ONLY reader of the secret columns (at activation).
revoke select on table public.merchant_connections from authenticated;
grant select (
  id, org_id, provider, status, external_account_id,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.merchant_connections to authenticated;
