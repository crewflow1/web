-- P4 Job Documents — storage buckets + RLS.
-- Two physically separate buckets so the private/staff boundary is enforced on
-- the bytes themselves, not only at the table layer:
--   job-docs         → staff area; any org member may read/write.
--   job-docs-private → company-private; owner/admin READ, members may INSERT
--                      (write-only drop box), admin delete. Staff can never
--                      SELECT, so private signed URLs only succeed via the
--                      service-role client after a server-side admin check.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('job-docs', 'job-docs', false, 26214400, array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv'
  ]),
  ('job-docs-private', 'job-docs-private', false, 26214400, array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv'
  ])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = excluded.public;

-- First path segment is the org_id: `${org_id}/${jobId}/${docId}/v${n}.${ext}`.

-- job-docs (staff area) -----------------------------------------------------
drop policy if exists "job-docs: members can read" on storage.objects;
create policy "job-docs: members can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-docs'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "job-docs: members can insert" on storage.objects;
create policy "job-docs: members can insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'job-docs'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "job-docs: admins can delete" on storage.objects;
create policy "job-docs: admins can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-docs'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

-- job-docs-private (company-private) ----------------------------------------
-- READ is admin-only: the hard security boundary. Staff JWTs get zero rows, so
-- they cannot download or even list private files.
drop policy if exists "job-docs-private: admins can read" on storage.objects;
create policy "job-docs-private: admins can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'job-docs-private'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

-- INSERT open to any org member: the write-only drop box. Staff can upload but
-- never read back.
drop policy if exists "job-docs-private: members can insert" on storage.objects;
create policy "job-docs-private: members can insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'job-docs-private'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "job-docs-private: admins can delete" on storage.objects;
create policy "job-docs-private: admins can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'job-docs-private'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );
