-- Blueprint Markup (Programme C) — freehand/vector redlines on an IMMUTABLE
-- blueprint revision. Structural sibling of blueprint_pins (20261016): same
-- immutable version anchor, same normalized [0,1] page-box coordinate model
-- (shared via lib/blueprints/viewer.ts clamp01), same trigger-derived tenancy,
-- same 4-policy RLS. Deliberate divergences:
--   * geometry is a SHAPE — geom {points:[{u,v}...]} + SERVER-derived bbox_*
--     (client bbox is ignored; the trigger recomputes it — anti-spoof);
--   * soft-delete lifecycle (status active/removed + deleted_at) so a MEMBER
--     can retract their own redline via UPDATE; hard DELETE stays admin-only;
--   * no external entity link (no snag_id) => one composite FK, no cross-job rule;
--   * the before-write trigger additionally VALIDATES geom, ENFORCES anchor
--     immutability (version/page frozen after insert), and STAMPS created_by/
--     updated_by from auth.uid() (unspoofable when a JWT is present).
-- Self-contained + additive + reversible (schema-only). Next free slot 20261017000100.
-- Shape tokens mirror lib/blueprints/markup.ts MARKUP_KINDS exactly.

-- ---------------------------------------------------------------------------
-- 1. Candidate key on the parent. blueprint_versions ALREADY carries
--    unique(id, org_id) from 20261016 (pins) — this guard is a NO-OP there and
--    keeps the migration self-contained. Do NOT re-add unconditionally.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'blueprint_versions_id_org_key') then
    alter table public.blueprint_versions
      add constraint blueprint_versions_id_org_key unique (id, org_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The markup table.
-- ---------------------------------------------------------------------------
create table if not exists public.blueprint_markup (
  id                    uuid primary key default gen_random_uuid(),
  -- Tenancy — DERIVED from the parent version by the before-write trigger.
  org_id                uuid not null,
  job_id                uuid not null,
  -- Anchor: the immutable revision + 1-based sheet. Frozen after insert.
  blueprint_version_id  uuid not null,
  page_number           integer not null default 1 check (page_number >= 1),
  -- Shape + geometry (normalized [0,1] page-box coordinates).
  shape                 text not null
                          check (shape in ('freehand','line','arrow','rect','ellipse','text')),
  geom                  jsonb not null,
  -- Server-derived bounding box (client-sent values ignored — anti-spoof).
  bbox_u                double precision not null check (bbox_u >= 0 and bbox_u <= 1),
  bbox_v                double precision not null check (bbox_v >= 0 and bbox_v <= 1),
  bbox_w                double precision not null check (bbox_w >= 0 and bbox_u + bbox_w <= 1.0000001),
  bbox_h                double precision not null check (bbox_h >= 0 and bbox_v + bbox_h <= 1.0000001),
  -- Style.
  color                 text not null default '#ef4444' check (color ~ '^#[0-9a-fA-F]{6}$'),
  stroke_width          smallint not null default 3 check (stroke_width between 1 and 12),
  -- Text payload — present iff shape='text', trimmed non-empty, <= 500 chars.
  text_content          text,
  -- Soft-delete lifecycle.
  status                text not null default 'active' check (status in ('active','removed')),
  created_by            uuid references public.users(id) on delete set null,
  updated_by            uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,

  -- Version anchor + cross-tenant integrity (declarative, every role incl.
  -- service_role). Defense-in-depth behind the trigger; ON DELETE CASCADE so a
  -- retired revision takes its redlines with it — no dangling markup.
  constraint blueprint_markup_version_org_fkey
    foreign key (blueprint_version_id, org_id)
    references public.blueprint_versions (id, org_id) on delete cascade,

  -- Minimal STRUCTURAL geom backstop (holds even if the trigger is dropped).
  -- Shape-specific counts + [0,1] ranges live in the trigger; the upper bound
  -- caps a giant-freehand DoS declaratively.
  constraint blueprint_markup_geom_shape check (
    jsonb_typeof(geom) = 'object'
    and jsonb_typeof(geom->'points') = 'array'
    and jsonb_array_length(geom->'points') between 1 and 2000
  ),

  -- shape <-> text payload: only text shapes carry text_content, and they must.
  constraint blueprint_markup_text_payload check (
    (shape =  'text' and text_content is not null
                      and char_length(btrim(text_content)) between 1 and 500) or
    (shape <> 'text' and text_content is null)
  ),

  -- soft-delete consistency: removed <=> deleted_at set.
  constraint blueprint_markup_status_deleted check (
    (status = 'active'  and deleted_at is null) or
    (status = 'removed' and deleted_at is not null)
  )
);

comment on table public.blueprint_markup is
  'Vector/freehand redlines anchored to an immutable blueprint_version; geom is normalized [0,1] points, bbox is server-derived, soft-deleted via status. Programme C.';

-- Read path: "active markup on this sheet of this revision" (the viewer query).
create index if not exists blueprint_markup_render_idx
  on public.blueprint_markup (org_id, blueprint_version_id, page_number)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- 3. Anti-spoof derivation + geom validation + bbox derivation + anchor
--    immutability + attribution stamping (before insert OR update).
--    SECURITY DEFINER + pinned search_path. Mirrors tg_blueprint_pin_before_write.
-- ---------------------------------------------------------------------------
create or replace function public.tg_blueprint_markup_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org    uuid;
  v_job    uuid;
  v_points jsonb;
  v_count  integer;
  v_pt     jsonb;
  v_u      double precision;
  v_v      double precision;
  v_min_u  double precision := 1;
  v_min_v  double precision := 1;
  v_max_u  double precision := 0;
  v_max_v  double precision := 0;
begin
  -- (0) Anchor immutability: a redline records what was marked on a specific
  --     sheet of a specific revision; it must never migrate. created_by frozen.
  if tg_op = 'UPDATE' then
    if new.blueprint_version_id is distinct from old.blueprint_version_id
       or new.page_number is distinct from old.page_number then
      raise exception 'markup anchor (version/page) is immutable'
        using errcode = 'check_violation';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  else
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.updated_by := null;
  end if;

  -- (1) Tenancy DERIVED from the immutable version -> its drawing. Client-sent
  --     org_id/job_id ignored (anti-spoof). Runs on update too.
  select b.org_id, b.job_id
    into v_org, v_job
  from public.blueprint_versions bv
  join public.blueprints b on b.id = bv.blueprint_id
  where bv.id = new.blueprint_version_id;

  if v_org is null then
    raise exception 'blueprint version % does not exist', new.blueprint_version_id
      using errcode = 'foreign_key_violation';
  end if;

  new.org_id := v_org;
  new.job_id := v_job;

  -- (2) geom shape: object with a points array.
  if new.geom is null
     or jsonb_typeof(new.geom) is distinct from 'object'
     or jsonb_typeof(new.geom->'points') is distinct from 'array' then
    raise exception 'markup geom must be an object with a points array'
      using errcode = 'check_violation';
  end if;

  v_points := new.geom->'points';
  v_count  := jsonb_array_length(v_points);

  -- (3) Point count is shape-specific.
  if new.shape in ('line','arrow','rect','ellipse') then
    if v_count <> 2 then
      raise exception '% requires exactly 2 points (got %)', new.shape, v_count
        using errcode = 'check_violation';
    end if;
  elsif new.shape = 'text' then
    if v_count <> 1 then
      raise exception 'text markup requires exactly 1 anchor point (got %)', v_count
        using errcode = 'check_violation';
    end if;
  elsif new.shape = 'freehand' then
    if v_count < 2 then
      raise exception 'freehand markup requires >= 2 points (got %)', v_count
        using errcode = 'check_violation';
    end if;
  else
    raise exception 'unknown markup shape %', new.shape using errcode = 'check_violation';
  end if;

  -- (4) Every point is an object with numeric u,v in [0,1]; derive bbox.
  for v_pt in select value from jsonb_array_elements(v_points) as t(value) loop
    if jsonb_typeof(v_pt) is distinct from 'object'
       or jsonb_typeof(v_pt->'u') is distinct from 'number'
       or jsonb_typeof(v_pt->'v') is distinct from 'number' then
      raise exception 'markup point must be an object with numeric u,v'
        using errcode = 'check_violation';
    end if;
    v_u := (v_pt->>'u')::double precision;
    v_v := (v_pt->>'v')::double precision;
    if v_u < 0 or v_u > 1 or v_v < 0 or v_v > 1
       or v_u <> v_u or v_v <> v_v then       -- x <> x rejects NaN
      raise exception 'markup point (%, %) is outside [0,1]', v_u, v_v
        using errcode = 'check_violation';
    end if;
    v_min_u := least(v_min_u, v_u);
    v_min_v := least(v_min_v, v_v);
    v_max_u := greatest(v_max_u, v_u);
    v_max_v := greatest(v_max_v, v_v);
  end loop;

  -- (5) Server-derived bbox OVERRIDES any client-sent bbox_* (anti-spoof).
  new.bbox_u := v_min_u;
  new.bbox_v := v_min_v;
  new.bbox_w := v_max_u - v_min_u;
  new.bbox_h := v_max_v - v_min_v;

  return new;
end $$;

drop trigger if exists blueprint_markup_before_write on public.blueprint_markup;
create trigger blueprint_markup_before_write
  before insert or update on public.blueprint_markup
  for each row execute function public.tg_blueprint_markup_before_write();

drop trigger if exists blueprint_markup_set_updated_at on public.blueprint_markup;
create trigger blueprint_markup_set_updated_at
  before update on public.blueprint_markup
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RLS — tenant-scoped, operator-only. Members select/insert/update (a
--    member "remove" is UPDATE status='removed'); hard DELETE is admin-only.
-- ---------------------------------------------------------------------------
alter table public.blueprint_markup enable row level security;

create policy "blueprint_markup: members select" on public.blueprint_markup
  for select using (org_id in (select public.current_org_ids()));
create policy "blueprint_markup: members insert" on public.blueprint_markup
  for insert with check (org_id in (select public.current_org_ids()));
create policy "blueprint_markup: members update" on public.blueprint_markup
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy "blueprint_markup: admins delete" on public.blueprint_markup
  for delete using (public.is_org_admin(org_id));
