-- HMRC MTD (Making Tax Digital) — the OAuth CONNECTION + prepared-submission
-- substrate for UK VAT digital filing and CIS300 monthly returns. DARK.
--
-- WHAT THIS IS. Two tables:
--   hmrc_connections — one row per org recording whether the org has connected
--     its HMRC account (via HMRC's OAuth2), and — once live — the VAT
--     registration number (`hmrc_vrn`) plus the OAuth tokens used to call the MTD
--     APIs. It is the DB half of "connect your HMRC account". The deterministic
--     tax authorities already exist (lib/tax/compute.ts computeVatQuarter for the
--     VAT boxes; lib/cis/statements.ts buildMonthlyReturnDataset for CIS300); the
--     substrate composes a submission PAYLOAD over those figures — it never
--     recomputes tax.
--   hmrc_submissions — an append-only audit of PREPARED / HELD submission
--     datasets (VAT returns + CIS300). It records what the substrate assembled
--     and is holding; it deliberately has NO `submitted` / `filed` state.
--
-- ── LEGAL BOUNDARY (BLOCKING, and the reason this is dark) ───────────────────
-- CrewFlow CANNOT and MUST NOT file to HMRC from this build. HMRC MTD requires a
-- RECOGNISED vendor: submitting VAT/CIS to the production APIs is gated by HMRC's
-- own software-recognition process (fraud-prevention header conformance +
-- vendor application), which is a LEGAL/COMMERCIAL gate, not an engineering one.
-- This substrate therefore stops at "prepared/held": it assembles the exact
-- payload a recognised submission would carry and stores it, but there is NO code
-- path that POSTs a return to HMRC. `hmrc_submissions.status` has no terminal
-- `submitted` value by construction, so a filed state is structurally
-- unrepresentable here.
--
-- ── DARK BY DEFAULT ─────────────────────────────────────────────────────────
-- No token is ever written by this build. The OAuth exchange
-- (lib/integrations/hmrc/oauth.ts) REFUSES before any `fetch` when the HMRC
-- client credentials are absent AND the NEXT_PUBLIC_FEATURE_HMRC_CONNECT flag is
-- off — which is ALWAYS, today (two-switch). No code path reaches a `connected`
-- row or a populated token column. Until activation, every column below except
-- org_id / provider / status('disconnected') stays null.
--
-- ── TOKENS AT REST ──────────────────────────────────────────────────────────
-- access_token / refresh_token are secrets. They are NULL today (dark) and are
-- AES-256-GCM encrypted application-side (lib/integrations/token-crypto.ts) by
-- the callback BEFORE they reach these columns once activated — the columns hold
-- ciphertext, never a plaintext secret. This migration only carves the slots; it
-- writes nothing, so no plaintext secret can arrive dark.
--
-- ── TOKEN COLUMNS ARE SERVICE-ROLE-ONLY ON READ (column privilege) ───────────
-- RLS is ROW-level, not COLUMN-level. The member-read SELECT policy below would
-- otherwise let ANY org member read access_token / refresh_token /
-- token_expires_at back over PostgREST. Those columns are stripped from the
-- authenticated (and anon) read surface by a COLUMN-LEVEL privilege at the foot
-- of this migration (the accounting_connections / api_keys idiom): only
-- service_role can read them; members still read status / provider / hmrc_vrn.
--
-- ── CANNOT BE "CONNECTED" WITHOUT A VRN ─────────────────────────────────────
-- A CHECK forbids status='connected' unless a provider handle (`hmrc_vrn`) is
-- present. There is no way to fake a connected state — the DB refuses a connected
-- row that names no VAT registration.
--
-- ── TENANCY + RLS: MEMBER-READ, ADMIN-WRITE ─────────────────────────────────
-- Org-pinned with a composite candidate key `(id, org_id)` so child rows bind to
-- BOTH the connection AND its org (the 20261089 idiom). Every member may READ the
-- connection/submission state; only an admin may WRITE, because connecting HMRC
-- and preparing a statutory return are admin acts. DB-enforced, not app-only.
--
-- Additive and reversible. To roll back:
--   drop table public.hmrc_submissions;
--   drop table public.hmrc_connections;

-- ── hmrc_connections ─────────────────────────────────────────────────────────
create table if not exists public.hmrc_connections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  -- Fixed 'hmrc'. Modelled as a column (not omitted) so the shape mirrors
  -- accounting_connections and a future second UK tax authority is a value, not
  -- a schema change. The CHECK pins it.
  provider           text not null default 'hmrc' check (provider = 'hmrc'),
  -- CONNECTION LIFECYCLE.
  --   disconnected — no HMRC account bound (the only state reachable dark). Default.
  --   connecting   — an OAuth authorize redirect is in flight (state issued).
  --   connected    — a live HMRC account is bound (requires hmrc_vrn below).
  --   error        — the last connect/refresh failed; see last_error.
  status             text not null default 'disconnected'
                       check (status in ('disconnected', 'connecting', 'connected', 'error')),
  -- NON-SECRET, MEMBER-READABLE provider handles.
  -- hmrc_vrn: the VAT registration number the connection is bound to (HMRC's
  --   account handle for MTD VAT). Absent until a real connection resolves it.
  -- gov_client_ids: the non-secret Gov-Client fraud-prevention device/client
  --   identifiers (device id, screen/window metadata) that
  --   lib/integrations/hmrc/fraud-headers.ts builds the mandatory headers from.
  --   These are identifiers, not credentials — safe for members to read.
  hmrc_vrn           text,
  gov_client_ids     jsonb not null default '{}'::jsonb,
  -- OAuth tokens. NULL today (dark) and AES-256-GCM ciphertext once activated
  -- (see "TOKENS AT REST"). Never populated without a real token exchange, which
  -- is unreachable without client credentials + the feature flag.
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
  -- One HMRC connection per org (provider is fixed 'hmrc'). Re-connecting upserts.
  constraint hmrc_connections_org_provider_uniq unique (org_id, provider),
  -- Composite-FK target so hmrc_submissions binds to (connection, org) together.
  constraint hmrc_connections_id_org_key unique (id, org_id),
  -- CANNOT be connected without a VRN. There is no fake connected state: a
  -- connected row must name the VAT registration it is bound to.
  constraint hmrc_connections_connected_needs_vrn check (
    status <> 'connected'
    or hmrc_vrn is not null
  )
);

create index if not exists hmrc_connections_org_idx
  on public.hmrc_connections (org_id);

-- Keep `updated_at` honest on every edit (the finances-table idiom).
drop trigger if exists hmrc_connections_set_updated_at on public.hmrc_connections;
create trigger hmrc_connections_set_updated_at before update on public.hmrc_connections
  for each row execute function public.tg_set_updated_at();

-- ── hmrc_submissions — append-only PREPARED/HELD audit (VAT + CIS300) ─────────
-- One row per assembled submission dataset. The payload is the exact JSON a
-- recognised submission would carry (VAT boxes / CIS300 lines), FROZEN at
-- prepare time. There is NO `submitted`/`filed` status — the legal boundary is
-- expressed in the schema, not just in code. Append-only: the RLS below grants
-- INSERT + SELECT only, so an admin can prepare and read but never mutate or
-- delete a prepared record (a statutory audit trail must not be rewritable).
create table if not exists public.hmrc_submissions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  connection_id      uuid not null,
  -- What kind of return this dataset represents.
  kind               text not null check (kind in ('vat_return', 'cis300')),
  -- The period this return covers: an MTD VAT periodKey, or a CIS tax-month end
  -- (yyyy-mm-dd). Free text — validated by the composer, not the DB.
  period_key         text not null,
  -- PREPARED = assembled + frozen, nothing sent. HELD = deliberately retained,
  -- still nothing sent. There is intentionally NO 'submitted'/'filed' state:
  -- this substrate cannot file (see the LEGAL BOUNDARY note above).
  status             text not null default 'prepared'
                       check (status in ('prepared', 'held')),
  -- The frozen payload: the composed VAT/CIS300 dataset. Not a secret (these are
  -- the org's own tax figures a member may already see), so no column privilege.
  payload            jsonb not null,
  prepared_by        uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  -- Bind the submission to BOTH the connection AND its org (composite FK). This
  -- makes it impossible to point a submission at another org's connection.
  constraint hmrc_submissions_conn_fk
    foreign key (connection_id, org_id)
    references public.hmrc_connections (id, org_id) on delete cascade
);

create index if not exists hmrc_submissions_org_idx
  on public.hmrc_submissions (org_id);
create index if not exists hmrc_submissions_conn_idx
  on public.hmrc_submissions (connection_id, org_id);

-- ── RLS — members read, admins write ─────────────────────────────────────────
alter table public.hmrc_connections enable row level security;

drop policy if exists "hmrc_connections: members can select" on public.hmrc_connections;
create policy "hmrc_connections: members can select" on public.hmrc_connections
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "hmrc_connections: admins can insert" on public.hmrc_connections;
create policy "hmrc_connections: admins can insert" on public.hmrc_connections
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "hmrc_connections: admins can update" on public.hmrc_connections;
create policy "hmrc_connections: admins can update" on public.hmrc_connections
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "hmrc_connections: admins can delete" on public.hmrc_connections;
create policy "hmrc_connections: admins can delete" on public.hmrc_connections
  for delete to authenticated using (public.is_org_admin(org_id));

-- hmrc_submissions — APPEND-ONLY: member-read, admin-INSERT only. There is
-- deliberately NO update or delete policy, so RLS's default-deny makes a prepared
-- record immutable to every tenant caller (only service_role, which bypasses
-- RLS, could ever correct one). A statutory audit trail must not be rewritable.
alter table public.hmrc_submissions enable row level security;

drop policy if exists "hmrc_submissions: members can select" on public.hmrc_submissions;
create policy "hmrc_submissions: members can select" on public.hmrc_submissions
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "hmrc_submissions: admins can insert" on public.hmrc_submissions;
create policy "hmrc_submissions: admins can insert" on public.hmrc_submissions
  for insert to authenticated with check (public.is_org_admin(org_id));

-- ── COLUMN-LEVEL PRIVILEGE — the token-column readback exclusion ──────────────
-- RLS is ROW-level: the member-read SELECT policy authorises the ROW, not the
-- columns, so a member could `select=access_token,...` over PostgREST and read
-- the tokens back. Those are secrets. Exclude them with a COLUMN privilege —
-- REVOKE the table-wide SELECT (a bare column REVOKE is a no-op while the
-- table-wide grant stands) and GRANT SELECT back on exactly the non-token
-- columns. Adding a new column does NOT expose it — it must be named here.
-- Idempotent: replays cleanly under `supabase db reset`.

-- anon: no surface on either table at all.
revoke all on table public.hmrc_connections from anon;
revoke all on table public.hmrc_submissions from anon;

-- authenticated: drop table-wide SELECT on hmrc_connections, then grant SELECT
-- on every column EXCEPT access_token / refresh_token / token_expires_at.
-- service_role keeps its default full grants and stays the ONLY reader of the
-- token columns (at activation).
revoke select on table public.hmrc_connections from authenticated;
grant select (
  id, org_id, provider, status, hmrc_vrn, gov_client_ids,
  connected_by, connected_at, last_sync_at, last_error, created_at, updated_at
) on public.hmrc_connections to authenticated;
