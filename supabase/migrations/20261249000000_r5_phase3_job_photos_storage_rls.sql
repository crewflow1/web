-- ============================================================================
-- R5 Phase 3 (slice 5) — job-photos STORAGE read narrowed to assigned jobs.
-- ============================================================================
-- The job-photos bucket stores objects at `<org_id>/<job_id>/<filename>`. Its
-- SELECT policy was ORG-WIDE (any member of the owning org), so a staff member
-- could mint a signed URL for ANY job's photo in their org by addressing the
-- object path directly through supabase.storage — bypassing the assigned-job
-- model (a uuid-guess IDOR: org_id is known, job_id is the guessable segment).
--
-- The primary read path, GET /api/jobs/[id]/photos, is already gated — it reads
-- the job via the user client under the Phase-2-narrowed jobs policy and 404s a
-- non-assigned staff member before signing. This slice closes the DIRECT-storage
-- residual so the capability matches the model on every path: admins read any
-- of the org's photos; staff read only photos whose job (path segment 2) they
-- are assigned to.
--
-- INSERT/UPDATE stay org-wide (uploads are route-gated on a jobs read; write
-- narrowing is out of scope for read-isolation Phase 3). DELETE stays admin-only.
--
-- CAST SAFETY. The predicate parses a uuid out of the object name, so a
-- malformed name (missing segment / non-uuid) must fail CLOSED, never throw and
-- break the policy for everyone. The existing policy already casts segment [1];
-- segment [2] is parsed inside a SECURITY DEFINER helper that traps a bad cast
-- and returns false. The helper takes no org id (keyed on auth.uid()), so the
-- secdef-org-rpc guard does not apply.
--
-- ROLLBACK:
--   drop policy if exists "job-photos: members can read" on storage.objects;
--   create policy "job-photos: members can read" on storage.objects
--     for select to authenticated using (
--       bucket_id = 'job-photos'
--       and (storage.foldername(name))[1]::uuid in (select public.current_org_ids()));
--   drop function if exists public.job_photo_path_assigned(text);
-- ============================================================================

-- True when the object's job segment resolves to a job the caller is assigned to.
-- Fails closed on any malformed path. SECURITY DEFINER so my_assigned_job_ids()
-- (itself definer) resolves free of RLS; STABLE; no org-id argument.
create or replace function public.job_photo_path_assigned(object_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  parts text[] := storage.foldername(object_name);
  jid uuid;
begin
  if parts is null or array_length(parts, 1) < 2 then
    return false;
  end if;
  begin
    jid := parts[2]::uuid;
  exception when others then
    return false;
  end;
  return jid in (select public.my_assigned_job_ids());
end;
$$;

drop policy if exists "job-photos: members can read" on storage.objects;
create policy "job-photos: members can read"
on storage.objects for select to authenticated
using (
  bucket_id = 'job-photos'
  and (storage.foldername(name))[1]::uuid in (select public.current_org_ids())
  and (
    public.is_org_admin((storage.foldername(name))[1]::uuid)
    or public.job_photo_path_assigned(name)
  )
);
