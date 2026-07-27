-- Security wave S1 — storage mutation lockdown (service-role-only writes).
--
-- THREAT: a frozen evidence ROW (tenant_attachments etc.) keeps its storage_path, but
-- the OBJECT BYTES were governed by authenticated storage.objects policies that let an
-- org admin DELETE and a member INSERT at the known path — so an insider could delete a
-- delivered evidence object and re-insert different bytes, silently swapping the file the
-- signed URL later serves. The frozen row's size_bytes is the only (weak) tamper signal.
--
-- VERIFIED FACT (16-agent audit, branch feat/storage-evidence-security-wave):
--   * The application performs EVERY storage byte mutation (upload/remove/signed-url) via
--     the service-role admin client (lib/supabase/admin.ts), which BYPASSES storage RLS.
--     Confirmed across all callers: tenant-attachments, compliance-docs, blueprints,
--     job-docs(+private), receipts, job-photos, imports, portal-uploads.
--   * There is NO browser-direct storage write anywhere (lib/supabase/client.ts has zero
--     importers; no createSignedUploadUrl is ever issued).
--   * Therefore every AUTHENTICATED (tenant-JWT) storage.objects INSERT/UPDATE/DELETE
--     policy is DEAD CODE relative to the app — yet each one opens the tamper vector above.
--   * portal-uploads already ships with ZERO authenticated policies (service-role only) and
--     works perfectly — this migration brings every other bucket to that same posture.
--
-- CHANGE: drop the dead authenticated INSERT/UPDATE/DELETE policies on all 8 buckets →
-- default-deny mutation → only the service role (server-only, freeze-trigger-gated app
-- paths) can write/replace/delete bytes. READS ARE DELIBERATELY LEFT UNTOUCHED: the
-- job-photos gallery mints signed URLs on the tenant (RLS) client and genuinely needs its
-- SELECT policy; other SELECT policies are harmless (downloads use service-role signed
-- URLs). Do not conflate mutation lockdown with read behaviour.
--
-- Backward-compat: the DEPLOYED prod app (origin/main 69c32ce == this branch base) already
-- mutates storage exclusively via service-role, so this is migrate-first-safe with no app
-- redeploy required. Additive/reversible: rollback = recreate the dropped policies from
-- their source migrations (20260515160000, 20260515180000, 20260526000000, 20260626000000,
-- 20260704010100, 20261015000100). No data change; storage objects untouched.

-- ---------------------------------------------------------------------------
-- job-photos (src 20260515160000) — keep SELECT ("members can read": LIVE, tenant-client
-- signed URLs in app/api/jobs/[id]/photos/route.ts). Drop member INSERT/UPDATE + admin DELETE.
-- ---------------------------------------------------------------------------
drop policy if exists "job-photos: members can upload" on storage.objects;
drop policy if exists "job-photos: members can update" on storage.objects;
drop policy if exists "job-photos: admins can delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- receipts (src 20260515180000) — keep SELECT. Drop member INSERT/UPDATE + admin DELETE.
-- (The finances route's service-role upsert:true is unaffected — service role bypasses RLS.)
-- ---------------------------------------------------------------------------
drop policy if exists "receipts: members can upload" on storage.objects;
drop policy if exists "receipts: members can update" on storage.objects;
drop policy if exists "receipts: admins can delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- imports (src 20260526000000) — keep SELECT ("admins read"). Drop admin INSERT/DELETE.
-- ---------------------------------------------------------------------------
drop policy if exists "imports: admins upload" on storage.objects;
drop policy if exists "imports: admins delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- compliance-docs (src 20260626000000) — keep SELECT. Drop admin INSERT/DELETE.
-- ---------------------------------------------------------------------------
drop policy if exists "compliance-docs: admins can insert" on storage.objects;
drop policy if exists "compliance-docs: admins can delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- tenant-attachments (src 20260626000000) — keep SELECT. Drop member INSERT + admin DELETE.
-- This is the primary H&S evidence bucket (toolbox signed sheets + evidence-adjacent photos).
-- ---------------------------------------------------------------------------
drop policy if exists "tenant-attachments: members can insert" on storage.objects;
drop policy if exists "tenant-attachments: admins can delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- job-docs + job-docs-private (src 20260704010100) — keep SELECT (private read = admin-only,
-- the drop-box boundary). Drop member INSERT + admin DELETE on both.
-- ---------------------------------------------------------------------------
drop policy if exists "job-docs: members can insert" on storage.objects;
drop policy if exists "job-docs: admins can delete" on storage.objects;
drop policy if exists "job-docs-private: members can insert" on storage.objects;
drop policy if exists "job-docs-private: admins can delete" on storage.objects;

-- ---------------------------------------------------------------------------
-- blueprints (src 20261015000100) — keep SELECT. Drop member INSERT + admin DELETE.
-- (blueprint_versions rows are already insert-only + immutable; this freezes the bytes too.)
-- ---------------------------------------------------------------------------
drop policy if exists "blueprints: members can insert" on storage.objects;
drop policy if exists "blueprints: admins can delete" on storage.objects;

-- After this migration, storage.objects mutation (INSERT/UPDATE/DELETE) is default-deny for
-- the `authenticated` and `anon` roles on every bucket; only the service role can write or
-- delete bytes, exclusively through server-only app paths that enforce the evidence-freeze
-- triggers + owner/admin gates. SELECT policies are unchanged.
