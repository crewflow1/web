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
--   - the policy drops are all IF EXISTS
--
-- ---------------------------------------------------------------------------
-- !! SECURITY: THIS MIGRATION DELIBERATELY CREATES **NO** storage.objects
-- !! POLICIES — NOT insert, NOT update, NOT delete, AND NOT select.
-- ---------------------------------------------------------------------------
-- An earlier draft of this migration (file version 20260712000000, never
-- applied to any long-lived environment — it sorted BEHIND the applied prod
-- migration tip) created four `authenticated` policies on storage.objects:
-- "company-logos: members can read" plus admin insert / update / delete.
-- Those write policies are REMOVED here because they would silently REVERT
-- 20261032000000_storage_evidence_mutation_lockdown.sql, which dropped every
-- authenticated INSERT/UPDATE/DELETE policy on storage.objects across all 8
-- buckets precisely so that byte mutation is SERVICE-ROLE-ONLY. Re-granting
-- tenant-JWT write capability for a new bucket re-opens exactly the tamper
-- vector that lockdown closed (an insider replacing bytes at a known path),
-- and it would do so for zero functional gain:
--
--   * WRITES: server/services/company-logo.ts performs every byte mutation
--     via createAdminClient() (lib/supabase/admin.ts) — service role, which
--     BYPASSES storage RLS. uploadCompanyLogo() uses admin.storage.upload();
--     both the rollback path and deleteCompanyLogo() use admin.storage
--     .remove(). The authoritative permission check is the owner/admin role
--     gate in app code (isLogoAdminRole on the requireOrgContext membership),
--     not a storage policy. So the dropped write policies were DEAD CODE.
--
--   * READS: resolveOrgLogoSrc() mints a short-lived signed URL with the same
--     service-role client (createSignedUrl, LOGO_SIGNED_TTL). A signed URL is
--     authorised by its signature, NOT by RLS on storage.objects, so the
--     browser/PDF fetch of that URL needs no SELECT policy either. There is
--     no browser-direct storage access anywhere in this app (lib/supabase/
--     client.ts has zero importers; no createSignedUploadUrl is ever issued),
--     so no tenant-JWT client ever touches this bucket.
--
-- Net posture: `company-logos` ships default-deny for the `authenticated` and
-- `anon` roles on ALL verbs — the same zero-authenticated-policy posture as
-- the `portal-uploads` bucket, which the lockdown migration cites as the
-- reference implementation ("works perfectly"). This is the most locked-down
-- option that still supports the feature. Do NOT add policies here without
-- first introducing a genuine tenant-client code path that needs them.
--
-- Rollback: drop the bucket row (and optionally logo_path). No data change to
-- existing rows; storage objects untouched.
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

-- ----- storage.objects RLS: none, and actively cleaned up -------------------
-- Defensive, idempotent teardown. Any environment (a local `supabase db
-- reset`, a preview branch, a developer machine) that applied the earlier
-- 20260712000000 draft of this file already has the four policies below. These
-- drops make the lockdown posture self-healing there instead of leaving a
-- tenant-writable bucket behind. On a clean database they are all no-ops.
--
-- storage.objects has RLS enabled with no matching policy for `authenticated`
-- or `anon` on this bucket → default deny on SELECT/INSERT/UPDATE/DELETE.
-- Only the service role (which bypasses RLS) can read or write these bytes.
drop policy if exists "company-logos: members can read" on storage.objects;
drop policy if exists "company-logos: admins can insert" on storage.objects;
drop policy if exists "company-logos: admins can update" on storage.objects;
drop policy if exists "company-logos: admins can delete" on storage.objects;
