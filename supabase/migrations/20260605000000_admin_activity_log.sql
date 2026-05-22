-- CrewFlow HQ — admin activity log.
--
-- Why a separate table from the existing public.activity_log:
--
--   public.activity_log is per-tenant — its FK forces an org_id and the
--   RLS policy scopes reads to org members. HQ operations (demo CRM
--   moves, super-admin status flips, impersonation grants) often happen
--   BEFORE an org exists (e.g. a demo request in `pending_demo` has no
--   org yet) and ACROSS tenants (the CEO moves dozens of orgs per day).
--   Shoehorning them into the tenant table would require a sentinel
--   `crewflow_hq` org and would leak HQ events into customer feeds.
--
-- This table records HQ-side actions only. There are NO RLS policies:
-- the table is read/written through the service-role admin client from
-- app/admin/* code paths gated by isSuperAdminEmail. Direct API access
-- via PostgREST is blocked because RLS-enabled tables with no policies
-- default to deny.
--
-- Schema choices:
--   - target_table+target_id is generic (mirrors public.activity_log)
--     so the same table records demo_request moves, org status flips,
--     impersonation events, etc. Indexed for per-target timeline reads.
--   - actor_email is denormalised (the FK to public.users captures the
--     id) so historical entries survive a user deletion.
--   - metadata jsonb for free-form fields (old status, new status,
--     reason, link, ip-hash if relevant).

create table if not exists public.admin_activity_log (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references public.users(id) on delete set null,
  actor_email   text,
  action        text not null,
  target_table  text not null,
  target_id     uuid not null,
  metadata      jsonb,
  created_at    timestamp with time zone not null default now()
);

alter table public.admin_activity_log enable row level security;
-- No policies → read/write only via service-role client.

create index if not exists admin_activity_log_target_idx
  on public.admin_activity_log (target_table, target_id, created_at desc);

create index if not exists admin_activity_log_actor_idx
  on public.admin_activity_log (actor_id, created_at desc);

create index if not exists admin_activity_log_recent_idx
  on public.admin_activity_log (created_at desc);
