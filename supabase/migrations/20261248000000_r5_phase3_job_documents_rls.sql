-- ============================================================================
-- R5 Phase 3 (slice 4) — job_documents + job_document_versions SELECT.
-- ============================================================================
-- Narrows the STAFF-visibility document area to ASSIGNED jobs. The private area
-- is unchanged (owner/admin only). After this:
--   • owner/admin: every document in the org (staff + private);
--   • staff: a 'staff'-visibility document ONLY for a job they are assigned to;
--   • staff: still NO private documents (the drop box stays admin-read-only).
-- INSERT/UPDATE/DELETE policies are UNCHANGED — this slice narrows READ only.
--
-- WHY THIS ALSO SECURES DOWNLOADS (the signed-URL capability). A signed URL
-- bypasses RLS once minted, so the authorization must happen at MINT time.
-- getJobDocumentDownloadUrl (server/services/job-documents.ts) deliberately
-- reads the version row via the TENANT (user-JWT) client under RLS and treats
-- "row not visible ⇒ not_found, never reach the signing step" as the access
-- check. So narrowing job_document_versions SELECT here AUTOMATICALLY stops a
-- staff member being minted a signed URL for a non-assigned job's document — no
-- application change is needed, and the two stay in lockstep by construction.
--
-- VERSIONS have no job_id of their own (only document_id + a denormalized
-- visibility), so — like the material_request_lines grandchild — they are scoped
-- through a self-scoped SECURITY DEFINER helper that resolves the caller's
-- assigned-job documents. No args (keyed on auth.uid()), so the secdef-org-rpc
-- guard does not apply.
--
-- WRITE PATHS are intentionally out of scope here (Phase 3 = read isolation):
-- addJobDocumentVersion already reads its parent via the service-role client and
-- re-checks org ownership, so it is unaffected; a staff member cannot DISCOVER a
-- non-assigned job's document id under the narrowed SELECT, so the residual
-- "write a version to a guessed id" is a low-risk, separately-tracked item.
--
-- LOCKOUT ANALYSIS: owners/admins unaffected (is_org_admin branch). Staff lose
-- read/download of non-assigned-job staff documents — the intended tightening.
-- ROLLBACK:
--   drop function if exists public.my_assigned_job_document_ids();
--   -- recreate both SELECT policies with the pre-narrowing predicate
--   -- (visibility = 'staff' or is_org_admin(org_id)) from 20260704010000.
-- ============================================================================

-- Self-scoped: job_documents whose job the caller is assigned to.
create or replace function public.my_assigned_job_document_ids()
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.job_documents
  where job_id in (select public.my_assigned_job_ids());
$$;

drop policy if exists "job_documents: select staff or admin" on public.job_documents;
create policy "job_documents: select staff or admin"
  on public.job_documents for select
  using (
    org_id in (select public.current_org_ids())
    and (
      public.is_org_admin(org_id)
      or (visibility = 'staff' and job_id in (select public.my_assigned_job_ids()))
    )
  );

drop policy if exists "job_document_versions: select staff or admin" on public.job_document_versions;
create policy "job_document_versions: select staff or admin"
  on public.job_document_versions for select
  using (
    org_id in (select public.current_org_ids())
    and (
      public.is_org_admin(org_id)
      or (visibility = 'staff' and document_id in (select public.my_assigned_job_document_ids()))
    )
  );
