-- Wave 5 — Migration OS
--
-- Goal: a construction company uploads existing data and CrewFlow rebuilds
-- their company. Four tables back the wizard:
--
--   imports         — one row per "import session" (upload → detect →
--                     preview → commit). Status drives the wizard UI.
--   import_files    — files attached to a session (csv/xlsx). One session
--                     can have many files.
--   import_rows     — every row extracted from every file, with the
--                     entity_type CrewFlow thinks it is + confidence
--                     + mapped jsonb (canonicalised data to insert).
--   import_audit    — for every inserted target row, we store
--                     (target_table, target_id, source_row_id) so we
--                     can roll back the whole session.
--
-- Storage bucket: `imports` — uploads sit there until commit. Object path
-- is `<org_id>/<import_id>/<filename>`.

-- ---------------------------------------------------------------------------
-- imports
-- ---------------------------------------------------------------------------

create table if not exists public.imports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  name          text not null,
  status        text not null default 'uploaded'
    check (status in ('uploaded', 'detected', 'committed', 'rolled_back', 'failed')),
  created_by    uuid references public.users(id) on delete set null,
  committed_at  timestamp with time zone,
  rolled_back_at timestamp with time zone,
  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now()
);

create index if not exists imports_org_created_idx on public.imports (org_id, created_at desc);

drop trigger if exists imports_set_updated_at on public.imports;
create trigger imports_set_updated_at before update on public.imports
  for each row execute function public.tg_set_updated_at();

alter table public.imports enable row level security;

-- Admins only — bulk import is a destructive-ish operation.
drop policy if exists "imports: admin all" on public.imports;
create policy "imports: admin all" on public.imports
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- import_files
-- ---------------------------------------------------------------------------

create table if not exists public.import_files (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  import_id     uuid not null references public.imports(id) on delete cascade,
  filename      text not null,
  storage_path  text not null,
  mime_type     text,
  size_bytes    integer,
  row_count     integer not null default 0,
  created_at    timestamp with time zone not null default now()
);

create index if not exists import_files_import_idx on public.import_files (import_id);

alter table public.import_files enable row level security;

drop policy if exists "import_files: admin all" on public.import_files;
create policy "import_files: admin all" on public.import_files
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- import_rows
-- ---------------------------------------------------------------------------
-- Stores every parsed-row's raw + canonicalised payload. We keep both so
-- the operator can see exactly what was inferred from what.

create table if not exists public.import_rows (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organizations(id) on delete cascade,
  import_id         uuid not null references public.imports(id) on delete cascade,
  file_id           uuid not null references public.import_files(id) on delete cascade,
  source_row_number integer not null,
  raw               jsonb not null,
  entity_type       text
    check (entity_type in ('customer', 'invoice', 'lead', 'staff', 'cost', 'supplier', 'unknown') or entity_type is null),
  confidence        smallint not null default 0,
  mapped            jsonb,
  status            text not null default 'pending'
    check (status in ('pending', 'imported', 'skipped', 'error', 'duplicate', 'merged')),
  duplicate_of_id   uuid,
  error_message     text,
  target_table      text,
  target_id         uuid,
  created_at        timestamp with time zone not null default now(),
  updated_at        timestamp with time zone not null default now()
);

create index if not exists import_rows_import_idx on public.import_rows (import_id);
create index if not exists import_rows_entity_idx on public.import_rows (import_id, entity_type);

drop trigger if exists import_rows_set_updated_at on public.import_rows;
create trigger import_rows_set_updated_at before update on public.import_rows
  for each row execute function public.tg_set_updated_at();

alter table public.import_rows enable row level security;

drop policy if exists "import_rows: admin all" on public.import_rows;
create policy "import_rows: admin all" on public.import_rows
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- import_audit
-- ---------------------------------------------------------------------------
-- One row per inserted target row, so rollback can delete them all.

create table if not exists public.import_audit (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references public.organizations(id) on delete cascade,
  import_id       uuid not null references public.imports(id) on delete cascade,
  import_row_id   uuid references public.import_rows(id) on delete set null,
  target_table    text not null,
  target_id       uuid not null,
  created_at      timestamp with time zone not null default now()
);

create index if not exists import_audit_import_idx on public.import_audit (import_id);
create index if not exists import_audit_target_idx on public.import_audit (target_table, target_id);

alter table public.import_audit enable row level security;

drop policy if exists "import_audit: admin all" on public.import_audit;
create policy "import_audit: admin all" on public.import_audit
  for all to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

-- ---------------------------------------------------------------------------
-- storage bucket: imports
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports',
  'imports',
  false,
  52428800, -- 50 MB per file (xlsx exports get chunky)
  array[
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Object path convention: `<org_id>/<import_id>/<filename>`
drop policy if exists "imports: admins read" on storage.objects;
create policy "imports: admins read"
on storage.objects for select to authenticated
using (
  bucket_id = 'imports'
  and public.is_org_admin((storage.foldername(name))[1]::uuid)
);

drop policy if exists "imports: admins upload" on storage.objects;
create policy "imports: admins upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'imports'
  and public.is_org_admin((storage.foldername(name))[1]::uuid)
);

drop policy if exists "imports: admins delete" on storage.objects;
create policy "imports: admins delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'imports'
  and public.is_org_admin((storage.foldername(name))[1]::uuid)
);

-- ---------------------------------------------------------------------------
-- activity log
-- ---------------------------------------------------------------------------

create or replace function public._tg_imports_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public._record_activity(
      new.org_id, 'import.created', 'imports', new.id,
      jsonb_build_object('name', new.name)
    );
  elsif tg_op = 'UPDATE' then
    if old.status != new.status then
      perform public._record_activity(
        new.org_id, 'import.' || new.status, 'imports', new.id,
        jsonb_build_object('name', new.name)
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists imports_activity on public.imports;
create trigger imports_activity
  after insert or update on public.imports
  for each row execute function public._tg_imports_activity();
