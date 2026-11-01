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
-- NO tenant RLS policy on storage.objects for this bucket — BY DESIGN.
--
-- The 20261032 storage-mutation lockdown made byte mutation on storage.objects
-- SERVICE-ROLE-ONLY (no `authenticated` INSERT/UPDATE/DELETE on any bucket), and
-- __tests__/security/storage-company-logos-lockdown.test.ts pins that no later
-- migration may revert it for ANY bucket. This bucket honours that, the same way
-- `company-logos` and `portal-uploads` do:
--
--   * WRITES go through the server action only. `startDocumentImport`
--     (server/services/document-autofill.ts) uploads via `createAdminClient()`
--     (service_role, which bypasses RLS), with the org-id path segment pinned
--     from the validated session — so tenant isolation is enforced in code at the
--     one write path, not by a tenant storage policy. The discard path removes
--     the object via the same service-role client.
--   * READS, if ever needed for a review thumbnail, are SERVICE-MINTED SIGNED
--     URLs (authorised by signature, not RLS) — again from the server action.
--
-- The bucket therefore needs no `storage.objects` policy at all: a tenant client
-- can neither read nor write it directly, and every legitimate access is a
-- service-role call behind the authenticated, capability-checked server action.
-- The bucket stays private (public = false) and its byte limits above still apply
-- to the service-role upload (bucket constraints are not RLS).
-- ---------------------------------------------------------------------------
