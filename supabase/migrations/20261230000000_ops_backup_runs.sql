-- ops_backup_runs — heartbeat/ledger for the off-platform ENCRYPTED backup DR control.
--
-- The off-platform backup script (runs on the founder's Mac via launchd / manually)
-- writes one row per run: a "running" row at start, updated to "success" or "failed".
-- /admin/ops reads the latest rows to show backup freshness/health.
--
-- Design intent: the Mac scheduler is ONLY an execution mechanism. THIS table +
-- /admin/ops are the source of truth for backup health — so a missed or failed
-- backup becomes LOUD (amber/red), never a silent gap again.
--
-- Security: service-role only. The script writes via the pooler (superuser, RLS-exempt);
-- /admin/ops reads via the service-role admin client. No authenticated/anon policies are
-- defined, so RLS denies every other role. No credentials are ever stored here — only
-- run metadata (status, stage, sizes, checksums, migration tip, upload status).

create table if not exists public.ops_backup_runs (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null unique,
  host          text,
  backup_date   date,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running','success','failed')),
  stage         text,
  migration_tip text,
  upload_status text,
  error         text,
  file_manifest jsonb,
  created_at    timestamptz not null default now()
);

comment on table public.ops_backup_runs is
  'Heartbeat ledger for the off-platform encrypted backup DR control; read by /admin/ops. Service-role only. No secrets stored.';

create index if not exists ops_backup_runs_status_finished_idx
  on public.ops_backup_runs (status, finished_at desc);
create index if not exists ops_backup_runs_started_idx
  on public.ops_backup_runs (started_at desc);

alter table public.ops_backup_runs enable row level security;

-- Deliberately NO policies for authenticated/anon: RLS then denies all non-superuser,
-- non-service-role access. The backup script (pooler/superuser) and the /admin/ops
-- admin client (service_role) both bypass RLS by design.
