-- ============================================================================
-- Storage RLS hardening — compliance-docs + tenant-attachments buckets.
--
-- These buckets were created public=false in 20260623000000 but ship without
-- explicit storage.objects policies. Default behaviour denies anonymous /
-- authenticated reads (only service_role works), so the app's signed-URL
-- flow keeps working — but defence-in-depth says: write the policy out
-- explicitly so a future change to bucket defaults (or accidental policy
-- edit) can't open the door.
--
-- Pattern matches the existing job-photos + receipts buckets: the first
-- path segment is the org_id; members of that org can read/write/delete.
-- Service role bypasses all policies regardless.
-- ============================================================================

-- ----- compliance-docs ------------------------------------------------------

drop policy if exists "compliance-docs: members can read" on storage.objects;
create policy "compliance-docs: members can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'compliance-docs'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "compliance-docs: admins can insert" on storage.objects;
create policy "compliance-docs: admins can insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'compliance-docs'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

drop policy if exists "compliance-docs: admins can delete" on storage.objects;
create policy "compliance-docs: admins can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'compliance-docs'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );

-- ----- tenant-attachments ---------------------------------------------------

drop policy if exists "tenant-attachments: members can read" on storage.objects;
create policy "tenant-attachments: members can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'tenant-attachments'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "tenant-attachments: members can insert" on storage.objects;
create policy "tenant-attachments: members can insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenant-attachments'
    and (split_part(name, '/', 1))::uuid in (select public.current_org_ids())
  );

drop policy if exists "tenant-attachments: admins can delete" on storage.objects;
create policy "tenant-attachments: admins can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'tenant-attachments'
    and public.is_org_admin((split_part(name, '/', 1))::uuid)
  );
