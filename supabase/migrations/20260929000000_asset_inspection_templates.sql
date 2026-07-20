-- Asset Management — Milestone 4b (part 1): versioned inspection templates.
--
-- Reusable, versioned checklists that seed inspections (M4a) — the compliance
-- backbone for pre-use checks, LOLER/PUWER/PAT-style examinations and servicing
-- checklists. NOT a generic form builder: the definition is a bounded jsonb
-- document (sections → ordered items with typed responses), validated by the
-- app, with the DURABLE invariants enforced here:
--
--   1. ONE ROW PER VERSION. `family_id` groups the versions of one logical
--      template; (family_id, version) is unique; AT MOST ONE PUBLISHED version
--      per family (partial unique index) — "which checklist is live" is a DB
--      fact, never a race.
--   2. PUBLISHED SUBSTANCE IS FROZEN. Once a version leaves draft, its
--      definition/name/categories can never change (BEFORE trigger) — a
--      checklist someone inspected against can never be silently rewritten.
--      Editing a published template = creating the NEXT draft version.
--   3. PUBLISH INTEGRITY. A version cannot become published with an empty
--      definition (DB backstop; the app validates richer rules).
--   4. ATOMIC PUBLISH. publish_inspection_template() supersedes the currently
--      published version and publishes the draft in ONE transaction
--      (SECURITY INVOKER — RLS and triggers still apply).
--
-- Inspections keep the EXACT version they used: template linkage columns +
-- a frozen `template_snapshot` on asset_inspections that is WRITE-ONCE at the
-- database from the moment it is set (not merely from issue) — an in-progress
-- inspection keeps its checklist even when a newer version publishes, and
-- deleting a template never destroys completed evidence (`on delete set null`;
-- the snapshot carries the full definition).
--
-- Additive + reversible. No change to tenant_attachments (inspection evidence
-- already rides the existing 'asset_inspections' target from 20260927).

create table if not exists public.asset_inspection_templates (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,

  -- Version grouping: all versions of one logical template share family_id.
  family_id     uuid not null,
  version       integer not null default 1 check (version >= 1),

  name          text not null,
  description   text,
  -- Applicability: which asset categories this checklist suits (null = all).
  -- Soft guidance for pickers, not a hard gate — sites name categories freely.
  categories    text[],

  -- The compliance-honesty boundary: operator pre-use check vs competent-person
  -- recorded inspection (CrewFlow is the system of record for both) vs
  -- thorough examination (LOLER-style — CrewFlow stores the external report,
  -- never synthesises a certificate).
  check_level   text not null default 'pre_use_check'
    check (check_level in ('pre_use_check', 'recorded_inspection', 'thorough_examination')),

  status        text not null default 'draft'
    check (status in ('draft', 'published', 'superseded', 'archived')),

  -- The bounded checklist document: {"sections":[{key,title,items:[…]}]}.
  -- Shape is validated/bounded by the app (lib/assets/inspection-template.ts);
  -- the DB freezes it once the version leaves draft.
  definition    jsonb not null default '{"sections": []}'::jsonb,

  created_by    uuid references public.users(id) on delete set null,
  published_by  uuid references public.users(id) on delete set null,
  published_at  timestamp with time zone,
  -- Version lineage: the version this one replaced (set when created from it).
  supersedes_id uuid references public.asset_inspection_templates(id) on delete set null,

  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

-- Version identity + THE live-version invariant.
create unique index if not exists asset_inspection_templates_family_version_idx
  on public.asset_inspection_templates (family_id, version);
create unique index if not exists asset_inspection_templates_one_published_idx
  on public.asset_inspection_templates (family_id) where status = 'published';

-- Lookups: the org's template library (list by status), family history.
create index if not exists asset_inspection_templates_org_status_idx
  on public.asset_inspection_templates (org_id, status);
create index if not exists asset_inspection_templates_family_idx
  on public.asset_inspection_templates (family_id, version desc);

-- ── Same-org guard ────────────────────────────────────────────────────────────
create or replace function public.tg_asset_inspection_templates_guard()
returns trigger language plpgsql as $$
begin
  if new.supersedes_id is not null
     and not exists (select 1 from public.asset_inspection_templates
                     where id = new.supersedes_id and org_id = new.org_id) then
    raise exception 'superseded template % is not in org %', new.supersedes_id, new.org_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists asset_inspection_templates_guard on public.asset_inspection_templates;
create trigger asset_inspection_templates_guard
  before insert or update on public.asset_inspection_templates
  for each row execute function public.tg_asset_inspection_templates_guard();

-- ── Immutability + publish integrity ─────────────────────────────────────────
-- Substance (definition/name/categories) is frozen once the version is no
-- longer a draft; status itself may still move (published → superseded →
-- archived). A version cannot become published with an empty definition.
create or replace function public.tg_asset_inspection_templates_immutable()
returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    if new.definition is distinct from old.definition then
      raise exception 'asset_inspection_templates.definition is frozen once published (template %, status %)',
        old.id, old.status using errcode = 'check_violation';
    end if;
    if new.name is distinct from old.name then
      raise exception 'asset_inspection_templates.name is frozen once published (template %)', old.id
        using errcode = 'check_violation';
    end if;
    if new.categories is distinct from old.categories then
      raise exception 'asset_inspection_templates.categories is frozen once published (template %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.status = 'published' and old.status is distinct from 'published' then
    if jsonb_array_length(coalesce(new.definition->'sections', '[]'::jsonb)) = 0 then
      raise exception 'a template cannot be published with an empty definition (template %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists asset_inspection_templates_immutable on public.asset_inspection_templates;
create trigger asset_inspection_templates_immutable
  before update on public.asset_inspection_templates
  for each row execute function public.tg_asset_inspection_templates_immutable();

drop trigger if exists asset_inspection_templates_set_updated_at on public.asset_inspection_templates;
create trigger asset_inspection_templates_set_updated_at
  before update on public.asset_inspection_templates
  for each row execute function public.tg_set_updated_at();

-- ── Atomic publish ────────────────────────────────────────────────────────────
-- Supersede the family's currently-published version (if any) and publish the
-- draft in one transaction. SECURITY INVOKER: RLS + the triggers above still
-- gate the caller; the one-published partial index backstops any race.
create or replace function public.publish_inspection_template(
  p_template_id uuid,
  p_org_id      uuid,
  p_user        uuid
) returns void
language plpgsql as $$
declare
  v_family uuid;
  v_status text;
begin
  select family_id, status into v_family, v_status
  from public.asset_inspection_templates
  where id = p_template_id and org_id = p_org_id
  for update;

  if v_family is null then
    raise exception 'template % not found in org %', p_template_id, p_org_id
      using errcode = 'check_violation';
  end if;
  if v_status <> 'draft' then
    raise exception 'only a draft version can be published (template %, status %)',
      p_template_id, v_status using errcode = 'check_violation';
  end if;

  update public.asset_inspection_templates
     set status = 'superseded'
   where family_id = v_family and org_id = p_org_id and status = 'published';

  update public.asset_inspection_templates
     set status = 'published', published_at = now(), published_by = p_user
   where id = p_template_id;
end $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.asset_inspection_templates enable row level security;

create policy asset_inspection_templates_select on public.asset_inspection_templates
  for select using (org_id in (select public.current_org_ids()));
create policy asset_inspection_templates_insert on public.asset_inspection_templates
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_inspection_templates_update on public.asset_inspection_templates
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy asset_inspection_templates_delete on public.asset_inspection_templates
  for delete using (public.is_org_admin(org_id));

-- ── Inspections carry the exact version they used ─────────────────────────────
alter table public.asset_inspections
  add column if not exists template_id uuid
    references public.asset_inspection_templates(id) on delete set null,
  add column if not exists template_version integer,
  add column if not exists template_snapshot jsonb;

create index if not exists asset_inspections_template_idx
  on public.asset_inspections (template_id) where template_id is not null;

-- A SEPARATE small trigger (the proven M4a immutability function stays
-- byte-identical): the template linkage is WRITE-ONCE from the moment it is
-- set — even while the inspection is still a draft — and the referenced
-- template must belong to the row's org.
create or replace function public.tg_asset_inspections_template_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if old.template_snapshot is not null
       and new.template_snapshot is distinct from old.template_snapshot then
      raise exception 'asset_inspections.template_snapshot is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
    if old.template_id is not null and new.template_id is distinct from old.template_id then
      raise exception 'asset_inspections.template_id is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
    if old.template_version is not null
       and new.template_version is distinct from old.template_version then
      raise exception 'asset_inspections.template_version is immutable once set (inspection %)', old.id
        using errcode = 'check_violation';
    end if;
  end if;

  if new.template_id is not null
     and not exists (select 1 from public.asset_inspection_templates t
                     where t.id = new.template_id and t.org_id = new.org_id) then
    raise exception 'template % is not in org %', new.template_id, new.org_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists asset_inspections_template_guard on public.asset_inspections;
create trigger asset_inspections_template_guard
  before insert or update on public.asset_inspections
  for each row execute function public.tg_asset_inspections_template_guard();
