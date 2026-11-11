-- =========================================================================
-- phone_numbers — PROVISIONING + ONBOARDING metadata (Twilio receptionist PR 4)
--
-- The Wave-8 phone_numbers table is the org↔dialed-number routing map. Automated
-- number provisioning (search → buy → assign) and existing-number onboarding
-- (Option A: keep your number, forward to a dedicated Twilio receiving number)
-- need a little more metadata per number: what TYPE it is, what it costs, the UK
-- regulatory bundle + emergency address attached at purchase, whether it is a new
-- Twilio number or a forwarding receiver, and provisioning/release timestamps.
--
-- All additive + nullable, so existing rows upgrade losslessly. None is a secret
-- (the per-number auth secret stays provider_auth_secret, already service-role-only)
-- so the new columns are added to the authenticated column-level SELECT grant that
-- the base migration established — otherwise members could not read them back over
-- PostgREST (the base migration revoked the table-wide SELECT and grants per column).
-- Writes stay admin-only via the existing RLS policies + the service role.
-- =========================================================================

alter table public.phone_numbers
  -- The number TYPE — drives UK regulatory requirements (local/national need a UK
  -- address + bundle; mobile/tollfree differ) and display. 'forwarding' = a Twilio
  -- receiving number backing an existing-number (Option A) onboarding.
  add column if not exists number_type text
    check (number_type is null or number_type in ('local', 'national', 'mobile', 'tollfree', 'forwarding')),
  -- Monthly rental cost in pence, captured at purchase for in-app cost accounting.
  add column if not exists monthly_cost_pence integer check (monthly_cost_pence is null or monthly_cost_pence >= 0),
  -- The UK Regulatory (RC) Bundle SID attached at purchase (a reference, not a secret).
  add column if not exists regulatory_bundle_sid text,
  -- The emergency address SID attached for outbound/999 compliance (a reference).
  add column if not exists emergency_address_sid text,
  -- How the org got this number onto CrewFlow.
  add column if not exists onboarding_mode text
    check (onboarding_mode is null or onboarding_mode in ('new_number', 'existing_number_forward')),
  -- For Option A: the org's ORIGINAL business number that forwards to this receiver.
  add column if not exists forwarding_from text,
  -- When the number was provisioned / released (release deactivates the row).
  add column if not exists provisioned_at timestamptz,
  add column if not exists released_at timestamptz;

-- Expose the new NON-SECRET columns on the authenticated read surface. The base
-- migration revoked the table-wide SELECT and grants column-by-column, so a new
-- column is unreadable until named here. provider_auth_secret is deliberately NOT
-- added — it stays service-role-only. Idempotent (replays cleanly on db reset).
grant select (
  number_type, monthly_cost_pence, regulatory_bundle_sid, emergency_address_sid,
  onboarding_mode, forwarding_from, provisioned_at, released_at
) on public.phone_numbers to authenticated;
