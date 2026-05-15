-- Storage: create the `job-photos` bucket and its access policies.
--
-- Bucket config:
--   - id/name: 'job-photos'
--   - private (no anonymous read)
--   - 10 MB max per file
--   - mime allowlist: jpeg/png/webp/heic/heif  (site-photo formats)
--
-- Object path convention: `<org_id>/<job_id>/<filename>`
--   The first path segment is the org_id, which lets RLS policies derive
--   tenancy without joining other tables.
--
-- Policies on storage.objects (this is where Supabase Storage RLS lives):
--   - SELECT: any member of the org that owns the folder.
--   - INSERT: any member of the org that owns the folder.
--   - UPDATE: any member of the org that owns the folder.
--   - DELETE: admins/owners of the org that owns the folder.
--
-- Idempotent: bucket row uses ON CONFLICT; policies use DROP POLICY IF EXISTS.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-photos',
  'job-photos',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The first path component (split by '/') is the org_id (uuid-as-text).
-- storage.foldername(name) returns text[]; element 1 is the first folder.

drop policy if exists "job-photos: members can read" on storage.objects;
create policy "job-photos: members can read"
on storage.objects for select to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "job-photos: members can upload" on storage.objects;
create policy "job-photos: members can upload"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "job-photos: members can update" on storage.objects;
create policy "job-photos: members can update"
on storage.objects for update to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
)
with check (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "job-photos: admins can delete" on storage.objects;
create policy "job-photos: admins can delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'job-photos'
  and public.is_org_admin((storage.foldername(name))[1]::uuid)
);
