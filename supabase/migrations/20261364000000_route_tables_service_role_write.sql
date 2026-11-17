-- Inbound routing tables are provisioned by HQ / server flows only:
-- phone_numbers and email_inbound_routes become SERVICE-ROLE-WRITE, the posture
-- whatsapp_number_routes already has (20261229000000, P1-1).
--
-- A routing row is the KEY a webhook resolves a tenant from (the dialled number,
-- the inbound address). The previous admin-write policies only proved that the
-- writing org was the caller's own; nothing proved the number / address belonged
-- to that org — that fact lives at the provider, not in tenant-writable data.
--
-- Application writers (verified 2026-11-16) all run on the service-role client
-- behind a session + role guard, so this removes nothing the app uses:
--   * lib/telephony/provisioning.ts provisionNumber / releaseNumber — called from
--     app/(app)/settings/ai-receptionist/number-actions.ts (owner/admin of the
--     session's active org) and app/admin/ai-receptionist/actions.ts (HQ super-admin);
--   * app/admin/ai-receptionist/actions.ts provisionPhoneNumber / setPhoneNumberActive
--     (HQ super-admin);
--   * nothing in the application writes email_inbound_routes.
-- Tenant members KEEP their org-scoped SELECT policies (untouched) and the
-- column-level SELECT grants on phone_numbers (provider_auth_secret stays excluded).
--
-- Additive in effect: drops write policies + write privileges only. No data change.
-- Rollback (re-opens the door — do not use except to revert this release):
--   grant insert, update, delete on public.phone_numbers, public.email_inbound_routes to authenticated;
--   and re-create the dropped policies from 20261098000000 / 20261126000000.

drop policy if exists "phone_numbers: admins can insert" on public.phone_numbers;
drop policy if exists "phone_numbers: admins can update" on public.phone_numbers;
drop policy if exists "phone_numbers: admins can delete" on public.phone_numbers;
revoke insert, update, delete, truncate on table public.phone_numbers from authenticated, anon;

drop policy if exists "email_inbound_routes: admins can insert" on public.email_inbound_routes;
drop policy if exists "email_inbound_routes: admins can update" on public.email_inbound_routes;
revoke insert, update, delete, truncate on table public.email_inbound_routes from authenticated, anon;
