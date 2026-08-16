-- Fleet — tyres as a first-class, dated compliance obligation.
--
-- A fleet operator's tyre programme is a recurring, dated check that produces a
-- piece of work with a provider, a cost, a mileage and a record — exactly the
-- shape 20261057000000 established for MOT / insurance / road tax on the
-- EXISTING maintenance engines. Before this migration a tyre check could only be
-- logged as a generic 'service' case, so it had no distinct reminder, no
-- distinct label and no place on the fleet compliance board; the only mention of
-- tyres anywhere in the codebase was a disclaimer in lib/fleet/fuel.ts that they
-- "are not all captured here". This closes that gap the same way 20261057 did:
-- by WIDENING the two coupled CHECKs, not by forking a new table.
--
-- WHY 'tyres' EARNS 'high', NOT 'critical' (see lib/fleet/compliance.ts header):
-- driving without a valid MOT or insurance is an offence in ITSELF, so an
-- in-service breach of those is a live legal breach → 'critical'. A LAPSED TYRE
-- CHECK is different: the offence is the tread state (Road Traffic Act 1988 /
-- Construction & Use Regs — below 1.6mm), which a missed inspection date does
-- not prove. So an overdue tyre check is treated like overdue road tax /
-- service: it needs doing today, but it is not a proven driving offence, and it
-- is deliberately NOT added to LEGAL_COMPLIANCE_TYPES / CRITICAL_WHEN_IN_SERVICE.
-- That carve-out is what keeps 'critical' meaning something.
--
-- Two coupled changes + one index, coupled for the same reason 20261057 was:
-- server/services/asset-maintenance-generator.ts passes
-- `case_type: schedule.maintenance_type` straight through, so widening the
-- schedule CHECK alone would make every generated tyre case fail its insert the
-- moment the cron ran. The two CHECKs move together.
--
-- WIDENING ONLY — every previously-legal value stays legal, so no existing row
-- and no existing caller can be invalidated. Additive and reversible.

-- ── 1. schedules: allow the tyres cadence ────────────────────────────────────
-- Introspect-then-rebuild on the constraint DEFINITION mentioning the column
-- (the tenant_attachments idiom, matching 20261057) rather than a hard-coded
-- name: it is the only CHECK on this table that references maintenance_type.
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'asset_service_schedules'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%maintenance_type%';
  if cname is not null then
    execute format('alter table public.asset_service_schedules drop constraint %I', cname);
  end if;
end $$;

alter table public.asset_service_schedules
  add constraint asset_service_schedules_maintenance_type_check
  check (maintenance_type in ('preventive', 'service', 'calibration',
                              'mot', 'insurance', 'road_tax', 'tyres'));

-- ── 2. cases: the generator's passthrough target must accept the same value ──
do $$
declare
  cname text;
begin
  select con.conname into cname
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'asset_maintenance_cases'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%case_type%';
  if cname is not null then
    execute format('alter table public.asset_maintenance_cases drop constraint %I', cname);
  end if;
end $$;

alter table public.asset_maintenance_cases
  add constraint asset_maintenance_cases_case_type_check
  check (case_type in ('breakdown', 'corrective', 'preventive', 'service',
                       'calibration', 'warranty',
                       'mot', 'insurance', 'road_tax', 'tyres'));

-- ── 3. keep the compliance attention sweep covering tyres ────────────────────
-- 20261057 created asset_maintenance_cases_compliance_idx partial on the three
-- legal types. Tyres belongs on the same soonest-first sweep, so rebuild the
-- partial predicate to include it. Drop-and-recreate because a partial index's
-- WHERE predicate cannot be altered in place.
drop index if exists public.asset_maintenance_cases_compliance_idx;
create index if not exists asset_maintenance_cases_compliance_idx
  on public.asset_maintenance_cases (org_id, scheduled_for)
  where case_type in ('mot', 'insurance', 'road_tax', 'tyres')
    and status not in ('completed', 'cancelled');
