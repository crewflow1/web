-- Asset Management — P3W2: calibration certificate register.
--
-- Instruments a firm calibrates externally — torque wrenches, gas monitors,
-- theodolites, test meters — come back with a CALIBRATION CERTIFICATE issued by
-- the lab. Today that arrives only as a generic file attachment, so its expiry
-- is invisible to the system. This adds a STRUCTURED register: certificate
-- number, who calibrated it, the calibration date, the next-due date, and the
-- result — a real record the platform can reason about.
--
-- HONESTY STANCE (unchanged, see lib/assets/inspection-template.ts): CrewFlow is
-- the RECORD of a certificate issued elsewhere. It never synthesises or issues a
-- calibration certificate — `calibrated_by` is the external lab/engineer, and
-- the lab's PDF rides the existing tenant_attachments pipeline. This table
-- RECORDS; it does not certify.
--
-- FEEDING THE EXISTING DUE-NUDGES. Calibration is already a maintenance concern:
-- asset_service_schedules.maintenance_type = 'calibration' and case_type =
-- 'calibration' both exist, the M5b generator turns due schedules into
-- maintenance cases + `maintenance.due` notifications, and lib/fleet/compliance
-- classifies overdue. Rather than build a parallel nudge engine, recording a
-- certificate with a next-due date ADVANCES its linked calibration schedule
-- (SECURITY DEFINER, guarded below) — so the next expiry surfaces through the
-- SAME generator, notifications and compliance surfaces that already run. The
-- certificate register is how a calibration cycle is completed and re-armed.
--
-- Same-org integrity is COMPOSITE FKs to the assets and schedules candidate keys
-- (never bare asset_id/schedule_id FKs). Member CRUD, admin delete — the
-- maintenance-cases posture (calibration history is org record). Additive.

-- ── Composite candidate key on the schedules table (for the cert's FK) ────────
-- asset_service_schedules had only a single-column PK; a composite FK from the
-- register needs `(id, org_id)` unique. Additive; harmless if already present.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'asset_service_schedules_id_org_key'
  ) then
    alter table public.asset_service_schedules
      add constraint asset_service_schedules_id_org_key unique (id, org_id);
  end if;
end $$;

create table if not exists public.asset_calibration_certificates (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations(id) on delete cascade,
  asset_id           uuid not null,
  -- The calibration schedule this certificate satisfies (optional). When set and
  -- a next-due is given, the AFTER trigger rolls the schedule forward so the
  -- existing due-nudge engine re-arms. Nulled (not cascaded) if the schedule is
  -- later deleted — the certificate is history and must survive.
  schedule_id        uuid,
  -- The certificate number as printed by the issuing lab. Unique per asset.
  certificate_number text not null
    check (length(btrim(certificate_number)) between 1 and 120),
  -- The EXTERNAL lab / engineer who calibrated and issued — never CrewFlow.
  calibrated_by      text not null
    check (length(btrim(calibrated_by)) between 1 and 200),
  calibration_date   date not null,
  -- When the next calibration is due. Optional (a one-off calibration may state
  -- no recurrence); when present it drives the schedule roll-forward + nudges.
  next_due_date      date,
  result             text not null
    check (result in ('pass', 'pass_with_adjustment', 'fail', 'limited', 'indicative')),
  -- Accreditation / standard reference the cert was issued under (e.g. "UKAS
  -- 0123", "ISO 6789"). Free text — a record of what the lab stated.
  standard           text check (standard is null or length(standard) <= 200),
  notes              text check (notes is null or length(notes) <= 4000),
  recorded_by        uuid references public.users(id) on delete set null,
  created_at         timestamp with time zone not null default now(),
  updated_at         timestamp with time zone not null default now(),
  -- Same-org integrity as DB invariants (composite FKs), not app checks.
  constraint asset_calibration_certs_asset_org_fk
    foreign key (asset_id, org_id)
    references public.assets (id, org_id) on delete cascade,
  constraint asset_calibration_certs_schedule_org_fk
    foreign key (schedule_id, org_id)
    references public.asset_service_schedules (id, org_id) on delete set null (schedule_id),
  -- A next-due can never precede the calibration it follows.
  constraint asset_calibration_certs_due_after_cal_check
    check (next_due_date is null or next_due_date >= calibration_date),
  -- One certificate number per asset (the lab never reissues the same number).
  constraint asset_calibration_certs_number_unique
    unique (org_id, asset_id, certificate_number)
);

comment on constraint asset_calibration_certs_asset_org_fk
  on public.asset_calibration_certificates is
  'Composite FK to assets(id, org_id): the certificate''s asset must be same-org.';
comment on constraint asset_calibration_certs_schedule_org_fk
  on public.asset_calibration_certificates is
  'Composite FK to asset_service_schedules(id, org_id): the linked schedule must be same-org; nulled (not cascaded) on schedule delete so the certificate record survives.';

-- Register list (per asset, newest calibration first).
create index if not exists asset_calibration_certs_asset_idx
  on public.asset_calibration_certificates (asset_id, calibration_date desc);
-- Org-wide expiry sweep (the register page + any due report).
create index if not exists asset_calibration_certs_due_idx
  on public.asset_calibration_certificates (org_id, next_due_date)
  where next_due_date is not null;

-- ── Guard: the linked schedule must be for THIS asset and be a calibration ────
-- The composite FK already proves same-org + real schedule; this adds the two
-- semantic invariants the FK can't express.
create or replace function public.tg_asset_calibration_certs_guard()
returns trigger language plpgsql as $$
declare
  s_asset uuid;
  s_type  text;
begin
  if new.schedule_id is not null then
    select asset_id, maintenance_type into s_asset, s_type
    from public.asset_service_schedules
    where id = new.schedule_id and org_id = new.org_id;
    if s_asset is null then
      raise exception 'schedule % is not in org %', new.schedule_id, new.org_id
        using errcode = 'check_violation';
    end if;
    if s_asset <> new.asset_id then
      raise exception 'schedule % is not for asset %', new.schedule_id, new.asset_id
        using errcode = 'check_violation';
    end if;
    if s_type <> 'calibration' then
      raise exception 'schedule % is not a calibration schedule', new.schedule_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists asset_calibration_certs_guard on public.asset_calibration_certificates;
create trigger asset_calibration_certs_guard
  before insert or update on public.asset_calibration_certificates
  for each row execute function public.tg_asset_calibration_certs_guard();

drop trigger if exists asset_calibration_certs_set_updated_at on public.asset_calibration_certificates;
create trigger asset_calibration_certs_set_updated_at
  before update on public.asset_calibration_certificates
  for each row execute function public.tg_set_updated_at();

-- ── Roll the linked calibration schedule forward (feeds the existing nudges) ──
-- SECURITY DEFINER: a member records the certificate, but the schedule it
-- re-arms is admin-only under RLS. This bypass is TIGHT: it touches ONLY the
-- specific same-org, same-asset, calibration-typed schedule the FK + guard
-- already validated, and only ever moves next_due FORWARD (a backdated
-- historical certificate can never regress a live schedule). This is the whole
-- coupling that makes calibration expiries surface through the existing
-- generator + notifications + compliance, with no second nudge engine.
create or replace function public.tg_asset_calibration_certs_sync_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.schedule_id is not null and new.next_due_date is not null then
    update public.asset_service_schedules
      set next_due          = new.next_due_date,
          last_completed_at  = (new.calibration_date::timestamptz),
          active             = true
    where id = new.schedule_id
      and org_id = new.org_id
      and maintenance_type = 'calibration'
      and new.next_due_date > next_due;  -- forward-only; never regress the nudge
  end if;
  return null;  -- AFTER trigger
end $$;

revoke all on function public.tg_asset_calibration_certs_sync_schedule() from public;

drop trigger if exists asset_calibration_certs_sync_schedule on public.asset_calibration_certificates;
create trigger asset_calibration_certs_sync_schedule
  after insert or update on public.asset_calibration_certificates
  for each row execute function public.tg_asset_calibration_certs_sync_schedule();

-- ── RLS: member CRUD, admin delete (asset_maintenance_cases posture) ─────────
alter table public.asset_calibration_certificates enable row level security;

create policy asset_calibration_certs_select on public.asset_calibration_certificates
  for select using (org_id in (select public.current_org_ids()));
create policy asset_calibration_certs_insert on public.asset_calibration_certificates
  for insert with check (org_id in (select public.current_org_ids()));
create policy asset_calibration_certs_update on public.asset_calibration_certificates
  for update using (org_id in (select public.current_org_ids()))
  with check (org_id in (select public.current_org_ids()));
create policy asset_calibration_certs_delete on public.asset_calibration_certificates
  for delete using (public.is_org_admin(org_id));

-- ── Attachments: the lab's certificate PDF rides the universal pipeline ──────
-- Widen the shared CHECK to accept 'asset_calibration_certificates', preserving
-- every prior target by introspect-drop-rebuild (authority: 20261122000001, the
-- last widening — 20 targets — inspected, never reconstructed from memory).
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
                          'non_conformance_reports', 'blueprint_pins',
                          'asset_calibration_certificates'));
