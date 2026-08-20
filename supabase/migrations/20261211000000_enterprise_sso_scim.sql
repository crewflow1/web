-- Enterprise SSO (SAML 2.0 + OIDC) + SCIM 2.0 provisioning — SUBSTRATE, BUILT
-- DARK. Additive, org-teardown-safe.
--
-- WHY / WHAT
-- ─────────────────────────────────────────────────────────────────────────────
-- CrewFlow authenticates with email+password (+ optional MFA). Enterprise
-- customers need federated SSO (their IdP) and directory-driven provisioning
-- (SCIM). This migration lays the per-org CONFIG substrate for both. It ships
-- DARK on two independent switches:
--   (1) the deployment build gate  env FEATURE_ENTERPRISE_SSO (default off), and
--   (2) a per-org `enabled` bool on each config row (default false).
-- While either is off the SSO routes 404/deny and SCIM returns 401/403, and
-- NOTHING auto-provisions. Activation requires a real customer's IdP metadata
-- (SAML: entityID + SSO URL + x509 signing cert; OIDC: issuer + client
-- credentials) or a minted SCIM bearer token — external inputs this repo never
-- fabricates.
--
-- THE DENY-BY-DEFAULT PROVISIONING RULE (enforced in app code, mirrored here):
-- a validated assertion / SCIM record is only ever MAPPED to an EXISTING org
-- membership by verified email. There is NO auto-create-user path. An unmatched
-- subject is DENIED. SSO/SCIM writes are membership-scoped only.
--
-- SECRETS AT REST
-- ─────────────────────────────────────────────────────────────────────────────
-- The OIDC client_secret is stored ENCRYPTED (lib/integrations/token-crypto.ts
-- AES-256-GCM envelope) in oidc_client_secret_ciphertext — never plaintext. The
-- SCIM bearer token is stored HASHED (sha256, lib/api-auth/keygen.ts) in
-- token_hash — the plaintext exists once, at mint time. The SAML x509 cert is a
-- PUBLIC key (not a secret). Column-level grants additionally withhold the
-- ciphertext/hash columns from the authenticated role (defence in depth).
--
-- ACCESS MODEL (no anon/authenticated SECURITY DEFINER RPCs)
-- ─────────────────────────────────────────────────────────────────────────────
-- RLS: admins may SELECT their own org's config (to view status). There is NO
-- authenticated INSERT/UPDATE/DELETE policy, so every tenant WRITE is denied by
-- RLS. Config is written server-side by the SERVICE ROLE from admin-gated server
-- actions (the app layer authorises the caller as an org admin first). The
-- SSO/SCIM protocol endpoints authenticate at the ROUTE layer (SAML signature /
-- OIDC id_token / SCIM bearer) and read/write via the service role scoped
-- explicitly to one org — so no cross-tenant anon RPC is introduced (satisfies
-- secdef-org-rpc-guard by adding no such function).
--
-- TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive; every FK is org_id -> organizations(id) ON DELETE CASCADE. No
-- cross-tenant child FKs (nothing references the config tables), so there is no
-- bare (id-only) cross-tenant FK to make composite. BEFORE UPDATE triggers only
-- touch updated_at and cannot fire during a delete cascade. Fresh CREATE only.

-- ── 1. org_sso_config — per-org SAML/OIDC identity-provider configuration ─────
create table if not exists public.org_sso_config (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- Which federation protocol this row configures. One active config per org
  -- (the unique(org_id) below); switching protocols replaces the row.
  protocol     text not null check (protocol in ('saml', 'oidc')),

  -- PER-ORG DARK SWITCH. Deny-by-default: while false the org's SSO endpoints
  -- deny even when FEATURE_ENTERPRISE_SSO is on.
  enabled      boolean not null default false,

  -- ── SAML 2.0 (SP-side) fields ──────────────────────────────────────────────
  -- IdP metadata a customer must provide to activate SAML.
  saml_idp_entity_id text,          -- IdP EntityID (issuer we require on the assertion)
  saml_idp_sso_url   text,          -- IdP SSO service URL (where we send AuthnRequests)
  saml_idp_x509_cert text,          -- IdP signing certificate (PEM/base64) — PUBLIC key
  saml_name_id_format text,         -- optional requested NameID format
  -- SP-side identity WE present. sp_entity_id is our Audience; the assertion's
  -- AudienceRestriction must equal it. Null → app derives from request origin.
  sp_entity_id text,

  -- ── OIDC (RP-side) fields ──────────────────────────────────────────────────
  oidc_issuer        text,          -- issuer (iss we require on the id_token)
  oidc_client_id     text,
  -- ENCRYPTED at rest (token-crypto v1: envelope). NEVER plaintext.
  oidc_client_secret_ciphertext text,
  oidc_discovery_url text,          -- optional; app derives {issuer}/.well-known/... when null

  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One SSO config per org.
  constraint org_sso_config_org_key unique (org_id),
  -- Candidate key so any future org-scoped child binds (id, org_id), never id
  -- alone — keeps cross-tenant references composable.
  constraint org_sso_config_id_org_key unique (id, org_id),

  -- Shape integrity: the row must carry the fields its protocol needs. Only the
  -- SHAPE is pinned here; app code validates values (URLs, cert parse, etc.).
  constraint org_sso_config_saml_shape check (
    protocol <> 'saml' or (
      saml_idp_entity_id is not null and btrim(saml_idp_entity_id) <> ''
      and saml_idp_sso_url is not null and saml_idp_sso_url ~ '^https://'
      and saml_idp_x509_cert is not null and btrim(saml_idp_x509_cert) <> ''
    )
  ),
  constraint org_sso_config_oidc_shape check (
    protocol <> 'oidc' or (
      oidc_issuer is not null and oidc_issuer ~ '^https://'
      and oidc_client_id is not null and btrim(oidc_client_id) <> ''
      and oidc_client_secret_ciphertext is not null and btrim(oidc_client_secret_ciphertext) <> ''
    )
  )
);

comment on table public.org_sso_config is
  'Per-org enterprise SSO (SAML 2.0 / OIDC) identity-provider config. BUILT DARK: gated by env FEATURE_ENTERPRISE_SSO AND the per-row enabled bool (default false). One config per org. OIDC client_secret stored ENCRYPTED (token-crypto); SAML x509 is a public key. Written only by the service role from admin-gated server actions (no authenticated write policy). Org-scoped but NOT DSAR-exported (security config, not user personal data).';
comment on column public.org_sso_config.enabled is
  'Per-org DARK switch. Deny-by-default: while false the org SSO endpoints deny even with FEATURE_ENTERPRISE_SSO on.';
comment on column public.org_sso_config.oidc_client_secret_ciphertext is
  'OIDC client secret, AES-256-GCM encrypted (lib/integrations/token-crypto.ts). NEVER plaintext. Withheld from the authenticated column grant.';

create index if not exists org_sso_config_enabled_idx
  on public.org_sso_config (org_id) where enabled;

-- ── 2. org_scim_config — per-org SCIM 2.0 provisioning credential ─────────────
create table if not exists public.org_scim_config (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  -- PER-ORG DARK SWITCH. Deny-by-default for the SCIM endpoints.
  enabled      boolean not null default false,

  -- The SCIM bearer credential the customer's IdP presents. HASHED (sha256);
  -- the plaintext exists once, at mint time, and is never stored or logged.
  token_hash   text,                -- sha256 hex of the bearer token
  token_prefix text,                -- short display identifier (non-secret)
  token_minted_at timestamptz,

  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint org_scim_config_org_key unique (org_id),
  constraint org_scim_config_id_org_key unique (id, org_id),
  -- An enabled SCIM config MUST carry a token hash (can't be live without a
  -- credential). Deny-by-default: disabled rows may have no token.
  constraint org_scim_config_enabled_needs_token check (
    not enabled or (token_hash is not null and btrim(token_hash) <> '')
  )
);

comment on table public.org_scim_config is
  'Per-org SCIM 2.0 provisioning credential. BUILT DARK: gated by env FEATURE_ENTERPRISE_SSO AND the per-row enabled bool (default false). Bearer token stored HASHED (sha256). Written only by the service role from admin-gated actions. Org-scoped but NOT DSAR-exported (security credential, not user personal data).';
comment on column public.org_scim_config.token_hash is
  'sha256 hex of the SCIM bearer token — the only stored form. Withheld from the authenticated column grant.';

-- Unique index on the token hash so SCIM auth is a single indexed lookup and no
-- two orgs can share a token. Partial: only enabled rows with a token.
create unique index if not exists org_scim_config_token_hash_key
  on public.org_scim_config (token_hash) where token_hash is not null;

-- ── 3. sso_provisioning_audit — append-only SSO/SCIM decision trail ──────────
-- Records every ACS / OIDC callback / SCIM attempt and its outcome (matched a
-- membership, denied-unmatched, signature-invalid, flag-off, deactivated…).
-- Accountability metadata for a security-sensitive surface — NOT tenant
-- business data and NOT DSAR-exported.
create table if not exists public.sso_provisioning_audit (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  protocol     text not null check (protocol in ('saml', 'oidc', 'scim')),
  event        text not null,       -- e.g. 'assertion_accepted','denied_unmatched','signature_invalid','scim_deactivate'
  outcome      text not null check (outcome in ('allow', 'deny')),
  -- The subject asserted by the IdP/SCIM (email/NameID/sub). Kept for audit; the
  -- table is excluded from bulk DSAR export (security trail).
  subject      text,
  -- Non-secret structured detail (reason codes, matched membership id, etc.).
  -- NEVER stores assertion signatures, tokens, or client secrets.
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.sso_provisioning_audit is
  'Append-only SSO/SCIM decision trail (accept/deny with reason). Security accountability metadata — NOT tenant business data, NOT DSAR-exported. Never stores signatures/tokens/secrets.';

create index if not exists sso_provisioning_audit_org_idx
  on public.sso_provisioning_audit (org_id, created_at desc);

-- ── 4. updated_at triggers ───────────────────────────────────────────────────
drop trigger if exists org_sso_config_set_updated_at on public.org_sso_config;
create trigger org_sso_config_set_updated_at before update on public.org_sso_config
  for each row execute function public.tg_set_updated_at();

drop trigger if exists org_scim_config_set_updated_at on public.org_scim_config;
create trigger org_scim_config_set_updated_at before update on public.org_scim_config
  for each row execute function public.tg_set_updated_at();

-- ── 5. RLS — admin SELECT only; ALL tenant writes denied (service-role only) ──
alter table public.org_sso_config enable row level security;
alter table public.org_scim_config enable row level security;
alter table public.sso_provisioning_audit enable row level security;

-- Admins may READ their org's SSO config (to view/manage status). No write
-- policy: tenant INSERT/UPDATE/DELETE are denied by RLS; the service role (which
-- bypasses RLS) performs writes from admin-gated server actions.
drop policy if exists "org_sso_config: admins select" on public.org_sso_config;
create policy "org_sso_config: admins select" on public.org_sso_config
  for select to authenticated using (public.is_org_admin(org_id));

drop policy if exists "org_scim_config: admins select" on public.org_scim_config;
create policy "org_scim_config: admins select" on public.org_scim_config
  for select to authenticated using (public.is_org_admin(org_id));

-- Admins may READ their org's SSO/SCIM audit trail. Append-only: no tenant
-- write policy (only the service role writes audit rows).
drop policy if exists "sso_provisioning_audit: admins select" on public.sso_provisioning_audit;
create policy "sso_provisioning_audit: admins select" on public.sso_provisioning_audit
  for select to authenticated using (public.is_org_admin(org_id));

-- ── 6. Column-level privileges — no anon, secrets withheld from authenticated ─
-- Supabase default-grants ALL to anon+authenticated; rebuild explicitly.
revoke all on table public.org_sso_config from anon;
revoke all on table public.org_scim_config from anon;
revoke all on table public.sso_provisioning_audit from anon;

-- Authenticated has NO write on any of these (writes are service-role only).
revoke insert, update, delete on table public.org_sso_config from authenticated;
revoke insert, update, delete on table public.org_scim_config from authenticated;
revoke insert, update, delete on table public.sso_provisioning_audit from authenticated;

-- Withhold the secret-material columns from the authenticated SELECT grant so
-- even an admin's PostgREST `select *` cannot read the encrypted secret / token
-- hash. App reads select explicit non-secret columns. Rebuild the SELECT grant
-- to the exact non-secret column set (idempotent).
revoke select on table public.org_sso_config from authenticated;
grant select (id, org_id, protocol, enabled,
              saml_idp_entity_id, saml_idp_sso_url, saml_idp_x509_cert,
              saml_name_id_format, sp_entity_id,
              oidc_issuer, oidc_client_id, oidc_discovery_url,
              created_by, created_at, updated_at)
  on public.org_sso_config to authenticated;

revoke select on table public.org_scim_config from authenticated;
grant select (id, org_id, enabled, token_prefix, token_minted_at,
              created_by, created_at, updated_at)
  on public.org_scim_config to authenticated;
