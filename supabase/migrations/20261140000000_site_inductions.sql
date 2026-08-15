-- P3 Site — Site Inductions (the gate that puts a worker onto a site).
--
-- A worker (employee OR external subcontractor operative) confirms "I have
-- received and understood the induction for THIS site". The record is the
-- evidence that answers who, WHICH SITE, which induction version, when, and —
-- optionally — carries their drawn signature. It must be immutable once
-- written, exactly like the RAMS/permit operative sign-off it is modelled on
-- (public.safety_acknowledgements, 20261020000000).
--
-- WHY A NEW TABLE, NOT safety_acknowledgements. safety_acknowledgements is
-- keyed to a polymorphic DOCUMENT subject (risk_assessment / permit_to_work /
-- toolbox_talk) and can only be signed by an AUTHENTICATED user AS THEMSELVES
-- (RLS `user_id = auth.uid()`, and its trigger forbids signing on another
-- worker's behalf). A site induction is a different shape of evidence:
--   * the subject is a SITE (public.sites), not an H&S document;
--   * the inductee is often an EXTERNAL operative with no CrewFlow login, so it
--     is RECORDED BY a supervisor on their behalf (a name + firm), never
--     self-signed — the exact thing safety_acknowledgements refuses;
--   * it carries site-induction specifics (an expiry / re-induction window)
--     that the document acknowledgement has no column for.
-- So this reuses the append-only + trigger-derived-org + immutable-on-update
-- DISCIPLINE of safety_acknowledgements, in a table whose shape is honest about
-- being a per-site, supervisor-operated register.
--
-- SITE = public.sites (the company location register, 20261061000000). `sites`
-- gained the composite candidate key `sites_id_org_key` (unique (id, org_id))
-- in 20261064000000_stock_movements.sql, so this table binds to it with a
-- COMPOSITE FK `references public.sites (id, org_id)` — the strongest possible
-- cross-tenant guarantee (a poisoned site_id pointing at another tenant's site
-- is structurally unwritable), the same control stock_movements uses.
--
-- Additive, RLS enabled, reversible:
--   drop table if exists public.site_inductions;
--   drop function if exists public.tg_site_induction_validate();
--   drop function if exists public.tg_site_induction_no_update();

create table if not exists public.site_inductions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  site_id            uuid not null,

  -- The inductee, in EXACTLY ONE of two forms (the CHECK below enforces XOR):
  --   * user_id       — an internal worker with a CrewFlow login + membership.
  --   * person_name   — an external operative (subcontractor) with no login.
  -- We keep the row if an internal worker later leaves (on delete restrict —
  -- evidence must survive, a worker with inductions can't be hard-deleted out
  -- from under them), mirroring safety_acknowledgements.user_id.
  user_id            uuid references public.users(id) on delete restrict,
  person_name        text check (person_name is null or length(trim(person_name)) between 1 and 160),
  person_company     text check (person_company is null or length(trim(person_company)) <= 160),

  -- The version anchor: the induction pack / briefing version in force when the
  -- worker was inducted. Re-issuing the site induction (a new version) leaves
  -- this record historical and requires the worker to be re-inducted.
  induction_version  text not null check (length(trim(induction_version)) between 1 and 60),
  inducted_at        timestamptz not null default now(),
  -- Optional re-induction window. NULL = no expiry. When set and in the past,
  -- the induction no longer gates the worker on (see lib/site-compliance/muster).
  valid_until        timestamptz,

  -- The exact wording attested to + its version, and the typed-name attestation
  -- (the worker's name, whoever physically signs the pad).
  statement          text not null check (length(trim(statement)) > 0),
  statement_version  text not null default 'v1',
  signed_name        text not null check (length(trim(signed_name)) between 1 and 160),

  -- Optional drawn signature (P2 e-signature capture) + provenance, set ON
  -- INSERT only. Stored in the private `signatures` bucket under an org-first
  -- key; the CHECK below is the DB half of that org-first invariant.
  signature_image_bucket text,
  signature_image_path   text,
  ip_hash            text,
  user_agent         text,

  -- Who recorded the induction (the supervisor running the gate). Bound to the
  -- authenticated session by the validate trigger.
  created_by         uuid references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),

  -- Exactly one inductee identity.
  constraint site_inductions_one_identity check (
    (user_id is not null and person_name is null)
    or (user_id is null and person_name is not null)
  ),

  -- Cross-tenant integrity: the site MUST be in this org. Composite FK to the
  -- candidate key sites_id_org_key. `on delete no action deferrable initially
  -- deferred` mirrors stock_movements_site_org_fkey: a standalone attempt to
  -- delete a site that still has induction evidence is REFUSED at commit
  -- (evidence is protected), while an org teardown — which deletes the org, its
  -- sites AND these rows in one statement — still succeeds because the check is
  -- deferred to commit when every referencing row is already gone.
  constraint site_inductions_site_org_fkey
    foreign key (site_id, org_id)
    references public.sites (id, org_id)
    on delete no action deferrable initially deferred,

  -- Org-first storage path (defence-in-depth, mirrors safety_ack_image_path_org_first).
  -- org_id is trigger-derived in a BEFORE trigger, which runs before CHECKs, so
  -- the constraint sees the authoritative org_id.
  constraint site_inductions_image_path_org_first check (
    signature_image_path is null
    or split_part(signature_image_path, '/', 1) = org_id::text
  )
);

-- One live induction per internal worker, per site, per version — re-recording
-- the same version for the same worker is an idempotent 23505 (the app treats it
-- as success), exactly like safety_ack_unique. External operatives are free text
-- (a name is not a key), so this is a PARTIAL index on the user_id path only.
create unique index if not exists site_inductions_worker_version_unique
  on public.site_inductions (org_id, site_id, user_id, induction_version)
  where user_id is not null;

create index if not exists site_inductions_site_idx
  on public.site_inductions (org_id, site_id, inducted_at desc);
create index if not exists site_inductions_user_idx
  on public.site_inductions (org_id, user_id)
  where user_id is not null;

-- ---------------------------------------------------------------------------
-- Validate + org-derive (BEFORE INSERT). org_id is authoritatively resolved
-- from the SITE so a spoofed org can never cross tenants (the exact idiom of
-- tg_safety_ack_validate). SECURITY DEFINER so it reads the site's TRUE owning
-- org, not the subset RLS exposes to the caller.
-- ---------------------------------------------------------------------------
create or replace function public.tg_site_induction_validate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s_org uuid;
begin
  -- 1. Resolve the site's true org.
  select org_id into s_org from public.sites where id = new.site_id;
  if s_org is null then
    raise exception 'site % not found', new.site_id;
  end if;
  -- org_id is authoritative from the site — a spoofed org can't cross tenants.
  new.org_id := s_org;

  -- 2. An internal inductee must be a member of the site's org.
  if new.user_id is not null
     and not exists (select 1 from public.memberships where org_id = s_org and user_id = new.user_id) then
    raise exception 'inductee is not a member of this organisation';
  end if;

  -- 3. Bind the record to the authenticated session: default the recorder to the
  --    signed-in supervisor when the client omits created_by (the common case),
  --    and reject a supplied created_by that impersonates a different user.
  if new.created_by is null then
    new.created_by := auth.uid();
  elsif auth.uid() is not null and new.created_by is distinct from auth.uid() then
    raise exception 'an induction is recorded by the signed-in supervisor';
  end if;
  -- The recorder (now resolved), when set, must be a member of the site's org.
  if new.created_by is not null
     and not exists (select 1 from public.memberships where org_id = s_org and user_id = new.created_by) then
    raise exception 'recorder is not a member of this organisation';
  end if;

  -- 4. Pin the evidence timestamps server-side — sign time can't be backdated.
  new.inducted_at := now();
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists tg_site_induction_validate on public.site_inductions;
create trigger tg_site_induction_validate
  before insert on public.site_inductions
  for each row execute function public.tg_site_induction_validate();

-- ---------------------------------------------------------------------------
-- Append-only: a signed induction is evidence and can never be edited. Blocks
-- UPDATE even for the service role (RLS alone would not). Re-induction is a NEW
-- row (new version or new valid window), never an edit of the old one.
-- ---------------------------------------------------------------------------
create or replace function public.tg_site_induction_no_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'site inductions are append-only and cannot be modified';
end;
$$;

drop trigger if exists tg_site_induction_no_update on public.site_inductions;
create trigger tg_site_induction_no_update
  before update on public.site_inductions
  for each row execute function public.tg_site_induction_no_update();

-- ---------------------------------------------------------------------------
-- RLS — org members read; org members insert (a supervisor records the gate for
-- workers incl. external operatives). NO update (append-only trigger also blocks
-- it); NO delete of any kind — a signed induction is immutable, non-erasable
-- evidence (GDPR erasure, if ever needed, is a controlled redaction via a future
-- platform path, and org teardown cascades via the org_id FK, never a hard
-- delete here). Unlike safety_acknowledgements the INSERT is NOT `user_id =
-- auth.uid()` — inductions are recorded ON BEHALF OF others (external firms have
-- no login); the validate trigger binds created_by to the session instead.
-- ---------------------------------------------------------------------------
alter table public.site_inductions enable row level security;

create policy site_inductions_select on public.site_inductions
  for select using (org_id in (select public.current_org_ids()));
create policy site_inductions_insert on public.site_inductions
  for insert with check (public.is_org_member(org_id));
-- (No UPDATE or DELETE policy → RLS denies both; the append-only trigger blocks
--  UPDATE even for the service role.)

comment on table public.site_inductions is
  'Append-only site induction evidence: gates a worker (internal user or external operative) onto a public.sites location. Version-anchored, immutable-on-update, org-derived from the site. Models safety_acknowledgements (20261020000000). See 20261140000000 header.';
