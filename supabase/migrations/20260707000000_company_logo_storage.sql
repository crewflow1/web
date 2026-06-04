-- ============================================================================
-- Company logo upload — replace the free-text logo_url with a securely
-- uploaded image stored in CrewFlow storage.
--
-- Before: organizations.logo_url held an arbitrary external https URL pasted
--   into the settings form. That URL was fetched server-side by the PDF
--   renderer and embedded on public quote/portal pages — an SSRF / tracking-
--   pixel / broken-link surface, and not a real "upload your logo" flow.
--
-- After: owners/admins upload an image file. The bytes live in the private
--   `company-logos` bucket, the object path is recorded in the new
--   organizations.logo_path column, and every display surface resolves a
--   short-lived signed URL server-side (see server/services/company-logo.ts).
--   The legacy logo_url column is RETAINED for backward-compatible display of
--   logos set before this change — the app prefers logo_path and only falls
--   back to a legacy logo_url; the settings UI no longer writes logo_url.
--
-- This migration is additive + idempotent + non-destructive:
--   - logo_path uses ADD COLUMN IF NOT EXISTS (no data touched, logo_url kept)
--   - the bucket row uses ON CONFLICT DO UPDATE
--   - policies use DROP POLICY IF EXISTS before CREATE
-- ============================================================================

-- ----- schema: new nullable column (legacy logo_url left intact) ------------
alter table public.organizations
  add column if not exists logo_path text;

-- ----- storage bucket -------------------------------------------------------
-- Private (public=false): the logo is only ever read server-side via the
-- service-role client (signed URLs for pages/PDFs, direct download otherwise),
-- matching every other bucket in this app. 2 MB cap; image formats only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'company-logos',
  'company-logos',
  false,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ----- storage.objects RLS --------------------------------------------------
-- Object path convention: `<org_id>/logo-<uuid>.<ext>`. The first path segment
-- is the org_id, so policies derive tenancy from the path with no join.
-- Reads: any member of the owning org. Writes (insert/update/delete): owners
-- and admins of the owning org ONLY — staff/members cannot change the logo.
-- The service role bypasses these policies; they are defence-in-depth for any
-- direct authenticated access to storage.

drop policy if exists "company-logos: members can read" on storage.objects;
create policy "company-logos: members can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'company-logos'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "company-logos: admins can insert" on storage.objects;
create policy "company-logos: admins can insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'company-logos'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

drop policy if exists "company-logos: admins can update" on storage.objects;
create policy "company-logos: admins can update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'company-logos'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  )
  with check (
    bucket_id = 'company-logos'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

drop policy if exists "company-logos: admins can delete" on storage.objects;
create policy "company-logos: admins can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'company-logos'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );
