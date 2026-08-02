-- Accounting connections — the OAuth CONNECTION substrate for the Phase 5
-- "Xero / QuickBooks / accounting export" integration.
--
-- WHAT THIS IS. One row per (org, provider) recording whether a tenant has
-- connected their bookkeeping account, and — once the connection is live — the
-- provider handle (`external_tenant_id` for Xero, `realm_id` for QuickBooks) and
-- the OAuth tokens used to push to it. It is the DB half of "connect your Xero /
-- QuickBooks account": the export pipeline (20261093 accounting_export_log +
-- lib/integrations/accounting/*) already knows HOW to project CrewFlow finance
-- into a canonical shape and push it through a credential-gated adapter; this
-- table records WHICH account each org is bound to.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No token is ever written by this build. The OAuth exchange
-- (lib/integrations/accounting/oauth.ts) REFUSES when the provider client
-- credentials are absent from the environment — which is ALWAYS, today — so no
-- code path reaches a `connected` row or a populated token column. A row exists
-- only after a real OAuth exchange, and that exchange is unreachable without
-- client credentials. Until activation, every column below except org_id /
-- provider / status('disconnected') stays null.
--
-- ── TOKENS AT REST ──────────────────────────────────────────────────────────
-- access_token / refresh_token are secrets. They are NULL today (dark) and MUST
-- NOT be stored as plaintext when the integration is activated: the activation
-- step encrypts them application-side (envelope encryption with a KMS/Vault data
-- key, or pgsodium) BEFORE they reach these columns, exactly as a future
-- provider-push wave will implement inside oauth.ts. This migration only carves
-- the slots; it deliberately writes nothing, so there is no plaintext secret in
-- the schema and none can arrive dark.
--
-- ACTIVATION REQUIREMENT (BLOCKING, not yet satisfied). There is no
-- key-management utility in this repo today, so app-side token encryption is a
-- documented ACTIVATION gate, not a shipped capability. Before the callback
-- write (app/api/integrations/accounting/[provider]/callback/route.ts) is
-- switched live, a key-management decision (KMS/Vault vs pgsodium, key rotation,
-- who holds the data key) MUST be made and the exchange path MUST encrypt tokens
-- application-side before they reach access_token / refresh_token. Additionally,
-- the OAuth redirect_uri (derived per-request from the request origin in
-- oauth.ts today) MUST be origin-pinned to a trusted, allow-listed host at
-- activation so a spoofed Host/forwarded origin cannot redirect the code
-- elsewhere. Neither is reachable dark (no token is written while the exchange
-- refuses without credentials), but both are prerequisites for going live.
--
-- ── TOKEN COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ───────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read access_token / refresh_token /
-- token_expires_at back over PostgREST. Those columns are stripped from the
-- authenticated (and anon) read surface by a COLUMN-LEVEL privilege at the foot
-- of this migration (the api_keys.key_hash / outbound_webhooks-secret idiom):
-- only service_role can read them; members still read status / provider / handle.
--
-- ── CANNOT BE "CONNECTED" WITHOUT AN ACCOUNT ────────────────────────────────
-- A CHECK forbids status='connected' unless a provider handle
-- (external_tenant_id OR realm_id) is present. There is no way to fake a
-- connected state — the DB refuses a connected row that names no account.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE (the expense_budgets posture) ────
-- Org-pinned with a composite candidate key `(id, org_id)`. Every member may
-- READ the connection state so the team sees whether bookkeeping is wired up;
-- only an admin may WRITE, because connecting/disconnecting an accounting
-- provider is an admin act. DB-enforced, not app-only — an app-only gate would
-- leave /rest/v1/accounting_connections open to any member holding a JWT.
--
-- Additive and reversible. To roll back:
--   drop table public.accounting_connections;

-- ── accounting_connections ───────────────────────────────────────────────────
create table if not exists public.accounting_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- The bookkeeping provider this row binds the org to.
  provider           text not null check (provider in ('xero', 'quickbooks')),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no account bound (the only state reachable dark). Default.
  --   connecting   — an OAuth authorize redirect is in flight (state issued).
  --   connected    — a live account is bound (requires a provider handle below).
  --   error        — the last connect/refresh failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- Provider account handles. Xero returns a tenant id; QuickBooks a realm id.
  -- Nullable: absent until a real OAuth exchange resolves the account.
  external_tenant_id text,
  realm_id           text,
  -- OAuth tokens. NULL today (dark) and encrypted application-side before write
  -- once activated (see the "TOKENS AT REST" note above). Never populated
  -- without a real token exchange, which is unreachable without client creds.
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
  constraint accounting_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target for any future child (the 20261089 idiom).
  constraint accounting_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a provider account handle. There is no fake
  -- connected state: a connected row must name a Xero tenant or a QBO realm.
  constraint accounting_connections_connected_needs_handle check (
    status <> 'connected'
    or external_tenant_id is not null
    or realm_id is not null
  )
);

create index if not exists accounting_connections_org_idx
  on public.accounting_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists accounting_connections_set_updated_at on public.accounting_connections;
create trigger accounting_connections_set_updated_at before update on public.accounting_connections
  for each row execute function public.tg_set_updated_at();

-- ── RLS — members read, admins write (org-level integration configuration) ───
-- The expense_budgets posture: every member may READ whether bookkeeping is
-- connected; only an admin may INSERT/UPDATE/DELETE, because binding or removing
-- an accounting provider is an admin act. DB-enforced so /rest/v1 is not open to
-- any member holding a JWT.
alter table public.accounting_connections enable row level security;

drop policy if exists "accounting_connections: members can select" on public.accounting_connections;
create policy "accounting_connections: members can select" on public.accounting_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "accounting_connections: admins can insert" on public.accounting_connections;
create policy "accounting_connections: admins can insert" on public.accounting_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "accounting_connections: admins can update" on public.accounting_connections;
create policy "accounting_connections: admins can update" on public.accounting_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "accounting_connections: admins can delete" on public.accounting_connections;
create policy "accounting_connections: admins can delete" on public.accounting_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the token-column readback exclusion ──────────────
-- RLS is ROW-level: the member-read SELECT policy above authorises the ROW, not
-- the columns, so a member could `select=access_token,refresh_token,...` over
-- PostgREST and read the tokens back. Those are secrets. Exclude them from the
-- authenticated / anon read surface with a COLUMN privilege — the exact idiom
-- used for api_keys.key_hash (20261086) and the outbound_webhooks signing secret
-- (20261087).
--
-- MECHANISM. Supabase's default privileges grant table-WIDE SELECT on new public
-- tables to anon + authenticated, and a bare column-level REVOKE has NO effect
-- while that table-wide grant stands (Postgres keeps the table privilege and
-- ignores the narrower revoke). So we REVOKE the table-level SELECT and GRANT
-- SELECT back on exactly the non-token columns. Adding a new column does NOT
-- expose it — it must be named in the grant below. Only SELECT is rebuilt:
-- INSERT / UPDATE / DELETE keep their default grants so the admin-write RLS
-- policies remain the authority for writes (writing a token is fine; READING it
-- back is what is forbidden). Idempotent — REVOKE of an absent privilege and a
-- repeated GRANT are both no-ops, so `supabase db reset` replays cleanly.

-- anon: no surface on this table at all.
revoke all on table public.accounting_connections from anon;

-- authenticated: drop table-wide SELECT, then grant SELECT on every column
-- EXCEPT access_token / refresh_token / token_expires_at. service_role keeps its
-- default full grants and stays the ONLY reader of the token columns (at
-- activation).
revoke select on table public.accounting_connections from authenticated;
grant select (
  id, org_id, provider, status, external_tenant_id, realm_id,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.accounting_connections to authenticated;
