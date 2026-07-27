-- P4 Job Documents — core tables, RLS, versioning triggers.
-- Two document areas per job, discriminated by job_documents.visibility:
--   'staff'   → visible + editable by owner/admin/staff
--   'private' → visible to owner/admin only; staff may UPLOAD (drop box)
--               but must never SELECT/download. Enforced at THREE layers:
--               table RLS (here), storage RLS (next migration), service layer.

-- ---------------------------------------------------------------------------
-- job_documents: one row per logical document on a job.
-- ---------------------------------------------------------------------------
create table if not exists public.job_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,

  visibility text not null check (visibility in ('staff', 'private')),
  doc_type text not null default 'custom' check (doc_type in (
    'eicr', 'test_sheet', 'risk_assessment', 'method_statement',
    'completion_cert', 'checklist', 'site_report', 'timesheet',
    'commissioning', 'custom'
  )),
  title text not null,
  status text not null default 'draft'
    check (status in ('draft', 'in_progress', 'completed')),

  -- Reserved for future native form templates (EICR builder). No FK yet — the
  -- templates table doesn't exist; adding the column now avoids an ALTER on a
  -- populated table later.
  template_id uuid,

  -- Optional document assignment ("My Documents"). Nullable: most docs aren't
  -- assigned to a specific person.
  assigned_to uuid references public.users(id) on delete set null,

  -- Free-text external/job-pack reference (e.g. an EICR cert number or a
  -- customer PO). Reserved for cross-referencing; not parsed by the app.
  external_reference text,

  -- Future customer-portal opt-in: set when a completed doc is shared to the
  -- customer. Reserved; no portal read path is built yet.
  customer_shared_at timestamptz,

  -- Future-use signature requirements. Will drive UI/validation later
  -- (EICR → staff sig; completion cert → customer sig; risk assessment →
  -- neither). NOT enforced now.
  requires_staff_signature boolean not null default false,
  requires_customer_signature boolean not null default false,

  -- Pointer to the current version row. No FK: job_document_versions
  -- references job_documents, so a FK here would be circular. Maintained by
  -- the after-insert trigger below.
  current_version uuid,

  completed_at timestamptz,
  completed_by uuid references public.users(id) on delete set null,

  -- Nullable + on delete set null (a NOT NULL column with ON DELETE SET NULL
  -- is self-contradictory). The service layer always sets created_by at insert.
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_documents_job_idx
  on public.job_documents (org_id, job_id, visibility, created_at desc);
create index if not exists job_documents_assigned_idx
  on public.job_documents (org_id, assigned_to, status);

-- ---------------------------------------------------------------------------
-- job_document_versions: immutable, one file per version.
-- org_id + visibility are denormalized from the parent (trigger-set) so the
-- RLS predicate and bucket check don't need a join.
-- ---------------------------------------------------------------------------
create table if not exists public.job_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.job_documents(id) on delete cascade,

  -- Denormalized from parent; set by the before-insert trigger, never trusted
  -- from the client.
  org_id uuid not null,
  visibility text not null check (visibility in ('staff', 'private')),

  version_no integer not null,

  storage_bucket text not null
    check (storage_bucket in ('job-docs', 'job-docs-private')),
  storage_path text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,

  -- Reserved for future native fillable forms (EICR). Today every version has
  -- a file; later a version may be form_data only.
  form_data jsonb,

  uploaded_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),

  unique (document_id, version_no)
);

create index if not exists job_document_versions_doc_idx
  on public.job_document_versions (document_id, version_no desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.job_documents enable row level security;
alter table public.job_document_versions enable row level security;

-- SELECT: org members see staff docs; only owner/admin see private.
drop policy if exists "job_documents: select staff or admin" on public.job_documents;
create policy "job_documents: select staff or admin"
  on public.job_documents for select
  using (
    org_id in (select public.current_org_ids())
    and (visibility = 'staff' or public.is_org_admin(org_id))
  );

-- INSERT: any org member may create a doc in their org (incl. a private
-- drop-box shell). The private RETURNING path still goes via the service-role
-- client (a member can't SELECT a private row back); this WITH CHECK only
-- bounds which org they can write to.
drop policy if exists "job_documents: insert members" on public.job_documents;
create policy "job_documents: insert members"
  on public.job_documents for insert
  with check (org_id in (select public.current_org_ids()));

-- UPDATE: same gate as SELECT, re-checked on the new row so visibility can't be
-- flipped to escape the gate.
drop policy if exists "job_documents: update staff or admin" on public.job_documents;
create policy "job_documents: update staff or admin"
  on public.job_documents for update
  using (
    org_id in (select public.current_org_ids())
    and (visibility = 'staff' or public.is_org_admin(org_id))
  )
  with check (
    org_id in (select public.current_org_ids())
    and (visibility = 'staff' or public.is_org_admin(org_id))
  );

-- DELETE: owner/admin only, both areas.
drop policy if exists "job_documents: delete admin" on public.job_documents;
create policy "job_documents: delete admin"
  on public.job_documents for delete
  using (public.is_org_admin(org_id));

-- Versions mirror the parent's visibility gate.
drop policy if exists "job_document_versions: select staff or admin" on public.job_document_versions;
create policy "job_document_versions: select staff or admin"
  on public.job_document_versions for select
  using (
    org_id in (select public.current_org_ids())
    and (visibility = 'staff' or public.is_org_admin(org_id))
  );

-- INSERT: members may add staff versions. Private versions go via service role
-- (drop box), so this WITH CHECK intentionally blocks a staff JWT from writing
-- a private version directly — only admin can. RLS WITH CHECK is evaluated
-- AFTER the before-insert trigger has set org_id/visibility from the parent,
-- so the gate sees authoritative values.
drop policy if exists "job_document_versions: insert staff or admin" on public.job_document_versions;
create policy "job_document_versions: insert staff or admin"
  on public.job_document_versions for insert
  with check (
    org_id in (select public.current_org_ids())
    and (visibility = 'staff' or public.is_org_admin(org_id))
  );

-- Versions are immutable → no UPDATE policy. DELETE admin-only (parent cascade
-- still works regardless of policy).
drop policy if exists "job_document_versions: delete admin" on public.job_document_versions;
create policy "job_document_versions: delete admin"
  on public.job_document_versions for delete
  using (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- Versioning triggers
-- ---------------------------------------------------------------------------

-- Before insert: derive authoritative org_id/visibility/version_no from the
-- parent, block writes to completed docs, and enforce bucket↔visibility.
-- SECURITY DEFINER so it can read/lock the parent regardless of caller RLS
-- (needed for the private drop-box path, where the caller can't SELECT the
-- private parent).
create or replace function public.tg_job_document_version_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_doc public.job_documents%rowtype;
begin
  -- Lock the parent so concurrent uploads can't collide on version_no.
  select * into v_doc from public.job_documents
    where id = new.document_id
    for update;

  if not found then
    raise exception 'job_document % not found', new.document_id;
  end if;

  if v_doc.status = 'completed' then
    raise exception 'job_document % is completed and locked', new.document_id
      using errcode = 'check_violation';
  end if;

  -- Authoritative values from the parent; ignore whatever the client sent.
  new.org_id := v_doc.org_id;
  new.visibility := v_doc.visibility;

  if v_doc.visibility = 'private' and new.storage_bucket <> 'job-docs-private' then
    raise exception 'private documents must use the job-docs-private bucket';
  end if;
  if v_doc.visibility = 'staff' and new.storage_bucket <> 'job-docs' then
    raise exception 'staff documents must use the job-docs bucket';
  end if;

  select coalesce(max(version_no), 0) + 1 into new.version_no
    from public.job_document_versions
    where document_id = new.document_id;

  return new;
end;
$$;

drop trigger if exists job_document_versions_before_insert on public.job_document_versions;
create trigger job_document_versions_before_insert
  before insert on public.job_document_versions
  for each row execute function public.tg_job_document_version_before_insert();

-- After insert: point the parent at the new current version and stamp
-- updated_by. updated_at is handled by tg_set_updated_at on the UPDATE below.
-- SECURITY DEFINER so it can update a private parent on the drop-box path.
create or replace function public.tg_job_document_version_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.job_documents
    set current_version = new.id,
        updated_by = new.uploaded_by
    where id = new.document_id;
  return new;
end;
$$;

drop trigger if exists job_document_versions_after_insert on public.job_document_versions;
create trigger job_document_versions_after_insert
  after insert on public.job_document_versions
  for each row execute function public.tg_job_document_version_after_insert();

-- Standard updated_at maintenance on the parent.
drop trigger if exists job_documents_set_updated_at on public.job_documents;
create trigger job_documents_set_updated_at
  before update on public.job_documents
  for each row execute function public.tg_set_updated_at();
