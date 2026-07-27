-- Blueprint Centre foundation — versioned drawing register (Phase 2 WOW).
--
-- A drawing register per job: a `blueprints` shell (identity = job + drawing
-- number) with an immutable `blueprint_versions` revision chain. REUSES the
-- job_documents versioning PATTERN as a SIBLING pair (parent + immutable
-- versions + trigger-maintained current-version pointer + insert triggers) —
-- exactly as completion_certificates reused site_reports and purchase_orders
-- reused quotes. Deliberate divergences from job_documents:
--   * NO staff/private split — drawings are shared job information.
--   * NO "complete" lock — drawings are re-issued as revisions until as-built.
--   * NO auto number — drawings carry their own sheet numbers (A-201 etc.).
--   * ADDS a DB before-UPDATE immutability trigger that job_document_versions
--     LACKS: its immutability rests only on an absent UPDATE policy, which the
--     service-role client (the actual upload path) BYPASSES. Blueprints enforce
--     it at the DB for every role (the site_reports/certs doctrine).
--   * ADDS content_hash (sha256) — evidence-grade proof of what was issued.
--
-- Self-contained: depends only on baseline objects (organizations, jobs, users,
-- current_org_ids, is_org_admin, tg_set_updated_at) — NO dependency on the
-- unmerged 20261008–20261014 stack. Additive + reversible (schema-only down;
-- the storage bucket, created in the companion migration, is NEVER dropped).

-- blueprints: one row per logical drawing on a job. -------------------------
create table if not exists public.blueprints (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  job_id          uuid not null references public.jobs(id) on delete cascade,
  drawing_number  text not null,                 -- sheet no. as issued (e.g. A-201)
  title           text not null,
  discipline      text check (discipline in
                    ('architectural','structural','civil','mechanical','electrical','plumbing','other')),
  status          text not null default 'for_construction'
                    check (status in ('preliminary','for_construction','as_built','superseded')),
  -- pointer to the live revision's integer version. NO foreign key (avoids the
  -- circular ref; mirrors job_documents.current_version). Trigger-maintained.
  current_version integer,
  created_by      uuid references public.users(id) on delete set null,
  updated_by      uuid references public.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- one register entry per drawing number on a job; revisions go in the chain.
  constraint blueprints_job_number_key unique (org_id, job_id, drawing_number)
);
create index if not exists blueprints_job_idx on public.blueprints (org_id, job_id, created_at desc);

-- blueprint_versions: immutable, one file per revision. org_id + version are ---
-- trigger-set (client-sent values ignored). -------------------------------------
create table if not exists public.blueprint_versions (
  id             uuid primary key default gen_random_uuid(),
  blueprint_id   uuid not null references public.blueprints(id) on delete cascade,
  org_id         uuid not null,                  -- set by before-insert trigger
  version        integer not null,               -- internal chain order; trigger-set
  revision       text not null,                  -- the human revision label (e.g. Rev C / P02)
  revision_date  date,                            -- when the revision was issued (≠ upload date)
  storage_bucket text not null default 'blueprints' check (storage_bucket = 'blueprints'),
  storage_path   text not null,
  file_name      text not null,
  mime_type      text not null,
  size_bytes     bigint not null check (size_bytes >= 0),
  content_hash   text,                            -- sha256 of the bytes (evidence)
  notes          text,
  uploaded_by    uuid references public.users(id) on delete set null,
  uploaded_at    timestamptz not null default now(),
  constraint blueprint_versions_version_key unique (blueprint_id, version)
);
create index if not exists blueprint_versions_bp_idx on public.blueprint_versions (blueprint_id, version desc);

-- Before insert: lock parent, derive authoritative org_id, allocate version. ----
create or replace function public.tg_blueprint_version_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  select org_id into v_org from public.blueprints where id = new.blueprint_id for update;
  if v_org is null then
    raise exception 'blueprint % not found', new.blueprint_id using errcode = 'check_violation';
  end if;
  new.org_id := v_org;                            -- ignore any client-sent org_id
  select coalesce(max(version), 0) + 1 into new.version
    from public.blueprint_versions where blueprint_id = new.blueprint_id;
  return new;
end $$;
drop trigger if exists blueprint_versions_before_insert on public.blueprint_versions;
create trigger blueprint_versions_before_insert before insert on public.blueprint_versions
  for each row execute function public.tg_blueprint_version_before_insert();

-- After insert: move the current-version pointer forward + stamp updated_by. ----
create or replace function public.tg_blueprint_version_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.blueprints
     set current_version = new.version, updated_by = new.uploaded_by, updated_at = now()
   where id = new.blueprint_id;
  return new;
end $$;
drop trigger if exists blueprint_versions_after_insert on public.blueprint_versions;
create trigger blueprint_versions_after_insert after insert on public.blueprint_versions
  for each row execute function public.tg_blueprint_version_after_insert();

-- Immutability: a revision is a record of what was ISSUED. Reject ANY update to
-- an existing version row — for EVERY role, service_role included (the absent
-- UPDATE policy alone does not stop the service-role writer). Delete stays admin.
create or replace function public.tg_blueprint_versions_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'blueprint_versions are immutable (version % of blueprint %)',
    old.version, old.blueprint_id using errcode = 'check_violation';
end $$;
drop trigger if exists blueprint_versions_immutable on public.blueprint_versions;
create trigger blueprint_versions_immutable before update on public.blueprint_versions
  for each row execute function public.tg_blueprint_versions_immutable();

drop trigger if exists blueprints_set_updated_at on public.blueprints;
create trigger blueprints_set_updated_at before update on public.blueprints
  for each row execute function public.tg_set_updated_at();

-- RLS — tenant-scoped, operator-only (no portal). Members read/write the
-- register; only the version chain is insert-only (immutable); admins delete.
alter table public.blueprints enable row level security;
alter table public.blueprint_versions enable row level security;

create policy "blueprints: members select" on public.blueprints
  for select using (org_id in (select public.current_org_ids()));
create policy "blueprints: members insert" on public.blueprints
  for insert with check (org_id in (select public.current_org_ids()));
create policy "blueprints: members update" on public.blueprints
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy "blueprints: admins delete" on public.blueprints
  for delete using (public.is_org_admin(org_id));

create policy "blueprint_versions: members select" on public.blueprint_versions
  for select using (org_id in (select public.current_org_ids()));
create policy "blueprint_versions: members insert" on public.blueprint_versions
  for insert with check (org_id in (select public.current_org_ids()));
-- NO update policy (immutable) — the trigger is the DB-level backstop.
create policy "blueprint_versions: admins delete" on public.blueprint_versions
  for delete using (public.is_org_admin(org_id));
