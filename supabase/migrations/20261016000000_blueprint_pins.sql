-- Blueprint Pins (Programme B) — operational annotations that anchor a point on
-- an immutable blueprint revision to a CrewFlow entity (a snag) or a free note.
--
-- This migration is self-contained: it depends only on baseline objects
-- (organizations, jobs, users, current_org_ids, is_org_admin, tg_set_updated_at)
-- plus blueprints/blueprint_versions/snags. It adds NO storage bucket (pins are
-- coordinates, not files) and touches none of the 20261008–20261015 sibling
-- branches' slots. Next free slot after this is 20261016000100.
--
-- Design doctrine (verified against the codebase, not memory):
--   * Anchor = blueprint_version_id (the IMMUTABLE revision), never the parent
--     drawing + "current version". Re-issuing a drawing must NOT relocate pins
--     onto a different sheet (a construction-safety defect). Mirrors the
--     blueprint_versions immutability doctrine (20261015000000_blueprints.sql).
--   * Coordinates = normalized (u,v) in [0,1] of the sheet's page box, 1-based
--     page_number. Stable across zoom/pan/DPR/resize; identical model that a
--     later markup layer + revision-compare will reuse.
--   * Tenant integrity = composite FK (col, org_id) -> parent(id, org_id),
--     enforced by Postgres for EVERY role incl. service_role — the only thing
--     that stops "org A pin -> org B entity" (RLS guards only the row written,
--     never the row it points at). Doctrine: 20260911000000_invoice_payments.
--   * org_id/job_id are DERIVED from the parent version in a before-write
--     trigger; client-sent values are ignored (anti-spoof), exactly like
--     blueprint_versions.org_id.
--   * Cross-JOB rule (a linked entity must belong to this drawing's job) is a
--     trigger, not a static FK: snags.job_id is nullable, so a composite FK on
--     job_id would wrongly reject pinning a not-yet-jobbed snag and fight its
--     ON DELETE SET NULL.

-- ---------------------------------------------------------------------------
-- 1. Candidate keys on the parents so composite FKs have a target.
--    `id` is already PRIMARY KEY on each, so unique(id, org_id) grants no new
--    uniqueness and rejects nothing — it exists solely as an FK target. Exactly
--    the additive pattern used for invoices_id_org_key / customers_id_org_key.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_versions_id_org_key') then
    alter table public.blueprint_versions
      add constraint blueprint_versions_id_org_key unique (id, org_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'snags_id_org_key') then
    alter table public.snags
      add constraint snags_id_org_key unique (id, org_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The pins table.
-- ---------------------------------------------------------------------------
create table if not exists public.blueprint_pins (
  id                    uuid primary key default gen_random_uuid(),
  -- Tenancy — DERIVED from the parent version by the before-write trigger.
  org_id                uuid not null,
  job_id                uuid not null,
  -- Anchor: the immutable revision + 1-based sheet + normalized point.
  blueprint_version_id  uuid not null,
  page_number           integer not null default 1 check (page_number >= 1),
  u                     double precision not null check (u >= 0 and u <= 1),
  v                     double precision not null check (v >= 0 and v <= 1),
  -- What the pin represents. Extend this CHECK additively as new link targets
  -- gain first-class tables (site_report / diary / toolbox / document / task).
  kind                  text not null check (kind in ('snag', 'note')),
  title                 text check (title is null or char_length(title) <= 120),
  note                  text check (note is null or char_length(note) <= 2000),
  -- Typed nullable link columns (one composite FK each). Add columns, never
  -- redesign, when a new target lands.
  snag_id               uuid,
  created_by            uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Version anchor + cross-tenant integrity (declarative, every role).
  constraint blueprint_pins_version_org_fkey
    foreign key (blueprint_version_id, org_id)
    references public.blueprint_versions (id, org_id) on delete cascade,

  -- Snag link + cross-tenant integrity. MATCH SIMPLE: only checked when
  -- snag_id is non-null. ON DELETE CASCADE: deleting a snag removes its marker
  -- (the pin has no meaning without its snag) — no dangling rows, no cleanup.
  constraint blueprint_pins_snag_org_fkey
    foreign key (snag_id, org_id)
    references public.snags (id, org_id) on delete cascade,

  -- kind <-> payload consistency, enforced by Postgres:
  --   snag pin  => links a snag, carries no free note (the snag holds the text)
  --   note pin  => no link, must carry note text
  constraint blueprint_pins_kind_payload check (
    (kind = 'snag' and snag_id is not null and note is null) or
    (kind = 'note' and snag_id is null     and note is not null)
  )
);

comment on table public.blueprint_pins is
  'Operational pins anchored to an immutable blueprint_version at a normalized (u,v) point; links to a snag or carries a free note. Programme B.';

-- Read path: "all pins on this sheet of this revision" (the viewer's query).
create index if not exists blueprint_pins_render_idx
  on public.blueprint_pins (org_id, blueprint_version_id, page_number);
-- Reverse lookup: "does this snag have a pin / where is it".
create index if not exists blueprint_pins_snag_idx
  on public.blueprint_pins (snag_id) where snag_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Anti-spoof derivation + cross-job guard (before insert OR update).
--    SECURITY DEFINER + pinned search_path. Derives org_id/job_id from the
--    parent version's blueprint (client values ignored) and rejects a link to
--    an entity that belongs to a different job.
-- ---------------------------------------------------------------------------
create or replace function public.tg_blueprint_pin_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_job uuid;
  v_snag_job uuid;
begin
  -- Resolve tenancy from the immutable version -> its drawing.
  select b.org_id, b.job_id
    into v_org, v_job
  from public.blueprint_versions bv
  join public.blueprints b on b.id = bv.blueprint_id
  where bv.id = new.blueprint_version_id;

  if v_org is null then
    raise exception 'blueprint version % does not exist', new.blueprint_version_id
      using errcode = 'foreign_key_violation';
  end if;

  -- Client-sent tenancy is ignored: the parent version is authoritative.
  new.org_id := v_org;
  new.job_id := v_job;

  -- Cross-job rule: if the linked snag names a job, it must be THIS job.
  if new.snag_id is not null then
    select job_id into v_snag_job from public.snags where id = new.snag_id;
    if v_snag_job is not null and v_snag_job is distinct from v_job then
      raise exception 'pin links a snag from a different job (% vs %)', v_snag_job, v_job
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists blueprint_pins_before_write on public.blueprint_pins;
create trigger blueprint_pins_before_write
  before insert or update on public.blueprint_pins
  for each row execute function public.tg_blueprint_pin_before_write();

drop trigger if exists blueprint_pins_set_updated_at on public.blueprint_pins;
create trigger blueprint_pins_set_updated_at
  before update on public.blueprint_pins
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS — operator-only, tenant-scoped. Members read/create/move; hard delete
--    is admin-only (members re-place rather than delete), mirroring snags.
-- ---------------------------------------------------------------------------
alter table public.blueprint_pins enable row level security;

create policy "blueprint_pins: members select" on public.blueprint_pins
  for select using (org_id in (select public.current_org_ids()));
create policy "blueprint_pins: members insert" on public.blueprint_pins
  for insert with check (org_id in (select public.current_org_ids()));
create policy "blueprint_pins: members update" on public.blueprint_pins
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy "blueprint_pins: admins delete" on public.blueprint_pins
  for delete using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- 5. Atomic "create a snag AND its pin" in one transaction.
--    SECURITY INVOKER: every insert runs under the caller's RLS, so a member
--    can only create within their own org, and tenancy is derived from the
--    (RLS-readable) version — never from a caller-supplied org. If the pin
--    insert fails, the snag insert rolls back with it (no orphaned snag).
-- ---------------------------------------------------------------------------
create or replace function public.create_blueprint_pin_with_snag(
  p_blueprint_version_id uuid,
  p_page_number          integer,
  p_u                    double precision,
  p_v                    double precision,
  p_pin_title            text,
  p_snag_title           text,
  p_snag_description     text,
  p_snag_priority        text,
  p_snag_location        text
) returns public.blueprint_pins
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org  uuid;
  v_job  uuid;
  v_snag uuid;
  v_pin  public.blueprint_pins;
begin
  -- RLS-scoped read: a caller who can't see the version gets NULL -> raise.
  select b.org_id, b.job_id
    into v_org, v_job
  from public.blueprint_versions bv
  join public.blueprints b on b.id = bv.blueprint_id
  where bv.id = p_blueprint_version_id;

  if v_org is null then
    raise exception 'blueprint version not found or not permitted'
      using errcode = 'foreign_key_violation';
  end if;

  insert into public.snags (org_id, job_id, title, description, priority, location, status, reported_by)
  values (
    v_org, v_job,
    p_snag_title,
    nullif(btrim(coalesce(p_snag_description, '')), ''),
    coalesce(nullif(p_snag_priority, ''), 'medium'),
    nullif(btrim(coalesce(p_snag_location, '')), ''),
    'open',
    auth.uid()
  )
  returning id into v_snag;

  insert into public.blueprint_pins (blueprint_version_id, page_number, u, v, kind, title, snag_id, created_by)
  values (
    p_blueprint_version_id, p_page_number, p_u, p_v, 'snag',
    nullif(btrim(coalesce(p_pin_title, '')), ''),
    v_snag,
    auth.uid()
  )
  returning * into v_pin;

  return v_pin;
end $$;

revoke all on function public.create_blueprint_pin_with_snag(uuid, integer, double precision, double precision, text, text, text, text, text) from public;
grant execute on function public.create_blueprint_pin_with_snag(uuid, integer, double precision, double precision, text, text, text, text, text) to authenticated;
