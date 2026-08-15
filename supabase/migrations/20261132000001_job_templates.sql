-- Job templates — a reusable, job-type blueprint that pre-loads a new job's
-- programme milestones and checklist the moment it is created.
--
-- THE GAP THIS CLOSES. jobs/actions.ts supports only recurring PATTERNS; every
-- job is otherwise BLANK. A groundworks firm that runs the same twelve-milestone
-- programme and the same site-setup checklist on every extension re-types both
-- by hand each time. A template captures that once (by job type) and clones it
-- onto a new job — the milestones become a programme baseline revision 1, the
-- checklist becomes the job's live checklist (20261132000001).
--
-- ── SHAPE (transplants the 20261085 / 20261072 tenancy idioms) ───────────────
-- Three tables:
--   job_templates                — the header (name, job type, defaults).
--   job_template_milestones      — OFFSET-dated milestones (days from the job's
--                                  anchor date), the source of a cloned baseline.
--   job_template_checklist_items — the source of a cloned per-job checklist.
-- Children bind their parent by COMPOSITE FK (template_id, org_id) →
-- job_templates(id, org_id), so a forged parent id cannot cross tenants even for
-- service_role. ON DELETE CASCADE throughout, teardown-safe.
--
-- ── OFFSETS, NOT DATES ───────────────────────────────────────────────────────
-- A template is dateless: a milestone is "day 0..5 from the job's start", not
-- "3 August". clone_job_template turns offsets into real dates against the job's
-- anchor (its scheduled_date), so the same template fits any start.
--
-- ── NO MONEY, MIRRORING THE PROGRAMME BOUNDARY (20261085) ────────────────────
-- A template milestone carries a title, day offsets, an OPTIONAL dimensionless
-- weight and a customer-visibility flag — no amount, no billing link. Templates
-- are planning configuration, never a valuation.
--
-- ── WHY DOCUMENTS ARE NOT HERE ───────────────────────────────────────────────
-- The Master-Plan line says "milestones/checklists/documents". Milestones and
-- checklists are structured rows a template can hold and clone. A job DOCUMENT
-- is uploaded BYTES (a file in a bucket); a template cannot pre-load bytes that
-- do not exist yet, so "document templates" would be an empty-shell feature.
-- Deliberately deferred rather than faked.
--
-- Additive and reversible. To roll back:
--   drop table public.job_template_checklist_items;
--   drop table public.job_template_milestones;
--   drop table public.job_templates;
--   drop function public.save_job_template(uuid, uuid, text, text, text, text, jsonb, jsonb);
--   drop function public.clone_job_template(uuid, uuid, uuid, date);
-- Depends on: jobs_id_org_key (20261072) for clone's job binding.

-- ── 1. job_templates — the reusable header ───────────────────────────────────
create table if not exists public.job_templates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  name           text not null check (length(trim(name)) >= 1 and char_length(name) <= 200),
  -- Free-text job type ("Loft conversion", "Boiler service") used to group and
  -- to suggest a template on create. NOT an enum: every trade names its work
  -- differently, and a closed list would be wrong for the next firm.
  job_type       text check (job_type is null or char_length(job_type) <= 120),
  description    text check (description is null or char_length(description) <= 2000),
  -- The status a cloned job should start in (defaults to the job's own default
  -- when null). One of the JOB_STATUSES; not enforced as an enum here because
  -- the status vocabulary lives in the app (lib/jobs/schema.ts) and is validated
  -- by save_job_template before write.
  default_status text check (default_status is null or default_status in ('new','in-progress','completed','blocked')),
  -- Retired templates stay for history but are hidden from the create picker.
  is_active      boolean not null default true,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint job_templates_id_org_key unique (id, org_id)
);

create index if not exists job_templates_org_active_idx
  on public.job_templates (org_id, is_active);
-- One active template per (org, name) — re-saving a name supersedes in place via
-- save_job_template rather than silently forking two "Loft conversion"s.
create unique index if not exists job_templates_org_name_active_uniq
  on public.job_templates (org_id, lower(name)) where is_active;

-- ── 2. job_template_milestones — offset-dated, cloned into a baseline ─────────
create table if not exists public.job_template_milestones (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  template_id      uuid not null,
  title            text not null check (length(trim(title)) >= 1 and char_length(title) <= 200),
  -- Whole days from the job's anchor date. offset_start is optional (a point
  -- milestone has an end only); offset_end is required. Both >= 0 (a milestone
  -- before the job starts is nonsense) and end >= start.
  offset_start_days int check (offset_start_days is null or offset_start_days >= 0),
  offset_end_days   int not null check (offset_end_days >= 0),
  weight           numeric(5,2) check (weight is null or (weight > 0 and weight <= 100)),
  customer_visible boolean not null default false,
  sort             int not null check (sort >= 1),
  constraint job_template_milestones_template_fk
    foreign key (template_id, org_id)
      references public.job_templates (id, org_id) on delete cascade,
  constraint job_template_milestone_window check (
    offset_start_days is null or offset_end_days >= offset_start_days
  ),
  constraint job_template_milestones_sort_uniq unique (template_id, sort)
);

create index if not exists job_template_milestones_org_template_idx
  on public.job_template_milestones (org_id, template_id);

-- ── 3. job_template_checklist_items — cloned into a job checklist ─────────────
create table if not exists public.job_template_checklist_items (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  template_id    uuid not null,
  label          text not null check (length(trim(label)) >= 1 and char_length(label) <= 300),
  requires_photo boolean not null default false,
  sort           int not null check (sort >= 1),
  constraint job_template_checklist_template_fk
    foreign key (template_id, org_id)
      references public.job_templates (id, org_id) on delete cascade,
  constraint job_template_checklist_sort_uniq unique (template_id, sort)
);

create index if not exists job_template_checklist_org_template_idx
  on public.job_template_checklist_items (org_id, template_id);

-- ── 4. RLS — members read, admins write (planning configuration) ─────────────
alter table public.job_templates enable row level security;
alter table public.job_template_milestones enable row level security;
alter table public.job_template_checklist_items enable row level security;

drop policy if exists "job_templates: members can select" on public.job_templates;
create policy "job_templates: members can select" on public.job_templates
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_templates: admins can insert" on public.job_templates;
create policy "job_templates: admins can insert" on public.job_templates
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_templates: admins can update" on public.job_templates;
create policy "job_templates: admins can update" on public.job_templates
  for update to authenticated using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists "job_templates: admins can delete" on public.job_templates;
create policy "job_templates: admins can delete" on public.job_templates
  for delete to authenticated using (public.is_org_admin(org_id));

drop policy if exists "job_template_milestones: members can select" on public.job_template_milestones;
create policy "job_template_milestones: members can select" on public.job_template_milestones
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_template_milestones: admins can insert" on public.job_template_milestones;
create policy "job_template_milestones: admins can insert" on public.job_template_milestones
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_template_milestones: admins can delete" on public.job_template_milestones;
create policy "job_template_milestones: admins can delete" on public.job_template_milestones
  for delete to authenticated using (public.is_org_admin(org_id));

drop policy if exists "job_template_checklist: members can select" on public.job_template_checklist_items;
create policy "job_template_checklist: members can select" on public.job_template_checklist_items
  for select to authenticated using (org_id in (select public.current_org_ids()));
drop policy if exists "job_template_checklist: admins can insert" on public.job_template_checklist_items;
create policy "job_template_checklist: admins can insert" on public.job_template_checklist_items
  for insert to authenticated with check (public.is_org_admin(org_id));
drop policy if exists "job_template_checklist: admins can delete" on public.job_template_checklist_items;
create policy "job_template_checklist: admins can delete" on public.job_template_checklist_items
  for delete to authenticated using (public.is_org_admin(org_id));

-- ── 5. save_job_template — header + children, REPLACE-ALL, atomically ─────────
-- Editing a template is "replace its children", so this deletes the current
-- milestone/checklist rows and re-inserts the submitted set inside ONE
-- transaction. SECURITY INVOKER: the admin-only RLS above is the real gate, so
-- a staff JWT is refused here exactly as it would be at /rest/v1. A per-template
-- advisory lock serialises two admins editing at once.
--
-- p_template_id null → create; non-null → update-in-place (must be same org).
create or replace function public.save_job_template(
  p_template_id  uuid,
  p_org_id       uuid,
  p_name         text,
  p_job_type     text,
  p_description  text,
  p_default_status text,
  p_milestones   jsonb,
  p_checklist    jsonb
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id      uuid;
  v_idx     int := 0;
  m         jsonb;
  v_os      int;
  v_oe      int;
  v_weight  numeric;
begin
  if p_org_id is null then
    raise exception 'an organisation is required';
  end if;
  if p_name is null or length(btrim(p_name)) = 0 then
    raise exception 'a template needs a name';
  end if;
  if p_default_status is not null
     and p_default_status not in ('new','in-progress','completed','blocked') then
    raise exception 'that job status is not recognised';
  end if;

  -- Validate milestone offsets before touching a row.
  if p_milestones is not null and jsonb_typeof(p_milestones) = 'array' then
    for m in select * from jsonb_array_elements(p_milestones) loop
      if btrim(coalesce(m->>'title','')) = '' or char_length(btrim(m->>'title')) > 200 then
        raise exception 'every milestone needs a title of 1-200 characters';
      end if;
      begin
        v_oe := (m->>'offset_end_days')::int;
        v_os := nullif(m->>'offset_start_days','')::int;
      exception when others then
        raise exception 'milestone "%" has an unreadable day offset', btrim(m->>'title');
      end;
      if v_oe is null or v_oe < 0 then
        raise exception 'milestone "%" needs an end offset of 0 or more days', btrim(m->>'title');
      end if;
      if v_os is not null and (v_os < 0 or v_os > v_oe) then
        raise exception 'milestone "%" has a start offset after its end', btrim(m->>'title');
      end if;
      if nullif(btrim(coalesce(m->>'weight','')),'') is not null then
        begin v_weight := (m->>'weight')::numeric; exception when others then
          raise exception 'milestone "%" has an unreadable weight', btrim(m->>'title');
        end;
        if v_weight <= 0 or v_weight > 100 then
          raise exception 'a milestone weight must be greater than 0 and at most 100';
        end if;
      end if;
    end loop;
  end if;

  if p_template_id is not null then
    perform pg_advisory_xact_lock(hashtext('job_template'), hashtext(p_template_id::text));
    update public.job_templates
       set name = btrim(p_name),
           job_type = nullif(btrim(coalesce(p_job_type,'')),''),
           description = nullif(btrim(coalesce(p_description,'')),''),
           default_status = p_default_status,
           updated_at = now()
     where id = p_template_id and org_id = p_org_id
     returning id into v_id;
    if v_id is null then
      raise exception 'that template is not in this workspace';
    end if;
    -- Replace-all children.
    delete from public.job_template_milestones where template_id = v_id and org_id = p_org_id;
    delete from public.job_template_checklist_items where template_id = v_id and org_id = p_org_id;
  else
    insert into public.job_templates (org_id, name, job_type, description, default_status, created_by)
    values (
      p_org_id, btrim(p_name),
      nullif(btrim(coalesce(p_job_type,'')),''),
      nullif(btrim(coalesce(p_description,'')),''),
      p_default_status, auth.uid()
    )
    returning id into v_id;
  end if;

  if p_milestones is not null and jsonb_typeof(p_milestones) = 'array' then
    v_idx := 0;
    for m in select * from jsonb_array_elements(p_milestones) loop
      v_idx := v_idx + 1;
      insert into public.job_template_milestones (
        org_id, template_id, title, offset_start_days, offset_end_days,
        weight, customer_visible, sort
      ) values (
        p_org_id, v_id, btrim(m->>'title'),
        nullif(m->>'offset_start_days','')::int,
        (m->>'offset_end_days')::int,
        case when nullif(btrim(coalesce(m->>'weight','')),'') is not null
             then round((m->>'weight')::numeric, 2) else null end,
        coalesce((m->>'customer_visible')::boolean, false),
        v_idx
      );
    end loop;
  end if;

  if p_checklist is not null and jsonb_typeof(p_checklist) = 'array' then
    v_idx := 0;
    for m in select * from jsonb_array_elements(p_checklist) loop
      if btrim(coalesce(m->>'label','')) = '' then continue; end if;
      v_idx := v_idx + 1;
      insert into public.job_template_checklist_items (org_id, template_id, label, requires_photo, sort)
      values (
        p_org_id, v_id, btrim(m->>'label'),
        coalesce((m->>'requires_photo')::boolean, false),
        v_idx
      );
    end loop;
  end if;

  return v_id;
end $$;

revoke all on function public.save_job_template(uuid, uuid, text, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.save_job_template(uuid, uuid, text, text, text, text, jsonb, jsonb) to authenticated;

-- ── 6. clone_job_template — onto a freshly-created job, atomically ────────────
-- Called by createJob right after the job row lands. Two independent clones:
--
--   PROGRAMME (admins only, and only when an anchor date exists): turns the
--   template's day offsets into a job_programme_baselines revision 1 + its
--   job_milestones. Gated on is_org_admin so a member's clone silently SKIPS the
--   baseline (RLS would refuse it anyway) rather than erroring — the baseline is
--   admin planning config (20261085), and this respects that gate exactly. Only
--   when the job has NO baseline yet (revision-1 semantics).
--
--   CHECKLIST (any member): job_checklists is member-writable (20261132000001),
--   so every creator gets the checklist regardless of role.
--
-- SECURITY INVOKER: no privilege escalation; each insert is authorised by the
-- caller's own RLS. Best-effort by construction — a template with no milestones
-- and no checklist is a clean no-op. Returns the created baseline id, or null.
create or replace function public.clone_job_template(
  p_job_id      uuid,
  p_org_id      uuid,
  p_template_id uuid,
  p_anchor_date date
)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_baseline_id uuid;
  v_start       date;
  v_end         date;
  v_has_baseline boolean;
  v_idx         int := 0;
  r             record;
begin
  if p_job_id is null or p_org_id is null or p_template_id is null then
    return null;
  end if;
  -- The job and template must both be in this org (structural, not just RLS).
  if not exists (select 1 from public.jobs where id = p_job_id and org_id = p_org_id) then
    raise exception 'that job is not in this workspace';
  end if;
  if not exists (select 1 from public.job_templates where id = p_template_id and org_id = p_org_id) then
    raise exception 'that template is not in this workspace';
  end if;

  -- ── Programme clone (admins, anchored, no existing baseline) ──
  if p_anchor_date is not null and public.is_org_admin(p_org_id) then
    select exists (
      select 1 from public.job_programme_baselines
       where job_id = p_job_id and org_id = p_org_id and superseded_at is null
    ) into v_has_baseline;

    if not v_has_baseline then
      -- Window = the anchor plus the min start / max end offset across milestones.
      select (p_anchor_date + coalesce(min(coalesce(offset_start_days, offset_end_days)), 0) * interval '1 day')::date,
             (p_anchor_date + coalesce(max(offset_end_days), 0) * interval '1 day')::date
        into v_start, v_end
        from public.job_template_milestones
       where template_id = p_template_id and org_id = p_org_id;

      if v_start is not null then
        insert into public.job_programme_baselines (org_id, job_id, revision, planned_start, planned_end, created_by)
        values (p_org_id, p_job_id, 1, v_start, v_end, auth.uid())
        returning id into v_baseline_id;

        for r in
          select * from public.job_template_milestones
           where template_id = p_template_id and org_id = p_org_id
           order by sort asc
        loop
          v_idx := v_idx + 1;
          insert into public.job_milestones (
            org_id, baseline_id, title, planned_start, planned_end,
            weight, customer_visible, sort
          ) values (
            p_org_id, v_baseline_id, r.title,
            case when r.offset_start_days is not null
                 then (p_anchor_date + r.offset_start_days * interval '1 day')::date else null end,
            (p_anchor_date + r.offset_end_days * interval '1 day')::date,
            r.weight, r.customer_visible, v_idx
          );
        end loop;
      end if;
    end if;
  end if;

  -- ── Checklist clone (any member) ──
  v_idx := 0;
  for r in
    select * from public.job_template_checklist_items
     where template_id = p_template_id and org_id = p_org_id
     order by sort asc
  loop
    v_idx := v_idx + 1;
    insert into public.job_checklists (org_id, job_id, label, requires_photo, sort, created_by)
    values (p_org_id, p_job_id, r.label, r.requires_photo, v_idx, auth.uid());
  end loop;

  return v_baseline_id;
end $$;

revoke all on function public.clone_job_template(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.clone_job_template(uuid, uuid, uuid, date) to authenticated;
