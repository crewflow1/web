-- CrewFlow HQ — Full Impersonation OS (HQ-10).
--
-- Every successful impersonation gets its own row. A super-admin
-- (per the CREWFLOW_SUPERADMIN_EMAILS env allowlist) starts a
-- session by inserting a row; ending the session sets ended_at.
--
-- Active impersonation is gated by:
--   1. The cookie `cf_impersonation_session` carries the row id.
--   2. The server (server/auth/session.ts) loads the row and
--      VERIFIES the admin_email still matches the current user.
--   3. ended_at IS NULL.
--   4. started_at within the last 24 hours (hard cap).
--
-- The cookie alone never grants access — the row is the truth.
-- Tampering with the cookie buys nothing because every load
-- re-checks the row + the super-admin allowlist.

create table if not exists public.impersonation_sessions (
  id              uuid primary key default gen_random_uuid(),
  -- Auditor (the HQ user starting the session).
  admin_user_id   uuid references public.users(id) on delete set null,
  admin_email     text not null,
  -- Target org. We deliberately DON'T pin a user_id — impersonation
  -- views the org as a generic operator, not a specific tenant
  -- person. If we ever need user-level swap we add target_user_id
  -- later without changing the existing flow.
  target_org_id   uuid not null references public.organizations(id) on delete cascade,
  target_user_id  uuid references public.users(id) on delete set null,

  reason          text check (reason is null or char_length(reason) between 1 and 2000),
  ip_address      text,
  user_agent      text,

  started_at      timestamp with time zone not null default now(),
  ended_at        timestamp with time zone,

  created_at      timestamp with time zone not null default now()
);

alter table public.impersonation_sessions enable row level security;
-- NO policies → service-role only. Customers never see these rows;
-- HQ reads via the admin client.

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------

create index if not exists impersonation_sessions_admin_idx
  on public.impersonation_sessions (admin_user_id, started_at desc);

create index if not exists impersonation_sessions_target_idx
  on public.impersonation_sessions (target_org_id, started_at desc);

-- Active sessions partial — the cookie-load check filters on this.
create index if not exists impersonation_sessions_active_idx
  on public.impersonation_sessions (id, started_at)
  where ended_at is null;
