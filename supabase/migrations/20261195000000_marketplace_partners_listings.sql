-- Marketplace / partner platform (Phase 14) — PART 1: partners + listings.
-- SUBSTRATE, BUILT DARK (NEXT gate: FEATURE_MARKETPLACE + external partner
-- onboarding). Additive, org-teardown-safe.
--
-- A developer/partner (owned by a CrewFlow org) publishes an app LISTING that
-- REQUESTS a set of public-API scopes (lib/api-auth/scopes.ts — the marketplace
-- invents NO new scope) and optionally an outbound webhook. A listing is
-- DISCOVERABLE + INSTALLABLE only once a PLATFORM REVIEWER approves it. Part 2
-- (20261196000000) adds installs + entitlements + the consent-gated install RPC
-- that mints an install-bound API key and routes webhooks to the install.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE REVIEW / APPROVAL GATE — a tenant can NEVER self-approve.
-- ─────────────────────────────────────────────────────────────────────────────
-- Listing.status is draft|pending_review|approved|rejected|suspended. The
-- developer (an admin of the OWNING org) may edit a draft's metadata and submit
-- it for review (draft → pending_review) through a SECURITY DEFINER RPC that
-- checks is_org_admin of the owner org. Reaching approved/rejected/suspended is
-- a REVIEW decision made ONLY through marketplace_review_listing, which is
-- granted to service_role and NOTHING else — there is no reviewer surface in
-- this repo (platform review is external/dark). Two independent locks make
-- self-approval unrepresentable for the authenticated role:
--   (a) `status` is NOT in the authenticated UPDATE column grant — a tenant
--       cannot write the column via PostgREST at all; and
--   (b) a BEFORE UPDATE trigger enforces the legal status transition graph for
--       EVERY role, so even a raw/service path cannot jump draft → approved.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DISCOVERY — approved listings are a PUBLIC catalogue (cross-org by design).
-- ─────────────────────────────────────────────────────────────────────────────
-- A listing is a global marketplace object, NOT tenant data: any authenticated
-- user may SELECT an APPROVED listing (that is the browse catalogue). The owning
-- org's admins may additionally SELECT their own listings in ANY status (to
-- manage them). Listings carry no org_id — ownership is resolved through the
-- partner — so they are deliberately NOT an org-scoped (DSAR) table.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TEARDOWN SAFETY (the 20261052 lesson)
-- ─────────────────────────────────────────────────────────────────────────────
-- Additive; partner.org_id is ON DELETE CASCADE; listing.partner_id is ON DELETE
-- CASCADE; the only SET NULL edges point at public.users. BEFORE UPDATE guards
-- write nothing and cannot fire during a delete cascade. Fresh CREATE only.

-- ── 1. marketplace_partners ──────────────────────────────────────────────────
create table if not exists public.marketplace_partners (
  id           uuid primary key default gen_random_uuid(),
  -- Owner org: the CrewFlow org that owns this developer identity. This IS an
  -- org_id column, so the table is an org-scoped (DSAR) table — registered in
  -- lib/gdpr/org-tables.json.
  org_id       uuid not null references public.organizations(id) on delete cascade,

  name         text not null check (btrim(name) <> ''),
  -- URL-safe unique handle (mirrors lib/marketplace/registry.ts SLUG_RX).
  slug         text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 63),
  contact_email text,
  website_url  text check (website_url is null or website_url ~ '^https://'),

  status       text not null default 'active' check (status in ('active', 'suspended')),

  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint marketplace_partners_slug_key unique (slug),
  -- Candidate key so any org-scoped child binds (id, org_id), never id alone.
  constraint marketplace_partners_id_org_key unique (id, org_id)
);

comment on table public.marketplace_partners is
  'Marketplace developer/partner identity (Phase 14), owned by a CrewFlow org (org_id). Admin-only manage; the org''s listings hang off it. Org-scoped (DSAR) — exported as the tenant''s own developer profile.';

create index if not exists marketplace_partners_org_idx
  on public.marketplace_partners (org_id, created_at desc);

-- ── 2. marketplace_listings ──────────────────────────────────────────────────
create table if not exists public.marketplace_listings (
  id            uuid primary key default gen_random_uuid(),
  -- Ownership is via the partner (which carries the owner org). No org_id here:
  -- an approved listing is a GLOBAL catalogue object, not tenant data.
  partner_id    uuid not null references public.marketplace_partners(id) on delete cascade,

  slug          text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 63),
  name          text not null check (btrim(name) <> ''),
  short_description text not null check (btrim(short_description) <> '' and char_length(short_description) <= 200),
  description   text,
  category      text not null check (category in (
    'accounting', 'crm', 'field_service', 'scheduling',
    'communications', 'analytics', 'productivity', 'other')),
  logo_url      text check (logo_url is null or logo_url ~ '^https://'),

  -- REQUESTED scopes. VALIDATED IN THE APP LAYER against the public-API SCOPES
  -- registry (lib/api-auth/scopes.ts) — the marketplace adds no scope string.
  -- The DB pins shape only (no NULL/blank; non-empty). These are the scopes a
  -- tenant must consent to EXACTLY at install (Part 2).
  requested_scopes text[] not null default '{}'
    check (array_position(requested_scopes, null) is null
           and array_position(requested_scopes, '') is null),

  -- Optional outbound webhook the listing declares. If webhook_url is set, the
  -- install (Part 2) creates an org webhook_endpoint bound to the install,
  -- subscribed to these verbs (validated app-layer against EXPOSABLE_WEBHOOK_EVENTS).
  webhook_url   text check (webhook_url is null or webhook_url ~ '^https://'),
  webhook_events text[] not null default '{}'
    check (array_position(webhook_events, null) is null
           and array_position(webhook_events, '') is null),

  -- Review lifecycle. See header §1. Only marketplace_review_listing (service
  -- role) reaches approved/rejected/suspended; the submit RPC does draft →
  -- pending_review; the trigger enforces the transition graph for every role.
  status        text not null default 'draft'
    check (status in ('draft', 'pending_review', 'approved', 'rejected', 'suspended')),
  review_notes  text,
  submitted_at  timestamptz,
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.users(id) on delete set null,

  created_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint marketplace_listings_slug_key unique (slug)
);

comment on table public.marketplace_listings is
  'Marketplace app listings (Phase 14). REQUESTS public-API scopes (lib/api-auth/scopes.ts) + an optional webhook. Discoverable + installable ONLY when status=approved; approval is a service-role review decision (marketplace_review_listing) — a tenant can never self-approve (status is not in the authenticated update grant AND the transition trigger forbids it). Not org-scoped: an approved listing is a global catalogue object.';
comment on column public.marketplace_listings.requested_scopes is
  'Requested public-API scopes, validated app-layer against the SCOPES registry. The exact set a tenant consents to at install; the install-bound key is minted with exactly these.';

create index if not exists marketplace_listings_partner_idx
  on public.marketplace_listings (partner_id, created_at desc);
-- Discovery scope: the approved catalogue, newest first.
create index if not exists marketplace_listings_approved_idx
  on public.marketplace_listings (status, created_at desc) where status = 'approved';
create index if not exists marketplace_listings_category_idx
  on public.marketplace_listings (category, created_at desc) where status = 'approved';

drop trigger if exists marketplace_partners_set_updated_at on public.marketplace_partners;
create trigger marketplace_partners_set_updated_at before update on public.marketplace_partners
  for each row execute function public.tg_set_updated_at();

drop trigger if exists marketplace_listings_set_updated_at on public.marketplace_listings;
create trigger marketplace_listings_set_updated_at before update on public.marketplace_listings
  for each row execute function public.tg_set_updated_at();

-- ── 3. Listing integrity + status-transition guard (every role) ──────────────
-- partner_id + provenance are frozen; status may move only along the legal
-- graph. Enforced for EVERY role so no raw/service path can jump draft →
-- approved. Combined with `status` being absent from the authenticated update
-- grant, a tenant cannot change status at all — only the RPCs can, and only
-- along valid edges.
create or replace function public.tg_marketplace_listings_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.partner_id is distinct from old.partner_id then
    raise exception 'marketplace_listings.partner_id is immutable — a listing never changes owner'
      using errcode = 'check_violation';
  end if;
  if new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'marketplace_listings provenance is immutable'
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    -- Legal transition graph (see header §1).
    if not (
         (old.status = 'draft'          and new.status = 'pending_review')
      or (old.status = 'pending_review' and new.status in ('approved', 'rejected'))
      or (old.status = 'rejected'       and new.status = 'draft')
      or (old.status = 'approved'       and new.status = 'suspended')
      or (old.status = 'suspended'      and new.status = 'approved')
    ) then
      raise exception 'illegal listing status transition % → %', old.status, new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists marketplace_listings_guard on public.marketplace_listings;
create trigger marketplace_listings_guard
  before update on public.marketplace_listings
  for each row execute function public.tg_marketplace_listings_guard();

-- ── 4. RLS ───────────────────────────────────────────────────────────────────
alter table public.marketplace_partners enable row level security;

-- Admin-only manage (a partner identity is a publishing credential). Per-command.
drop policy if exists "marketplace_partners: admins select" on public.marketplace_partners;
create policy "marketplace_partners: admins select" on public.marketplace_partners
  for select to authenticated using (public.is_org_admin(org_id));

drop policy if exists "marketplace_partners: admins insert" on public.marketplace_partners;
create policy "marketplace_partners: admins insert" on public.marketplace_partners
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "marketplace_partners: admins update" on public.marketplace_partners;
create policy "marketplace_partners: admins update" on public.marketplace_partners
  for update to authenticated
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

alter table public.marketplace_listings enable row level security;

-- DISCOVERY: any authenticated user may read an APPROVED listing (public
-- catalogue). The owning org's admins may read their OWN listings in any status.
drop policy if exists "marketplace_listings: discover approved" on public.marketplace_listings;
create policy "marketplace_listings: discover approved" on public.marketplace_listings
  for select to authenticated
  using (
    status = 'approved'
    or exists (
      select 1 from public.marketplace_partners p
      where p.id = marketplace_listings.partner_id
        and public.is_org_admin(p.org_id)
    )
  );

-- Owning-org admins may INSERT (a draft) + UPDATE (draft metadata). The
-- column-level grant below withholds `status`, and the trigger enforces the
-- transition graph, so these writes can never approve a listing.
drop policy if exists "marketplace_listings: owner insert" on public.marketplace_listings;
create policy "marketplace_listings: owner insert" on public.marketplace_listings
  for insert to authenticated
  with check (exists (
    select 1 from public.marketplace_partners p
    where p.id = marketplace_listings.partner_id
      and public.is_org_admin(p.org_id)
  ));

drop policy if exists "marketplace_listings: owner update" on public.marketplace_listings;
create policy "marketplace_listings: owner update" on public.marketplace_listings
  for update to authenticated
  using (exists (
    select 1 from public.marketplace_partners p
    where p.id = marketplace_listings.partner_id
      and public.is_org_admin(p.org_id)
  ))
  with check (exists (
    select 1 from public.marketplace_partners p
    where p.id = marketplace_listings.partner_id
      and public.is_org_admin(p.org_id)
  ));

-- ── 5. Column-level privileges — withhold `status` from tenant writes ────────
-- The review gate: a tenant may edit listing metadata but NEVER the status
-- column. Rebuild grants explicitly (Supabase default-grants ALL). Idempotent.
revoke all on table public.marketplace_partners from anon;
revoke all on table public.marketplace_listings from anon;

revoke update on table public.marketplace_listings from authenticated;
-- Editable metadata ONLY — status/review_* deliberately omitted. Adding a
-- column does NOT make it tenant-writable; it must be granted here by name.
grant update (name, short_description, description, category, logo_url,
              requested_scopes, webhook_url, webhook_events, slug)
  on public.marketplace_listings to authenticated;

-- ── 6. marketplace_submit_listing — draft → pending_review (owner admin) ─────
-- The developer's own submit. SECURITY DEFINER so it can move the withheld
-- `status` column, but it authorises the caller as an admin of the OWNING org
-- first (is_org_admin), and only from draft. Audited into the owner org's feed.
create or replace function public.marketplace_submit_listing(
  p_listing_id uuid,
  p_org_id     uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status text;
begin
  select p.org_id, l.status into v_owner, v_status
  from public.marketplace_listings l
  join public.marketplace_partners p on p.id = l.partner_id
  where l.id = p_listing_id;

  if v_owner is null then
    return false;                       -- unknown listing
  end if;
  if v_owner <> p_org_id or not public.is_org_admin(p_org_id) then
    return false;                       -- not the owner, or not an admin
  end if;
  if v_status <> 'draft' then
    return false;                       -- only a draft may be submitted
  end if;

  update public.marketplace_listings
     set status = 'pending_review', submitted_at = now(), updated_at = now()
   where id = p_listing_id;

  perform public._record_activity(
    p_org_id, 'marketplace.listing_submitted', 'marketplace_listings', p_listing_id, null);
  return true;
end $$;

revoke all on function public.marketplace_submit_listing(uuid, uuid) from public, anon;
grant execute on function public.marketplace_submit_listing(uuid, uuid) to authenticated;

-- ── 7. marketplace_review_listing — the APPROVAL gate (service role ONLY) ────
-- The platform reviewer's decision. Granted to service_role and NOTHING else —
-- there is no reviewer surface in this repo (review is external/dark). A tenant
-- cannot call it. Enforces the legal transition (pending_review → approved|
-- rejected; approved ↔ suspended) via the same trigger, and audits into the
-- owning org's feed so the developer sees the outcome.
create or replace function public.marketplace_review_listing(
  p_listing_id uuid,
  p_decision   text,      -- 'approved' | 'rejected' | 'suspended'
  p_notes      text default null,
  p_reviewer   uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if p_decision not in ('approved', 'rejected', 'suspended') then
    raise exception 'unknown review decision %', p_decision using errcode = 'check_violation';
  end if;

  select p.org_id into v_owner
  from public.marketplace_listings l
  join public.marketplace_partners p on p.id = l.partner_id
  where l.id = p_listing_id;
  if v_owner is null then
    return false;
  end if;

  -- The transition trigger rejects an illegal edge (e.g. draft → approved).
  update public.marketplace_listings
     set status = p_decision,
         review_notes = p_notes,
         reviewed_at = now(),
         reviewed_by = p_reviewer,
         updated_at = now()
   where id = p_listing_id;

  perform public._record_activity(
    v_owner, 'marketplace.listing_reviewed', 'marketplace_listings', p_listing_id,
    jsonb_build_object('decision', p_decision));
  return true;
end $$;

revoke all on function public.marketplace_review_listing(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_review_listing(uuid, text, text, uuid)
  to service_role;
