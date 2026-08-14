-- MFA recovery (backup) codes — the missing half of TOTP MFA.
--
-- WHY THIS EXISTS
-- ---------------
-- Supabase's native MFA (auth.mfa_factors) gives us TOTP enrolment + challenge
-- but NO backup codes. A user who enrols an authenticator and loses the device
-- is stranded at the /login/mfa challenge. This table stores single-use recovery
-- codes so that user can disable the lost factor and get back in to re-enrol —
-- the industry-standard escape hatch for lost second factors.
--
-- SECRET HANDLING
-- ---------------
-- Only a ONE-WAY hash of each code is stored (scrypt, self-describing
-- `scrypt$N$r$p$salt$hash` — see lib/auth/recovery-codes.ts). Plaintext codes
-- are shown to the user exactly once at generation and never persisted. There
-- is nothing reversible here to leak.
--
-- ACCESS MODEL — SERVICE-ROLE ONLY (strictest)
-- --------------------------------------------
-- RLS is ENABLED and NO policy is granted to anon or authenticated, so the
-- default-deny of RLS means the PostgREST-facing roles can read/write NOTHING
-- in this table directly — not even a user's own rows. Every legitimate
-- interaction (generate, redeem, count) goes through a server action that first
-- authenticates the user with the user-context client and then touches this
-- table via the service-role client (lib/supabase/admin.ts, which bypasses RLS)
-- scoped explicitly to that user's id. This matches the "MFA secrets must be
-- strictly user-scoped, service-role only for secrets" doctrine: the raw hash
-- material is never exposed to a browser-reachable role. A safe INTEGER count
-- for the settings UI is exposed separately via a guarded SECURITY DEFINER
-- function (next migration), which returns no secret material.
--
-- Additive + idempotent.

create table if not exists public.mfa_recovery_codes (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  code_hash  text        not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.mfa_recovery_codes is
  'Single-use MFA backup codes. Stores only scrypt hashes. Service-role only: '
  'RLS is enabled with NO anon/authenticated policy; all access is via server '
  'actions using the service-role client scoped to auth user id.';

-- Fast lookup of a user''s still-usable codes (the redeem path scans these).
create index if not exists mfa_recovery_codes_user_unused_idx
  on public.mfa_recovery_codes (user_id)
  where used_at is null;

-- Enable RLS. With NO policy for anon/authenticated, those roles are fully
-- denied; service_role bypasses RLS. Belt-and-suspenders: also revoke the
-- table-level grants Supabase hands PostgREST roles by default.
alter table public.mfa_recovery_codes enable row level security;

revoke all on table public.mfa_recovery_codes from anon, authenticated;
