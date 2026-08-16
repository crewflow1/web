-- ===========================================================================
-- Per-org MFA policy — the ENFORCEMENT flag (opt-in, default OFF).
-- ===========================================================================
--
-- Existing TOTP enrol/challenge (app/(app)/settings/security + app/(auth))
-- is OPT-IN per user: enrolling adds a factor, but nothing forces a
-- privileged user to reach aal2 to use the app. This migration adds the
-- ORG-LEVEL policy knob that lets an org REQUIRE MFA for its privileged
-- roles (owner/admin).
--
-- SEMANTICS (enforced in server/auth/session.ts#requireOrgContext, decision in
-- lib/auth/mfa-policy.ts):
--   require_mfa = false  → no change to any existing behaviour (the default).
--   require_mfa = true   → owner/admin members are gated: a session that is not
--                          aal2 is redirected to complete (or first enrol) TOTP
--                          before any (app) surface renders. Non-privileged
--                          members are unaffected (RLS + role checks remain the
--                          real data boundary).
--
-- Default false is deliberate and load-bearing: flipping enforcement on for an
-- existing org is a customer decision (it will bounce every owner/admin who has
-- no factor into enrolment), never a silent migration side effect.
--
-- Additive, backward-compatible: NOT NULL DEFAULT false backfills every
-- existing row to the no-enforcement state.

alter table public.organizations
  add column if not exists require_mfa boolean not null default false;

comment on column public.organizations.require_mfa is
  'When true, owner/admin members must reach aal2 (complete TOTP) to access the app. Opt-in per org; default false. Enforced in requireOrgContext via lib/auth/mfa-policy.ts.';
