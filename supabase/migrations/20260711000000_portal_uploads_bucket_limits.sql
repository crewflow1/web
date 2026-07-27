-- ---------------------------------------------------------------------------
-- Security hardening — set storage-layer limits on the `portal-uploads` bucket
-- ---------------------------------------------------------------------------
--
-- The bucket was created (20260620000000_portal_uploads.sql) with NO
-- file_size_limit and NO allowed_mime_types, so its only guardrails lived in
-- the application layer (app/customer-portal/_upload-action.ts): a 10 MB cap
-- and a six-type MIME allowlist, both checked before the upload call.
--
-- That is necessary but not sufficient. The portal upload writes through the
-- service-role admin client (createAdminClient → admin.storage.from(
-- 'portal-uploads').upload(...)). Supabase Storage enforces file_size_limit
-- and allowed_mime_types on EVERY .upload() — including the service-role admin
-- client, because they are bucket-level constraints, NOT RLS (service_role
-- bypasses RLS, but not these). Today an upload that reaches the bucket by any
-- path other than the validated action — a future code path, a regression that
-- drops the pre-checks, or a direct authenticated storage call — faces no size
-- or type ceiling at the storage layer. This migration closes that gap:
-- defense-in-depth so the bytes themselves are bounded, not only the one code
-- path that currently writes them.
--
-- The values mirror the app layer EXACTLY so no currently-valid upload starts
-- failing:
--   * file_size_limit    = 10 MB  (MAX_BYTES = 10 * 1024 * 1024 = 10485760)
--   * allowed_mime_types = the ALLOWED_MIME set: pdf, jpeg, png, heic, heif,
--                          webp. (The action's prose comment omits webp, but
--                          the runtime Set and the extension switch both admit
--                          it, so the bucket must too.)
--
-- Idempotent: upsert by id so it is safe to re-run and works whether or not the
-- bucket already exists. Leaves the bucket private (public = false), matching
-- the original definition.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'portal-uploads',
  'portal-uploads',
  false,
  10485760, -- 10 MB per file (matches MAX_BYTES in _upload-action.ts)
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/heic',
    'image/heif',
    'image/webp'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types,
  public = excluded.public;
