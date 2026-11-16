-- REHEARSAL for 20261354000000 against a RESTORED production backup in a network-less container.
-- Synthetic rows only, inside rolled-back transactions; prints counts / booleans, never real data.
-- Run with psql -v ON_ERROR_STOP=1 from the release runbook (docs/engineering/release/).
\set QUIET on
\pset tuples_only on
\pset format unaligned

create temp table _snap(phase text, sig text);
create or replace function pg_temp.sig() returns text language sql as $$
  select md5(string_agg(policyname || ':' || array_to_string(roles, ',') || ':' || coalesce(qual, ''), '|' order by policyname))
    from pg_policies
   where (schemaname = 'storage' and cmd = 'SELECT')
      or (schemaname = 'public' and tablename = 'tenant_attachments' and cmd = 'SELECT')
$$;
create or replace function pg_temp.untouched_sig() returns text language sql as $$
  select md5(string_agg(policyname || ':' || coalesce(qual, ''), '|' order by policyname))
    from pg_policies
   where schemaname = 'storage' and policyname in ('job-photos: members can read', 'imports: admins read', 'job-docs-private: admins can read')
$$;
insert into _snap values ('pre', pg_temp.sig()), ('pre_untouched', pg_temp.untouched_sig());
select 'pre: tip=' || (select max(version) from supabase_migrations.schema_migrations)
       || ' held_guards=' || (select count(*) from pg_trigger where tgname = 'held_org_write_guard')
       || ' policy_tables=' || (select count(distinct tablename) from pg_policies where schemaname = 'public');

\echo '== apply 354'
\i /tmp/m354.sql

select 'post-apply: fn=' || (select count(*) from pg_proc where proname = 'tenant_attachment_visible')
  || ' uidx=' || (select count(*) from pg_indexes where indexname = 'tenant_attachments_storage_path_uidx')
  || ' gated_bucket_policies=' || (select count(*) from pg_policies where schemaname = 'storage' and cmd = 'SELECT'
       and policyname in ('tenant-attachments: members can read','compliance-docs: members can read','receipts: members can read',
                          'signatures: members can read','job-docs: members can read','whatsapp_media_read','blueprints: members can read')
       and qual like '%is_org_admin%')
  || ' untouched_same=' || ((select sig from _snap where phase = 'pre_untouched') = pg_temp.untouched_sig())
  || ' held_guards=' || (select count(*) from pg_trigger where tgname = 'held_org_write_guard')
  || ' policy_tables=' || (select count(distinct tablename) from pg_policies where schemaname = 'public')
  || ' anon_exec_fn=' || has_function_privilege('anon', 'public.tenant_attachment_visible(uuid,text,uuid,uuid)', 'execute');

\echo '== behaviour (synthetic, rolled back)'
begin;
insert into auth.users (id, instance_id, aud, role, email) values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reh-owner@example.invalid'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reh-staff@example.invalid'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'reh-other@example.invalid');
insert into public.users (id, email) values
  ('00000000-0000-4000-8000-00000000a001', 'reh-owner@example.invalid'),
  ('00000000-0000-4000-8000-00000000a002', 'reh-staff@example.invalid'),
  ('00000000-0000-4000-8000-00000000a003', 'reh-other@example.invalid')
  on conflict (id) do nothing;
insert into public.organizations (id, name, slug, status) values
  ('00000000-0000-4000-8000-0000000b0001', 'Rehearsal A', 'rehearsal-a-354', 'active'),
  ('00000000-0000-4000-8000-0000000b0002', 'Rehearsal B', 'rehearsal-b-354', 'active');
insert into public.memberships (org_id, user_id, role) values
  ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-00000000a001', 'owner'),
  ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-00000000a002', 'staff'),
  ('00000000-0000-4000-8000-0000000b0002', '00000000-0000-4000-8000-00000000a003', 'owner');
insert into public.customers (id, org_id, name) values ('00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-0000000b0001', 'Rehearsal customer');
insert into public.jobs (id, org_id, customer_id, assigned_to) values
  ('00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000c0001', '00000000-0000-4000-8000-00000000a002'),
  ('00000000-0000-4000-8000-0000000d0002', '00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000c0001', null);
insert into public.job_assignments (org_id, job_id, user_id) values
  ('00000000-0000-4000-8000-0000000b0001', '00000000-0000-4000-8000-0000000d0001', '00000000-0000-4000-8000-00000000a002');
insert into public.tenant_attachments (org_id, target_table, target_id, filename, storage_path, uploaded_by) values
  ('00000000-0000-4000-8000-0000000b0001', 'jobs', '00000000-0000-4000-8000-0000000d0001', 'a.pdf', '00000000-0000-4000-8000-0000000b0001/reh/assigned.pdf', '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-0000000b0001', 'jobs', '00000000-0000-4000-8000-0000000d0002', 'u.pdf', '00000000-0000-4000-8000-0000000b0001/reh/unassigned.pdf', '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-0000000b0001', 'invoices', '00000000-0000-4000-8000-0000000e0001', 'i.pdf', '00000000-0000-4000-8000-0000000b0001/reh/invoice.pdf', '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-0000000b0001', 'customers', '00000000-0000-4000-8000-0000000c0001', 'c.pdf', '00000000-0000-4000-8000-0000000b0001/reh/customer.pdf', '00000000-0000-4000-8000-00000000a001');
insert into storage.objects (bucket_id, name) values
  ('tenant-attachments', '00000000-0000-4000-8000-0000000b0001/reh/assigned.pdf'),
  ('tenant-attachments', '00000000-0000-4000-8000-0000000b0001/reh/unassigned.pdf'),
  ('tenant-attachments', '00000000-0000-4000-8000-0000000b0001/reh/invoice.pdf'),
  ('tenant-attachments', '00000000-0000-4000-8000-0000000b0001/reh/customer.pdf'),
  ('receipts', '00000000-0000-4000-8000-0000000b0001/reh/orphan.png');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a002","role":"authenticated"}', true);
select 'staff: rows=' || (select count(*) from public.tenant_attachments where org_id = '00000000-0000-4000-8000-0000000b0001')
  || ' (expect 1) objects=' || (select count(*) from storage.objects where name like '00000000-0000-4000-8000-0000000b0001/reh/%')
  || ' (expect 1: assigned only)';
-- duplicate-path bypass: staff forges a row pointing at the invoice object
\set ON_ERROR_STOP off
savepoint dup;
insert into public.tenant_attachments (org_id, target_table, target_id, filename, storage_path, uploaded_by) values
  ('00000000-0000-4000-8000-0000000b0001', 'jobs', '00000000-0000-4000-8000-0000000d0001', 'x.pdf', '00000000-0000-4000-8000-0000000b0001/reh/invoice.pdf', '00000000-0000-4000-8000-00000000a002');
rollback to savepoint dup;
\set ON_ERROR_STOP on
select 'staff after forged insert attempt: invoice object readable=' || exists (select 1 from storage.objects where name = '00000000-0000-4000-8000-0000000b0001/reh/invoice.pdf') || ' (expect false)';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a001","role":"authenticated"}', true);
select 'owner: rows=' || (select count(*) from public.tenant_attachments where org_id = '00000000-0000-4000-8000-0000000b0001')
  || ' (expect 4) objects=' || (select count(*) from storage.objects where name like '00000000-0000-4000-8000-0000000b0001/reh/%') || ' (expect 5)';

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000a003","role":"authenticated"}', true);
select 'other-company owner: rows=' || (select count(*) from public.tenant_attachments where org_id = '00000000-0000-4000-8000-0000000b0001')
  || ' (expect 0) objects=' || (select count(*) from storage.objects where name like '00000000-0000-4000-8000-0000000b0001/reh/%') || ' (expect 0)';
rollback;

\echo '== rollback'
\i /tmp/rollback354.sql
select 'post-rollback: definitions_restored=' || ((select sig from _snap where phase = 'pre') = pg_temp.sig())
  || ' fn=' || (select count(*) from pg_proc where proname = 'tenant_attachment_visible')
  || ' uidx=' || (select count(*) from pg_indexes where indexname = 'tenant_attachments_storage_path_uidx');

\echo '== re-apply (idempotent)'
\i /tmp/m354.sql
\i /tmp/m354.sql
select 'post-reapply: fn=' || (select count(*) from pg_proc where proname = 'tenant_attachment_visible')
  || ' uidx=' || (select count(*) from pg_indexes where indexname = 'tenant_attachments_storage_path_uidx')
  || ' untouched_same=' || ((select sig from _snap where phase = 'pre_untouched') = pg_temp.untouched_sig());
