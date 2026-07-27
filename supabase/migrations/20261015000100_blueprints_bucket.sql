-- Blueprint Centre — private storage bucket + storage RLS.
--
-- One private `blueprints` bucket (no staff/private split). Storage RLS mirrors
-- the job-docs STAFF shape (members read/insert, admins delete) — NOT the
-- admin-only-read private shape — because the register is operator-facing: the
-- whole crew must see the current drawing. Org-scoped path
-- `${org_id}/${job_id}/${blueprint_id}/${fileId}.${ext}` (org_id first segment
-- so path RLS can scope by it). 50 MB limit (drawing sets are large). Drawing
-- MIME only, and images that render inline natively (no HEIC — desktop browsers
-- can't display it in <img>, and the foundation viewer is native).
--
-- IDEMPOTENT create. This bucket is NEVER dropped by a down-migration (that
-- would fail on existing objects or permanently delete customer drawings).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('blueprints', 'blueprints', false, 52428800, array[
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types,
      public = excluded.public;

drop policy if exists "blueprints: members can read" on storage.objects;
create policy "blueprints: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'blueprints'
         and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));

drop policy if exists "blueprints: members can insert" on storage.objects;
create policy "blueprints: members can insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'blueprints'
         and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));

drop policy if exists "blueprints: admins can delete" on storage.objects;
create policy "blueprints: admins can delete" on storage.objects for delete to authenticated
  using (bucket_id = 'blueprints'
         and public.is_org_admin((split_part(name, '/', 1))::uuid));
