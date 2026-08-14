-- Blueprint Pins — completion wave (P2): direct photo attachment on a pin.
--
-- Pins can now carry photos DIRECTLY (a marker on the drawing → the photo of
-- the thing it flags), rather than only indirectly through a linked snag. This
-- rides the EXISTING universal tenant_attachments pipeline (no new bucket, no
-- new table) — the same path snags/site-reports/assets already use — by adding
-- 'blueprint_pins' to the target_table CHECK.
--
-- Introspect + rebuild, preserving EVERY prior target. The 19 values below are
-- the set 20261081 (works_quality_m2) re-added — the LAST migration that
-- widened this CHECK before this one (verified in this repo); 'blueprint_pins'
-- is the 20th. The TS list (server/services/tenant-attachments.ts
-- ATTACHMENT_TARGET_TABLES) moves in this same commit;
-- __tests__/security/attachment-target-drift.test.ts pins the two sets equal.
--
-- MERGE NOTE: if another in-flight lane also widens this CHECK, the merge must
-- UNION both value lists (and both TS lists) — taking one side wholesale
-- silently drops the other's target.
--
-- Additive + reversible: it only widens a CHECK. No existing row is mutated.

do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'tenant_attachments'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%target_table%';
  if cname is not null then
    execute format('alter table public.tenant_attachments drop constraint %I', cname);
  end if;
end $$;

alter table public.tenant_attachments
  add constraint tenant_attachments_target_table_check
  check (target_table in ('customers', 'jobs', 'quotes', 'invoices',
                          'suppliers', 'memberships', 'leads', 'snags',
                          'site_diary_entries', 'toolbox_talks', 'site_reports',
                          'assets', 'asset_assignments', 'asset_inspections',
                          'asset_maintenance_cases', 'asset_fuel_logs',
                          'goods_received_notes', 'inspection_signoffs',
                          'non_conformance_reports', 'blueprint_pins'));
