-- Security wave S0 (P0) — bind attachment storage_path to its owning org.
--
-- LIVE CROSS-TENANT READ PRIMITIVE (present in prod at 69c32ce; NOT introduced by this
-- wave — discovered by the wave's cross-tenant red-team). The signed-URL minters sign the
-- storage_path taken from a row, on the SERVICE-ROLE client, after only an RLS row read:
--   components/attachments/actions.ts (tenant-attachments), app/(app)/compliance/actions.ts
--   (compliance-docs), server/services/blueprints.ts (blueprints),
--   server/services/job-documents.ts (job-docs) — none checks the path's org prefix.
-- The backing tables (tenant_attachments / compliance_documents / blueprint_versions /
-- job_document_versions) gate INSERT on org_id ONLY — nothing binds storage_path to org_id.
-- So an authenticated member can direct-PostgREST-insert a row in THEIR org whose
-- storage_path points at ANOTHER org's object, then call the app's signer for that row and
-- receive a working signed URL for the other org's file. Precondition: the attacker knows
-- the target's full path (its last segment is a random UUID, not enumerable) — but the path
-- leaks in exactly the artefact the system hands out (a 60s signed URL: forwarded, logged,
-- screenshotted), and a re-inserted path re-mints fresh URLs indefinitely. Cross-tenant READ.
--
-- FIX (defence in depth; DB is the load-bearing backstop per the H&S epic doctrine):
--   * DB (here): a BEFORE INSERT OR UPDATE trigger on all four tables asserts the
--     storage_path's first path segment equals org_id — a poisoned row cannot be written.
--     JWT-gated (auth.uid() present): the browser attack surface. The trusted service role
--     (server-only app writes + fixtures) is exempt and always writes org-first paths anyway.
--   * App (separate commit): each signer verifies the path is org-owned before signing —
--     covers any pre-existing row and is belt-and-suspenders.
--
-- All four legitimate path templates are org-first (built server-side from ctx.org.id):
--   tenant_attachments   ${org}/${target}/${targetId}/${uuid}.${ext}
--   compliance_documents ${org}/${uuid}.${ext}
--   blueprint_versions   ${org}/${jobId}/${blueprintId}/${fileId}.${ext}
--   job_document_versions ${org}/${jobId}/${docId}/${fileId}.${ext}
-- so the invariant holds for every existing row; the trigger only rejects a crafted mismatch.
--
-- Additive + reversible: two disjoint objects (a function + four triggers). No data change,
-- no column change, no table rewrite. Rollback: drop the four triggers + the function.

create or replace function public.tg_assert_storage_path_org()
returns trigger language plpgsql set search_path = public as $$
begin
  -- Evidence/attachment storage keys are ALWAYS org-first. A row whose storage_path
  -- org-segment != org_id is a poisoned cross-tenant pointer (the signed-URL minters would
  -- sign it for another org). JWT-gated: the trusted service role (auth.uid() null) writes
  -- org-first paths itself and is exempt, preserving the born-draft/issue-gate asymmetry.
  if auth.uid() is not null
     and split_part(new.storage_path, '/', 1) is distinct from new.org_id::text then
    raise exception 'storage_path must live under the owning org (% is not under %)',
      new.storage_path, new.org_id using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists tenant_attachments_assert_org_path on public.tenant_attachments;
create trigger tenant_attachments_assert_org_path
  before insert or update on public.tenant_attachments
  for each row execute function public.tg_assert_storage_path_org();

drop trigger if exists compliance_documents_assert_org_path on public.compliance_documents;
create trigger compliance_documents_assert_org_path
  before insert or update on public.compliance_documents
  for each row execute function public.tg_assert_storage_path_org();

drop trigger if exists blueprint_versions_assert_org_path on public.blueprint_versions;
create trigger blueprint_versions_assert_org_path
  before insert or update on public.blueprint_versions
  for each row execute function public.tg_assert_storage_path_org();

drop trigger if exists job_document_versions_assert_org_path on public.job_document_versions;
create trigger job_document_versions_assert_org_path
  before insert or update on public.job_document_versions
  for each row execute function public.tg_assert_storage_path_org();
