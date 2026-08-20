-- Marketplace / partner platform (Phase 14) — PART 2: installs + entitlements.
-- SUBSTRATE, BUILT DARK. Additive, org-teardown-safe.
--
-- A tenant admin INSTALLS an approved listing by CONSENTING to the exact scopes
-- the listing requests. The install atomically: mints an install-bound API key
-- (api_keys, 20261086) carrying exactly those scopes; records one ENTITLEMENT
-- per scope; optionally creates an org webhook_endpoint (20261087) bound to the
-- install so the partner's webhooks route to it; and audits the event.
-- UNINSTALL revokes the entitlement rows AND the bound key AND pauses the
-- endpoint. All lifecycle runs through service-role RPCs — the tables carry NO
-- tenant write policy at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CROSS-TENANT ISOLATION — an install of org A can never reach org B.
-- ─────────────────────────────────────────────────────────────────────────────
-- The bound key is pinned by a COMPOSITE FK (api_key_id, org_id) →
-- api_keys(id, org_id): a key from another org is structurally unrepresentable
-- as an install's credential — for EVERY role including service_role. Every
-- child (entitlements) binds (install_id, org_id) → marketplace_installs(id,
-- org_id) the same way. The optional webhook endpoint's same-org binding is
-- enforced by the install trigger (a single-column SET NULL FK cannot carry
-- org_id, so a trigger checks it instead). RLS is admin-only per org; the RPCs
-- pin every write to the p_org_id the action proved admin of.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE CONSENT GATE — exact scopes, server-authoritative.
-- ─────────────────────────────────────────────────────────────────────────────
-- marketplace_install_with_consent reads the listing's requested_scopes from
-- the row (never trusts the client's claim of what was requested) and REFUSES
-- unless (a) the listing is approved and (b) the tenant's consented set EQUALS
-- the requested set. The bound key + entitlements are minted from the listing's
-- requested_scopes, so a tenant can neither escalate beyond nor silently
-- under-grant what it consented to. Mirrors lib/marketplace/registry.ts
-- validateInstallConsent (defence in depth; pinned by __tests__/marketplace).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- All FKs on the cascade path are ON DELETE CASCADE (org teardown deletes
-- installs + entitlements + keys + endpoints independently by org_id); the only
-- SET NULL edges are single-column and point at users / webhook_endpoints.
-- BEFORE-trigger guards write nothing and cannot fire during a delete cascade.

-- ── 1. marketplace_installs ──────────────────────────────────────────────────
create table if not exists public.marketplace_installs (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,

  -- The installed listing (a GLOBAL object — deliberately NOT org-pinned: many
  -- tenants install one listing). CASCADE so a removed listing removes installs.
  listing_id          uuid not null references public.marketplace_listings(id) on delete cascade,

  status              text not null default 'active'
    check (status in ('active', 'suspended', 'uninstalled')),

  -- THE INSTALL-BOUND CREDENTIAL. Composite FK pins it to the SAME org — a key
  -- from another tenant is structurally impossible here. CASCADE mirrors
  -- webhook_deliveries: org teardown removes both; a key is otherwise never
  -- deleted (revoked, not erased), so this only fires under teardown.
  api_key_id          uuid not null,
  constraint marketplace_installs_key_org_fkey
    foreign key (api_key_id, org_id)
    references public.api_keys (id, org_id) on delete cascade,

  -- Optional install-bound webhook endpoint (same org, enforced by the trigger
  -- below; a single-column SET NULL FK cannot carry org_id). Deleting the
  -- endpoint merely unlinks it — the app stays installed but stops receiving
  -- webhooks.
  webhook_endpoint_id uuid references public.webhook_endpoints(id) on delete set null,

  -- The EXACT scopes the tenant consented to (== the listing's requested_scopes
  -- at install time). The bound key + entitlements are minted from these.
  consented_scopes    text[] not null default '{}'
    check (array_position(consented_scopes, null) is null
           and array_position(consented_scopes, '') is null),
  consented_by        uuid references public.users(id) on delete set null,
  consented_at        timestamptz not null default now(),

  -- Partner-specific per-install CONFIG (non-secret; the credential is the bound
  -- key). Redacted-at-export handles any secret-named nested key defensively.
  config              jsonb not null default '{}'::jsonb,

  installed_at        timestamptz not null default now(),
  uninstalled_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Candidate key so children bind (install_id, org_id).
  constraint marketplace_installs_id_org_key unique (id, org_id)
);

comment on table public.marketplace_installs is
  'A tenant''s install of a marketplace listing (Phase 14). Binds an install-scoped api_keys row via a composite (api_key_id, org_id) FK — same-org isolation is structural. Lifecycle is service-role RPC only (no tenant write policy). Org-scoped (DSAR).';

create index if not exists marketplace_installs_org_idx
  on public.marketplace_installs (org_id, created_at desc);
create index if not exists marketplace_installs_listing_idx
  on public.marketplace_installs (listing_id, created_at desc);
-- At most one LIVE (active|suspended) install per (org, listing); uninstalled
-- rows stay as audit trail and don't block a reinstall.
create unique index if not exists marketplace_installs_one_live_idx
  on public.marketplace_installs (org_id, listing_id)
  where status <> 'uninstalled';

-- ── 2. marketplace_entitlements ──────────────────────────────────────────────
create table if not exists public.marketplace_entitlements (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,

  install_id   uuid not null,
  -- ORG BINDING: an entitlement can never name another tenant's install.
  constraint marketplace_entitlements_install_org_fkey
    foreign key (install_id, org_id)
    references public.marketplace_installs (id, org_id) on delete cascade,

  -- One granted public-API scope (validated app-layer against SCOPES). Non-blank.
  scope        text not null check (btrim(scope) <> ''),
  status       text not null default 'active' check (status in ('active', 'revoked')),
  granted_at   timestamptz not null default now(),
  revoked_at   timestamptz,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint marketplace_entitlements_install_scope_key unique (install_id, scope),
  constraint marketplace_entitlements_id_org_key unique (id, org_id)
);

comment on table public.marketplace_entitlements is
  'One row per scope an install is entitled to (Phase 14). Granted at consent, flipped to revoked at uninstall. Org-pinned via a composite FK to marketplace_installs(id, org_id). Org-scoped (DSAR).';

create index if not exists marketplace_entitlements_install_idx
  on public.marketplace_entitlements (install_id, status);
create index if not exists marketplace_entitlements_org_idx
  on public.marketplace_entitlements (org_id, created_at desc);

drop trigger if exists marketplace_installs_set_updated_at on public.marketplace_installs;
create trigger marketplace_installs_set_updated_at before update on public.marketplace_installs
  for each row execute function public.tg_set_updated_at();

drop trigger if exists marketplace_entitlements_set_updated_at on public.marketplace_entitlements;
create trigger marketplace_entitlements_set_updated_at before update on public.marketplace_entitlements
  for each row execute function public.tg_set_updated_at();

-- ── 3. Install integrity guard (every role) ──────────────────────────────────
-- Freeze org/listing/key binding; verify the optional webhook endpoint is
-- same-org (the single-column FK cannot); make uninstall terminal.
create or replace function public.tg_marketplace_installs_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_ep_org uuid;
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id
       or new.listing_id is distinct from old.listing_id
       or new.api_key_id is distinct from old.api_key_id then
      raise exception 'marketplace_installs org/listing/key binding is immutable'
        using errcode = 'check_violation';
    end if;
    if old.status = 'uninstalled' and new.status is distinct from old.status then
      raise exception 'install % is uninstalled — that is terminal', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  -- Same-org webhook endpoint (INSERT + UPDATE).
  if new.webhook_endpoint_id is not null then
    select org_id into v_ep_org from public.webhook_endpoints where id = new.webhook_endpoint_id;
    if v_ep_org is null or v_ep_org <> new.org_id then
      raise exception 'webhook endpoint must belong to the same org as the install'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists marketplace_installs_guard on public.marketplace_installs;
create trigger marketplace_installs_guard
  before insert or update on public.marketplace_installs
  for each row execute function public.tg_marketplace_installs_guard();

-- ── 4. RLS — admin-only READ; NO tenant write (RPCs own every mutation) ──────
alter table public.marketplace_installs enable row level security;
alter table public.marketplace_entitlements enable row level security;

-- Admin-only select (an install is an egress + a credential). Deliberately no
-- insert/update/delete policy: RLS default-denies writes, and the grants below
-- revoke them as a second lock. The install/uninstall RPCs (service role) are
-- the only writers.
drop policy if exists "marketplace_installs: admins select" on public.marketplace_installs;
create policy "marketplace_installs: admins select" on public.marketplace_installs
  for select to authenticated using (public.is_org_admin(org_id));

drop policy if exists "marketplace_entitlements: admins select" on public.marketplace_entitlements;
create policy "marketplace_entitlements: admins select" on public.marketplace_entitlements
  for select to authenticated using (public.is_org_admin(org_id));

revoke all on table public.marketplace_installs from anon;
revoke all on table public.marketplace_entitlements from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketplace_installs from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketplace_entitlements from authenticated;

-- ── 5. marketplace_install_with_consent — the atomic, consent-gated install ──
-- Called by the install action through the SERVICE-ROLE client AFTER the action
-- has proved the caller is an org admin (RLS on api_keys/webhook_endpoints is
-- the tenant-side authority; this RPC is the atomic writer). The plaintext key
-- is generated in TS (lib/api-auth/keygen) and only its hash/prefix arrive here.
--
-- Server-authoritative consent: requested_scopes come from the LISTING row, not
-- the client. Refuses unless the listing is approved AND the consented set
-- equals the requested set. Everything (key, endpoint, install, entitlements,
-- audit) happens in ONE transaction.
create or replace function public.marketplace_install_with_consent(
  p_org_id           uuid,
  p_listing_id       uuid,
  p_consented_scopes text[],
  p_key_name         text,
  p_key_prefix       text,
  p_key_hash         text,
  p_created_by       uuid,
  p_config           jsonb default '{}'::jsonb,
  p_webhook_secret   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status   text;
  v_req      text[];
  v_wh_url   text;
  v_wh_events text[];
  v_key_id   uuid;
  v_ep_id    uuid;
  v_install  uuid;
  v_scope    text;
begin
  -- 1. Load the listing (source of truth for requested scopes + webhook).
  select status, requested_scopes, webhook_url, webhook_events
    into v_status, v_req, v_wh_url, v_wh_events
  from public.marketplace_listings
  where id = p_listing_id;

  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'unknown_listing');
  end if;

  -- 2. THE REVIEW GATE.
  if v_status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'not_installable');
  end if;

  -- 3. THE CONSENT GATE — consented set MUST equal the listing's requested set
  --    (order/dup-insensitive), and must be non-empty.
  if coalesce(array_length(v_req, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'error', 'listing_requests_no_scopes');
  end if;
  if not (p_consented_scopes <@ v_req and v_req <@ p_consented_scopes) then
    return jsonb_build_object('ok', false, 'error', 'scope_mismatch');
  end if;

  -- 4. One live install per (org, listing) — the partial unique index also
  --    guards this; check first for a clean error.
  if exists (
    select 1 from public.marketplace_installs
    where org_id = p_org_id and listing_id = p_listing_id and status <> 'uninstalled'
  ) then
    return jsonb_build_object('ok', false, 'error', 'already_installed');
  end if;

  -- 5. Mint the install-bound key (scopes = the listing's requested set).
  insert into public.api_keys (org_id, name, key_prefix, key_hash, scopes, created_by)
  values (p_org_id, p_key_name, p_key_prefix, p_key_hash, v_req, p_created_by)
  returning id into v_key_id;

  -- 6. Optional webhook endpoint bound to the install (same org). Born paused;
  --    the existing verify-before-event ping promotes it on first 2xx.
  if v_wh_url is not null and p_webhook_secret is not null then
    insert into public.webhook_endpoints
      (org_id, url, description, secret, event_verbs, status, created_by)
    values (
      p_org_id, v_wh_url,
      'Marketplace install ' || p_listing_id::text,
      p_webhook_secret, coalesce(v_wh_events, '{}'), 'paused', p_created_by)
    returning id into v_ep_id;

    perform public.webhook_enqueue_ping(v_ep_id, p_org_id);
  end if;

  -- 7. The install row (binds the key + endpoint).
  insert into public.marketplace_installs
    (org_id, listing_id, status, api_key_id, webhook_endpoint_id,
     consented_scopes, consented_by, consented_at, config, installed_at)
  values
    (p_org_id, p_listing_id, 'active', v_key_id, v_ep_id,
     v_req, p_created_by, now(), coalesce(p_config, '{}'::jsonb), now())
  returning id into v_install;

  -- 8. One entitlement per consented scope.
  foreach v_scope in array v_req loop
    insert into public.marketplace_entitlements (org_id, install_id, scope, status, granted_at)
    values (p_org_id, v_install, v_scope, 'active', now());
  end loop;

  -- 9. Audit.
  perform public._record_activity(
    p_org_id, 'marketplace.installed', 'marketplace_installs', v_install,
    jsonb_build_object('listing_id', p_listing_id, 'api_key_id', v_key_id,
                       'scopes', to_jsonb(v_req)));

  return jsonb_build_object(
    'ok', true,
    'install_id', v_install,
    'api_key_id', v_key_id,
    'webhook_endpoint_id', v_ep_id);
end $$;

revoke all on function public.marketplace_install_with_consent(uuid, uuid, text[], text, text, text, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.marketplace_install_with_consent(uuid, uuid, text[], text, text, text, uuid, jsonb, text)
  to service_role;

-- ── 6. marketplace_uninstall — revoke entitlements + the bound key ───────────
-- Called by the uninstall action through the service-role client after proving
-- the caller is an org admin. Org-pinned to p_org_id. Stamps the install
-- terminal, REVOKES the bound key (final via the api_keys trigger), REVOKES
-- every active entitlement, and PAUSES the webhook endpoint so real events stop
-- routing to the uninstalled app. Idempotent-ish: a second call finds nothing.
create or replace function public.marketplace_uninstall(
  p_org_id     uuid,
  p_install_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key_id uuid;
  v_ep_id  uuid;
  v_ents   integer;
begin
  select api_key_id, webhook_endpoint_id into v_key_id, v_ep_id
  from public.marketplace_installs
  where id = p_install_id and org_id = p_org_id and status <> 'uninstalled';

  if v_key_id is null and v_ep_id is null and not exists (
    select 1 from public.marketplace_installs
    where id = p_install_id and org_id = p_org_id and status <> 'uninstalled'
  ) then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  -- Terminal install.
  update public.marketplace_installs
     set status = 'uninstalled', uninstalled_at = now(), updated_at = now()
   where id = p_install_id and org_id = p_org_id;

  -- Pause the install's webhook endpoint FIRST (fan-out targets active
  -- endpoints only), so real events stop routing to the removed app.
  if v_ep_id is not null then
    update public.webhook_endpoints
       set status = 'paused', updated_at = now()
     where id = v_ep_id and org_id = p_org_id and status = 'active';
  end if;

  -- Kill the bound key (org-pinned; set-once-final via the api_keys trigger).
  update public.api_keys
     set revoked_at = now()
   where id = v_key_id and org_id = p_org_id and revoked_at is null;

  -- Turn off every active entitlement.
  update public.marketplace_entitlements
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where install_id = p_install_id and org_id = p_org_id and status = 'active';
  get diagnostics v_ents = row_count;

  perform public._record_activity(
    p_org_id, 'marketplace.uninstalled', 'marketplace_installs', p_install_id,
    jsonb_build_object('api_key_id', v_key_id, 'revoked_entitlements', v_ents));

  return jsonb_build_object('ok', true, 'revoked_key', v_key_id, 'revoked_entitlements', v_ents);
end $$;

revoke all on function public.marketplace_uninstall(uuid, uuid) from public, anon, authenticated;
grant execute on function public.marketplace_uninstall(uuid, uuid) to service_role;
