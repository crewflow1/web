-- ROLLBACK for 20261354000000_storage_reads_follow_row_visibility.
-- Restores the exact pre-354 production definitions (captured read-only from production,
-- 2026-11-16, tip 20261350000000). Run as ONE transaction, then:
--   supabase migration repair --status reverted 20261354000000 --linked
-- Re-opens the same-company file-read exposure: only for a failed release.
begin;
drop policy if exists tenant_attachments_select on public.tenant_attachments;
create policy tenant_attachments_select on public.tenant_attachments
  for select to public using (org_id in (select public.current_org_ids()));

drop policy if exists "tenant-attachments: members can read" on storage.objects;
create policy "tenant-attachments: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'tenant-attachments' and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));
drop policy if exists "compliance-docs: members can read" on storage.objects;
create policy "compliance-docs: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'compliance-docs' and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));
drop policy if exists "receipts: members can read" on storage.objects;
create policy "receipts: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and ((storage.foldername(name))[1])::uuid in (select public.current_org_ids()));
drop policy if exists "signatures: members can read" on storage.objects;
create policy "signatures: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'signatures' and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));
drop policy if exists "job-docs: members can read" on storage.objects;
create policy "job-docs: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'job-docs' and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));
drop policy if exists whatsapp_media_read on storage.objects;
create policy whatsapp_media_read on storage.objects for select to authenticated
  using (bucket_id = 'whatsapp-media' and ((storage.foldername(name))[1])::uuid in (select public.current_org_ids()));
drop policy if exists "blueprints: members can read" on storage.objects;
create policy "blueprints: members can read" on storage.objects for select to authenticated
  using (bucket_id = 'blueprints' and (split_part(name, '/', 1))::uuid in (select public.current_org_ids()));

drop index if exists public.tenant_attachments_storage_path_uidx;
drop function if exists public.tenant_attachment_visible(uuid, text, uuid, uuid);
commit;
