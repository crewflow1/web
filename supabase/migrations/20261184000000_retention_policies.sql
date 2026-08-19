-- ═════════════════════════════════════════════════════════════════════════════
-- CONFIGURABLE PER-DOMAIN DATA RETENTION — policy config, audit trail, and the
-- age-based purge/preview primitive.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CrewFlow already ships a dedicated age-retention MECHANISM for the activity
-- feed (migration 20260710000000, purge_activity_log). This migration
-- generalises the idea: it lets an ORGANISATION configure, per HIGH-VOLUME
-- OPERATIONAL table, how long to keep rows before they age out — and adds a
-- scheduled purge with a dry-run PREVIEW and a full AUDIT of every action.
--
-- Applying this migration deletes NOTHING. It creates two tables and one
-- function. Deletion only ever happens when the retention cron (or an admin
-- preview → purge) invokes retention_purge_run() for an ENABLED policy, and even
-- then the destructive branch is gated by FEATURE_RETENTION_PURGE (default off)
-- in the caller — while off, the cron runs in DRY-RUN and deletes nothing.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE HARD RULE — STATUTORY / FINANCIAL / AUDIT DATA IS NEVER PURGEABLE.
-- ─────────────────────────────────────────────────────────────────────────────
-- Enforcement is DEFAULT-DENY via a POSITIVE ALLOWLIST that appears THREE times,
-- kept byte-identical by __tests__/security/retention-policy-exclusions:
--   1. retention_policies.table_name CHECK (below) — the DB physically cannot
--      store a policy for a non-allowlisted table.
--   2. retention_purge_run()'s internal allowlist VALUES (below) — the primitive
--      refuses any target not on the list, even called directly as service_role.
--   3. lib/retention/policy.ts RETENTION_PURGEABLE — the app + UI source of truth.
-- Financial records (invoices/payments/finances/quotes/purchase orders/…),
-- payroll/pension/CIS/VAT/HMRC submissions, and audit trails (activity_log,
-- hq_events, the GDPR logs, this very purge log) are NOT on the allowlist and
-- therefore can never be targeted. The exclusion guard test fails the build if
-- any of them ever appears here.
--
-- Additive and reversible:
--   drop function public.retention_purge_run(uuid, text, integer, boolean, integer, uuid, uuid);
--   drop table public.retention_purge_log;
--   drop table public.retention_policies;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. POLICY CONFIG — one row per (org, table). Member-read, ADMIN-write.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.retention_policies (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  -- POSITIVE ALLOWLIST (layer 1). Mirrors lib/retention/policy.ts and the
  -- primitive's internal list; the drift guard keeps all three identical.
  -- (Named `table_name` — NOT `target_table` — deliberately, so it never collides
  -- with the tenant_attachments target_table CHECK the attachment drift guard scans.)
  table_name     text not null check (table_name in (
    'api_request_log',
    'automation_runs',
    'calendar_pulled_events',
    'health_score_events',
    'maintenance_reminder_log',
    'notification_email_queue',
    'notifications',
    'push_deliveries',
    'telematics_readings',
    'webhook_deliveries'
  )),
  retention_days integer not null check (retention_days between 30 and 3650),
  enabled        boolean not null default false,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- One policy per table per org.
  constraint retention_policies_org_table_key unique (org_id, table_name),
  -- Composite key so the purge log can carry a tenant-safe composite FK.
  constraint retention_policies_id_org_key unique (id, org_id)
);

create index if not exists retention_policies_org_idx
  on public.retention_policies (org_id);

alter table public.retention_policies enable row level security;

-- Members READ their org's policies; only owners/admins WRITE (is_org_admin
-- honours active impersonation). The server action re-checks admin too, so a
-- non-admin is refused twice.
drop policy if exists "retention_policies: members select" on public.retention_policies;
create policy "retention_policies: members select" on public.retention_policies
  for select to authenticated using (org_id in (select public.current_org_ids()));

drop policy if exists "retention_policies: admins insert" on public.retention_policies;
create policy "retention_policies: admins insert" on public.retention_policies
  for insert to authenticated with check (public.is_org_admin(org_id));

drop policy if exists "retention_policies: admins update" on public.retention_policies;
create policy "retention_policies: admins update" on public.retention_policies
  for update to authenticated
  using (public.is_org_admin(org_id))
  with check (public.is_org_admin(org_id));

drop policy if exists "retention_policies: admins delete" on public.retention_policies;
create policy "retention_policies: admins delete" on public.retention_policies
  for delete to authenticated using (public.is_org_admin(org_id));

-- Keep updated_at honest.
create or replace function public.tg_retention_policies_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists retention_policies_touch on public.retention_policies;
create trigger retention_policies_touch
  before update on public.retention_policies
  for each row execute function public.tg_retention_policies_touch();

comment on table public.retention_policies is
  'Per-org, per-table data-retention config (window + enabled). table_name is '
  'a POSITIVE ALLOWLIST of high-volume operational tables — statutory/financial/'
  'audit tables can never appear (CHECK + retention_purge_run + lib/retention/policy.ts). '
  'Member-read, admin-write.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AUDIT TRAIL — one append-only row per purge/preview action.
-- ─────────────────────────────────────────────────────────────────────────────
-- Records WHAT ran, in WHICH mode, the cutoff it used, how many rows MATCHED and
-- how many were DELETED, and any error. Carries no PII — counts + a table name +
-- a timestamp. Written ONLY by retention_purge_run() (service_role); there is no
-- INSERT/UPDATE/DELETE policy, so a tenant can neither forge nor erase the trail.
create table if not exists public.retention_purge_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  policy_id      uuid,
  table_name     text not null,
  mode           text not null check (mode in ('dry_run', 'purge')),
  retention_days integer not null check (retention_days between 30 and 3650),
  cutoff         timestamptz not null,
  rows_matched   integer not null default 0 check (rows_matched >= 0),
  rows_deleted   integer not null default 0 check (rows_deleted >= 0),
  status         text not null check (status in ('previewed', 'purged', 'failed', 'skipped')),
  error          text,
  requested_by   uuid references public.users(id) on delete set null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  -- Tenant-safe composite FK: a log row's policy must belong to the SAME org.
  -- ON DELETE SET NULL so the accountability row survives a policy deletion.
  constraint retention_purge_log_policy_fk
    foreign key (policy_id, org_id)
    references public.retention_policies (id, org_id) on delete set null,
  -- A dry-run previews only — it must never claim a deletion.
  constraint retention_purge_log_dryrun_no_delete
    check (mode <> 'dry_run' or rows_deleted = 0),
  -- Deletions can never exceed matches.
  constraint retention_purge_log_deleted_le_matched
    check (rows_deleted <= rows_matched)
);

create index if not exists retention_purge_log_org_created_idx
  on public.retention_purge_log (org_id, created_at desc);

alter table public.retention_purge_log enable row level security;

-- Members READ their org's purge history. NO write policy — only the SECURITY
-- DEFINER primitive (running as service_role) appends rows.
drop policy if exists "retention_purge_log: members select" on public.retention_purge_log;
create policy "retention_purge_log: members select" on public.retention_purge_log
  for select to authenticated using (org_id in (select public.current_org_ids()));

comment on table public.retention_purge_log is
  'Append-only audit of every retention purge/preview: mode, cutoff, rows '
  'matched/deleted, status. Written only by retention_purge_run (service_role); '
  'no tenant write path. Itself EXCLUDED from purging.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. THE PRIMITIVE — one org, one table, age-based preview OR purge. Fail-closed.
-- ─────────────────────────────────────────────────────────────────────────────
-- Arguments:
--   p_org_id         the tenant whose rows are considered (isolation pin).
--   p_target_table   the table to purge — MUST be on the internal allowlist.
--   p_retention_days window in days; rows older than now() - window are in scope.
--   p_dry_run        true → COUNT only (preview), delete nothing; false → purge.
--   p_batch          delete chunk size (ctid-batched so no unbounded statement).
--   p_policy_id      the driving policy (for the audit row); may be null.
--   p_requested_by   the admin who triggered a manual preview (for the audit row).
--
-- Returns a jsonb summary. Every scan/delete is pinned to `org_id = p_org_id`, so
-- the primitive can only ever touch ONE tenant's rows. SECURITY DEFINER (it runs
-- maintenance regardless of RLS) but service_role-only + allowlist-gated so it
-- cannot be turned against a protected table.
create or replace function public.retention_purge_run(
  p_org_id        uuid,
  p_target_table  text,
  p_retention_days integer,
  p_dry_run       boolean default true,
  p_batch         integer default 5000,
  p_policy_id     uuid default null,
  p_requested_by  uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, information_schema
as $$
declare
  -- POSITIVE ALLOWLIST (layer 2): table → timestamp column. The ONLY tables this
  -- primitive will ever touch. Kept identical to the CHECK above and to
  -- lib/retention/policy.ts by the drift guard test. A target absent here RAISES.
  c_allow constant text[][] := array[
    ['api_request_log',          'created_at'],
    ['automation_runs',          'created_at'],
    ['calendar_pulled_events',   'created_at'],
    ['health_score_events',      'created_at'],
    ['maintenance_reminder_log', 'created_at'],
    ['notification_email_queue', 'created_at'],
    ['notifications',            'created_at'],
    ['push_deliveries',          'created_at'],
    ['telematics_readings',      'created_at'],
    ['webhook_deliveries',       'created_at']
  ];
  v_ts_col   text := null;
  v_i        integer;
  v_cutoff   timestamptz;
  v_matched  integer := 0;
  v_deleted  integer := 0;
  v_chunk    integer;
  v_started  timestamptz := now();
begin
  -- ── AUTHZ (defence in depth) ────────────────────────────────────────────────
  -- service_role only. The GRANT already restricts this; re-check inside so a
  -- future mis-grant (or Supabase default privileges re-applied on CREATE OR
  -- REPLACE) cannot open a destructive door to anon/authenticated.
  if auth.role() is distinct from 'service_role' then
    raise exception 'retention_purge_run: service_role only' using errcode = '42501';
  end if;

  if p_org_id is null then
    raise exception 'retention_purge_run: p_org_id is required' using errcode = '22004';
  end if;

  -- ── WINDOW BOUNDS ───────────────────────────────────────────────────────────
  if p_retention_days is null or p_retention_days < 30 or p_retention_days > 3650 then
    raise exception 'retention_purge_run: p_retention_days must be between 30 and 3650 (got %)', p_retention_days
      using errcode = '22023';
  end if;
  if p_batch is null or p_batch <= 0 then
    raise exception 'retention_purge_run: p_batch must be a positive integer (got %)', p_batch
      using errcode = '22023';
  end if;

  -- ── ALLOWLIST GATE (the hard rule) ──────────────────────────────────────────
  -- Resolve the timestamp column for the target from the internal allowlist. A
  -- target that is not on the list — ANY statutory/financial/audit table — is
  -- refused here, fail-closed, before a single row is read.
  for v_i in 1 .. array_length(c_allow, 1) loop
    if c_allow[v_i][1] = p_target_table then
      v_ts_col := c_allow[v_i][2];
      exit;
    end if;
  end loop;
  if v_ts_col is null then
    raise exception 'retention_purge_run: "%" is not a purgeable table — refusing', p_target_table
      using errcode = '42501';
  end if;

  -- ── SHAPE VALIDATION ────────────────────────────────────────────────────────
  -- The target must be a real public BASE TABLE carrying both org_id and the
  -- allowlisted timestamp column. Anything else RAISES (a schema/allowlist bug).
  if not exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = p_target_table and table_type = 'BASE TABLE'
     ) then
    raise exception 'retention_purge_run: "%" is not a public base table', p_target_table
      using errcode = 'raise_exception';
  end if;
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = p_target_table and column_name = 'org_id'
     ) then
    raise exception 'retention_purge_run: "%" has no org_id column — refusing', p_target_table
      using errcode = 'raise_exception';
  end if;
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = p_target_table and column_name = v_ts_col
     ) then
    raise exception 'retention_purge_run: "%" has no % column — refusing', p_target_table, v_ts_col
      using errcode = 'raise_exception';
  end if;

  v_cutoff := v_started - make_interval(days => p_retention_days);

  -- ── MATCH COUNT (always; the dry-run preview IS this number) ────────────────
  -- Tenant-pinned: org_id = p_org_id. This is the "what WOULD be purged" figure.
  execute format(
    'select count(*)::integer from public.%I where org_id = $1 and %I < $2',
    p_target_table, v_ts_col
  ) into v_matched using p_org_id, v_cutoff;

  -- ── DELETE (only when NOT a dry-run) ────────────────────────────────────────
  if not p_dry_run then
    -- ctid-batched delete so a single statement never builds an unbounded set.
    -- ctid is universal (no assumption about a pk column name). Each pass removes
    -- up to p_batch matching rows and stops when a pass deletes nothing.
    loop
      execute format(
        'delete from public.%I where ctid in ('
        || ' select ctid from public.%I where org_id = $1 and %I < $2 limit $3'
        || ')',
        p_target_table, p_target_table, v_ts_col
      ) using p_org_id, v_cutoff, p_batch;
      get diagnostics v_chunk = row_count;
      v_deleted := v_deleted + v_chunk;
      exit when v_chunk = 0;
    end loop;
  end if;

  -- ── AUDIT (append one row, both modes) ──────────────────────────────────────
  insert into public.retention_purge_log (
    org_id, policy_id, table_name, mode, retention_days, cutoff,
    rows_matched, rows_deleted, status, requested_by, started_at, finished_at
  ) values (
    p_org_id, p_policy_id, p_target_table,
    case when p_dry_run then 'dry_run' else 'purge' end,
    p_retention_days, v_cutoff,
    v_matched, v_deleted,
    case when p_dry_run then 'previewed' else 'purged' end,
    p_requested_by, v_started, now()
  );

  return jsonb_build_object(
    'org_id', p_org_id,
    'target_table', p_target_table,
    'mode', case when p_dry_run then 'dry_run' else 'purge' end,
    'retention_days', p_retention_days,
    'cutoff', v_cutoff,
    'rows_matched', v_matched,
    'rows_deleted', v_deleted,
    'status', case when p_dry_run then 'previewed' else 'purged' end
  );
end;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
-- Supabase default privileges grant EXECUTE on new public functions to anon +
-- authenticated at CREATE time, and `revoke ... from public` does NOT strip
-- those role-specific grants. Revoke them EXPLICITLY, then grant only
-- service_role. The cron/service is the sole caller (service-role client). A
-- tenant must never be able to run a purge directly.
revoke all on function public.retention_purge_run(uuid, text, integer, boolean, integer, uuid, uuid) from public;
revoke execute on function public.retention_purge_run(uuid, text, integer, boolean, integer, uuid, uuid) from anon, authenticated;
grant  execute on function public.retention_purge_run(uuid, text, integer, boolean, integer, uuid, uuid) to service_role;

comment on function public.retention_purge_run(uuid, text, integer, boolean, integer, uuid, uuid) is
  'Age-based retention purge/preview for ONE org + ONE allowlisted table. '
  'service_role-only, allowlist-gated (statutory/financial/audit tables refused), '
  'tenant-pinned (org_id = p_org_id on every scan/delete), dry-run previews '
  '(count only), purge ctid-batched. Appends one retention_purge_log row per run.';
