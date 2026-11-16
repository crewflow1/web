-- 20261354000000 — stored files are readable only by people who may see the record they belong to.
--
-- WHY (same-company least privilege, founder ruling D-17): seven Storage buckets let ANY member of
-- a company read every object under the company's folder, whatever their role. D-17 narrowed the
-- DATABASE rows staff can see (financial, contractual and sensitive administrative records are
-- owner/admin), but the files behind those rows were still downloadable by a staff JWT straight
-- from the Storage API. `tenant_attachments` rows were also readable org-wide, so a staff member
-- could enumerate attachments on invoices, quotes, suppliers, customers, leads and colleagues'
-- staff records and obtain a signed link through the attachment signer.
--
-- RULE AFTER THIS MIGRATION: an object is readable by an owner/admin of the company, OR by a member
-- who can see (under that table's own row-level security) the database row that references the
-- object. Row visibility is the single source of truth, so the file follows whatever D-17 already
-- decided for the record. `job-photos` already follows this rule (job_photo_path_assigned) and is
-- untouched; `job-docs-private` and `imports` are already admin-only.
--
-- App impact: none intended — every app read of these buckets signs with the service role after a
-- row-level-security read of the referencing row. Only direct Storage API reads change.
--
-- Rollback: recreate each "<bucket>: members can read" policy with its previous predicate
--   (bucket_id = '<bucket>' and split_part(name,'/',1)::uuid in (select current_org_ids()))
-- (receipts / whatsapp-media used (storage.foldername(name))[1]); recreate tenant_attachments_select
-- as (org_id in (select current_org_ids())); drop function tenant_attachment_visible;
-- drop index tenant_attachments_storage_path_uidx.

begin;

-- ── 1. tenant_attachments rows ─────────────────────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: the parent-row probe must run under the CALLER's row-level security.
create or replace function public.tenant_attachment_visible(
  p_org_id uuid,
  p_target_table text,
  p_target_id uuid,
  p_uploaded_by uuid
)
returns boolean
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_visible boolean;
begin
  if p_org_id is null or p_target_id is null then
    return false;
  end if;
  if not (p_org_id in (select public.current_org_ids())) then
    return false;
  end if;
  if public.is_org_admin(p_org_id) then
    return true;
  end if;
  -- A member may always see a file they uploaded themselves.
  if p_uploaded_by is not null and p_uploaded_by = auth.uid() then
    return true;
  end if;
  -- Staff records: only the person the record belongs to (right-to-work, contracts, certificates).
  if p_target_table = 'memberships' then
    return exists (
      select 1 from public.memberships m
       where m.id = p_target_id and m.org_id = p_org_id and m.user_id = auth.uid()
    );
  end if;
  -- Commercial and customer records: owner/admin only (D-17: contracts, financial and
  -- sensitive administrative documents are restricted).
  if p_target_table = any (array['customers', 'quotes', 'invoices', 'suppliers', 'leads']) then
    return false;
  end if;
  -- Operational records: visible exactly when the parent row is visible to the caller.
  if not (p_target_table = any (array[
    'jobs', 'snags', 'site_diary_entries', 'toolbox_talks', 'site_reports', 'assets',
    'asset_assignments', 'asset_inspections', 'asset_maintenance_cases', 'asset_fuel_logs',
    'goods_received_notes', 'inspection_signoffs', 'non_conformance_reports', 'blueprint_pins',
    'asset_calibration_certificates', 'variation_requests'
  ])) then
    return false;  -- unknown target: deny
  end if;
  execute format('select exists (select 1 from public.%I t where t.id = $1)', p_target_table)
     into v_visible
    using p_target_id;
  return coalesce(v_visible, false);
end
$function$;

revoke all on function public.tenant_attachment_visible(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.tenant_attachment_visible(uuid, text, uuid, uuid) to authenticated, service_role;

drop policy if exists tenant_attachments_select on public.tenant_attachments;
create policy tenant_attachments_select on public.tenant_attachments
  for select to authenticated
  using (
    org_id in (select public.current_org_ids())
    and public.tenant_attachment_visible(org_id, target_table, target_id, uploaded_by)
  );

-- ONE row per stored object. Without this, a member could insert a SECOND row that points at an
-- existing object they may not see (their own row is visible to them as its uploader) and the
-- Storage policy below would then admit the read. Every writer generates a fresh path; production
-- had 0 rows and 0 duplicate paths when this was written (read-only check, 2026-11-16).
create unique index if not exists tenant_attachments_storage_path_uidx
  on public.tenant_attachments (storage_path);

-- ── 2. Storage reads follow the referencing row ────────────────────────────────────────────────
-- Each subquery runs under the caller's row-level security on the public table, so it returns a
-- row only when the caller may see it.

drop policy if exists "tenant-attachments: members can read" on storage.objects;
create policy "tenant-attachments: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-attachments'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin((split_part(name, '/', 1))::uuid)
      or exists (select 1 from public.tenant_attachments a where a.storage_path = name)
    )
  );

drop policy if exists "compliance-docs: members can read" on storage.objects;
create policy "compliance-docs: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'compliance-docs'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin((split_part(name, '/', 1))::uuid)
      or exists (select 1 from public.compliance_documents d where d.storage_path = name)
      or exists (select 1 from public.staff_qualifications q where q.document_path = name)
    )
  );

drop policy if exists "receipts: members can read" on storage.objects;
create policy "receipts: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and ((storage.foldername(name))[1])::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin(((storage.foldername(name))[1])::uuid)
      or exists (select 1 from public.finances f where f.receipt_url = name)
      or exists (
        select 1 from public.expense_drafts e
         where name like e.org_id::text || '/drafts/' || e.upload_id::text || '.%'
      )
    )
  );

drop policy if exists "signatures: members can read" on storage.objects;
create policy "signatures: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'signatures'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin((split_part(name, '/', 1))::uuid)
      or exists (select 1 from public.signatures s where s.signature_image_path = name)
      or exists (select 1 from public.safety_acknowledgements s where s.signature_image_path = name)
      or exists (select 1 from public.site_inductions s where s.signature_image_path = name)
      or exists (select 1 from public.worker_acknowledgements s where s.signature_image_path = name)
    )
  );

drop policy if exists "job-docs: members can read" on storage.objects;
create policy "job-docs: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'job-docs'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin((split_part(name, '/', 1))::uuid)
      or exists (select 1 from public.job_document_versions v where v.storage_path = name)
    )
  );

drop policy if exists whatsapp_media_read on storage.objects;
create policy whatsapp_media_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'whatsapp-media'
    and ((storage.foldername(name))[1])::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin(((storage.foldername(name))[1])::uuid)
      or exists (select 1 from public.whatsapp_inbound_media m where m.storage_path = name)
    )
  );

drop policy if exists "blueprints: members can read" on storage.objects;
create policy "blueprints: members can read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'blueprints'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
    and (
      public.is_org_admin((split_part(name, '/', 1))::uuid)
      or exists (select 1 from public.blueprint_versions v where v.storage_path = name)
    )
  );

commit;
