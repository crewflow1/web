-- ---------------------------------------------------------------------------
-- FEATURE 2 — Universal document-to-form autofill: the private upload bucket
-- ---------------------------------------------------------------------------
--
-- A tenant-scoped private bucket that holds the ORIGINAL document an operator
-- uploads when they click "Import" next to a create button (a PDF, a photo, a
-- screenshot). The bytes are a transient aid: a vision model reads them once to
-- propose form values, the operator reviews those values, and the document is
-- then retained only long enough to let the operator re-open an in-flight import
-- (see the retention note below and `purgeExpiredFormImports`).
--
-- WHY A DEDICATED BUCKET, not the Migration-OS `imports` bucket. The `imports`
-- bucket is admin-only (its RLS is `is_org_admin`), because bulk data migration
-- is an owner/admin act. Per-record autofill is NOT: a site manager with
-- `customers:create` or a member who can raise a job must be able to import one
-- document into one form. A separate bucket lets this surface carry its own,
-- correctly-scoped RLS without widening the migration bucket's admin gate.
--
-- STORAGE PATH CONTRACT: `{org_id}/{draft_id}/{filename}`. The FIRST folder
-- segment is the owning org — every policy below pins on it, so an object can
-- only ever live under, and be read from, a folder whose name is an org the
-- caller belongs to. The second segment is the `form_import_drafts` row id
-- (migration 20261265000000), which ties the bytes to their extraction draft.
--
-- BUCKET-LEVEL LIMITS are defence-in-depth. Supabase enforces `file_size_limit`
-- and `allowed_mime_types` on EVERY `.upload()` — including the service-role
-- admin client, because they are bucket constraints, not RLS (service_role
-- bypasses RLS, never these). The upload action validates the same limits before
-- it writes, so a regression that drops the app-layer check still cannot land an
-- oversized or wrong-typed object. The MIME allowlist is exactly the set the
-- vision extractor can actually read (PDF + the raster image formats); the
-- `<ImportButton>` `accept` attribute mirrors it. Office documents are NOT
-- admitted here: they are not a document block the vision door accepts, so
-- admitting them would store bytes nothing can extract (documented as an
-- explicit Phase-2 follow-up in docs/imports/DOCUMENT-AUTOFILL.md).
--
-- 15 MB per file: a multi-page scanned PDF comfortably fits; it is larger than
-- the 10 MB receipt/portal ceilings because an imported quote or RAMS can run to
-- several pages, and smaller than the 50 MB Migration-OS archive ceiling.
--
-- Idempotent: upsert by id, so it is safe to re-run and works whether or not the
-- bucket already exists. Private (public = false) — a signed URL is the only way
-- to read an object, and only the owning operator can mint one (SELECT policy).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'form-imports',
  'form-imports',
  false,
  15728640, -- 15 MB per file (15 * 1024 * 1024)
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- RLS on storage.objects for the `form-imports` bucket.
--
-- LEAST PRIVILEGE, two independent locks:
--   1. ORG: the first path segment must be an org the caller belongs to
--      (`current_org_ids()`). This is the tenant-isolation boundary — a member
--      of org B can never read, write, or delete an object under org A's folder,
--      even by guessing the path.
--   2. OWNER: read and delete additionally require `owner = auth.uid()`, so an
--      operator only ever sees back the documents THEY uploaded, not other
--      members' in-flight imports. The capability gate ("can this user create
--      THIS record type") lives in the server action, which is where a
--      per-module decision belongs — storage RLS cannot know a form type.
--
-- The bytes are never served publicly; the app reads them server-side (admin
-- client) only to run the one governed extraction, and mints a short-lived
-- signed URL for the operator's own review thumbnail where needed.
-- ---------------------------------------------------------------------------

drop policy if exists "form-imports: owner reads own org objects" on storage.objects;
create policy "form-imports: owner reads own org objects"
on storage.objects for select to authenticated
using (
  bucket_id = 'form-imports'
  and owner = auth.uid()
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "form-imports: members upload to own org" on storage.objects;
create policy "form-imports: members upload to own org"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'form-imports'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);

drop policy if exists "form-imports: owner deletes own org objects" on storage.objects;
create policy "form-imports: owner deletes own org objects"
on storage.objects for delete to authenticated
using (
  bucket_id = 'form-imports'
  and owner = auth.uid()
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
);
