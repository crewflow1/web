-- P3 Site — Visitor sign-in / sign-out register (per site).
--
-- Every visitor to a site signs IN on arrival and OUT on departure. The register
-- answers "who is on this site right now who is NOT one of our workers" — the
-- other half of the fire-muster roll (public.site_inductions + time_entries give
-- the workers; this gives the visitors). Reception/site staff operate it, so it
-- is member-writable operational data, NOT append-only evidence like inductions:
-- a visitor row is UPDATED once (to stamp signed_out_at).
--
-- SITE = public.sites, bound by the SAME composite FK + deferred delete rule as
-- site_inductions (20261140000000) so a cross-tenant site_id is unwritable and
-- an org teardown still succeeds.
--
-- Additive, RLS enabled, reversible:
--   drop table if exists public.site_visitors;
--   drop function if exists public.tg_site_visitor_validate();
--   drop function if exists public.tg_site_visitor_immutable_identity();

create table if not exists public.site_visitors (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  site_id           uuid not null,

  visitor_name      text not null check (length(trim(visitor_name)) between 1 and 160),
  company           text check (company is null or length(trim(company)) <= 160),
  purpose           text check (purpose is null or length(trim(purpose)) <= 500),
  -- Optional internal host the visitor is here to see.
  host_user_id      uuid references public.users(id) on delete set null,
  -- Vehicles on site matter to a fire officer; a common field on paper logs.
  vehicle_registration text check (vehicle_registration is null or length(trim(vehicle_registration)) <= 16),

  -- The lifecycle. signed_out_at NULL = still on site (the muster reads this).
  signed_in_at      timestamptz not null default now(),
  signed_out_at     timestamptz,
  signed_in_by      uuid references public.users(id) on delete set null,
  signed_out_by     uuid references public.users(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Cannot sign out before signing in.
  check (signed_out_at is null or signed_out_at >= signed_in_at),

  -- Cross-tenant integrity — identical control to site_inductions (see its header).
  constraint site_visitors_site_org_fkey
    foreign key (site_id, org_id)
    references public.sites (id, org_id)
    on delete no action deferrable initially deferred
);

-- The muster read: who is CURRENTLY on this site (signed_out_at is null),
-- newest arrival first. Partial so the index stays small (signed-out rows are
-- history, not muster).
create index if not exists site_visitors_on_site_idx
  on public.site_visitors (org_id, site_id, signed_in_at desc)
  where signed_out_at is null;
-- The full register (history) for a site, and the org-wide list.
create index if not exists site_visitors_site_idx
  on public.site_visitors (org_id, site_id, signed_in_at desc);

drop trigger if exists site_visitors_set_updated_at on public.site_visitors;
create trigger site_visitors_set_updated_at before update on public.site_visitors
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Validate + org-derive (BEFORE INSERT). org_id resolved from the SITE (spoof
-- proof), host/recorder membership checked. SECURITY DEFINER to read the site's
-- true org past the caller's RLS.
-- ---------------------------------------------------------------------------
create or replace function public.tg_site_visitor_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s_org uuid;
begin
  select org_id into s_org from public.sites where id = new.site_id;
  if s_org is null then
    raise exception 'site % not found', new.site_id;
  end if;
  new.org_id := s_org;

  -- An internal host (if named) must belong to the site's org — a host from
  -- another tenant would be a cross-tenant reference.
  if new.host_user_id is not null
     and not exists (select 1 from public.memberships where org_id = s_org and user_id = new.host_user_id) then
    raise exception 'host is not a member of this organisation';
  end if;
  if new.signed_in_by is not null
     and not exists (select 1 from public.memberships where org_id = s_org and user_id = new.signed_in_by) then
    raise exception 'sign-in recorder is not a member of this organisation';
  end if;

  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_site_visitor_validate on public.site_visitors;
create trigger tg_site_visitor_validate
  before insert on public.site_visitors
  for each row execute function public.tg_site_visitor_validate();

-- ---------------------------------------------------------------------------
-- Identity is immutable across the row's life (BEFORE UPDATE): a sign-out (or a
-- correction to purpose/company) must never silently re-home a visitor onto
-- another site or another org, and the arrival stamp is a fact. Everything else
-- (signed_out_at, signed_out_by, purpose, company, host, vehicle) may change.
-- ---------------------------------------------------------------------------
create or replace function public.tg_site_visitor_immutable_identity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.site_id is distinct from old.site_id
     or new.signed_in_at is distinct from old.signed_in_at then
    raise exception 'a visitor record cannot change site, org or arrival time';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tg_site_visitor_immutable_identity on public.site_visitors;
create trigger tg_site_visitor_immutable_identity
  before update on public.site_visitors
  for each row execute function public.tg_site_visitor_immutable_identity();

-- ---------------------------------------------------------------------------
-- RLS — org members read + insert + update (reception/site staff run the log).
-- Admin-only delete: an erroneous sign-in (a typo, a test row) needs correcting,
-- and GDPR erasure of a named visitor is an admin act; ordinary sign-out is an
-- UPDATE, never a delete. Every write is org-scoped; the validate trigger pins
-- org_id from the site regardless.
-- ---------------------------------------------------------------------------
alter table public.site_visitors enable row level security;

create policy site_visitors_select on public.site_visitors
  for select using (org_id in (select public.current_org_ids()));
create policy site_visitors_insert on public.site_visitors
  for insert with check (public.is_org_member(org_id));
create policy site_visitors_update on public.site_visitors
  for update using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
create policy site_visitors_delete on public.site_visitors
  for delete using (public.is_org_admin(org_id));

comment on table public.site_visitors is
  'Per-site visitor sign-in/out register (public.sites). Member-writable operational data; signed_out_at NULL = on site now (feeds the fire muster). Org-derived from the site, identity immutable on update. See 20261140000001 header.';
