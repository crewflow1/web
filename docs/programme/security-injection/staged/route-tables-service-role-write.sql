-- STAGED — NOT A MIGRATION. Needs a version number from the lead (>= 20261363000000)
-- and founder approval before it is moved to supabase/migrations/.
--
-- Inbound routing tables are provisioned by HQ only: phone_numbers and
-- email_inbound_routes become service-role-write, matching the posture
-- whatsapp_number_routes already has (20261229000000, P1-1).
--
-- Verified 2026-11-16 (branch security/injection-secrets-hardening):
--   * every application writer of phone_numbers runs on the service-role client
--     (lib/telephony/provisioning.ts, app/admin/ai-receptionist/actions.ts);
--   * nothing in the application writes email_inbound_routes;
--   * tenant members keep their org-scoped SELECT policies (untouched), so an
--     operator can still see which number / address is wired.
--
-- Tests to update in the same PR (they pin the old admin-write posture):
--   __tests__/integration/telephony/phone-numbers-rls.test.ts   (owner inserts → service client;
--                                                                 add: owner/admin insert+update refused)
--   __tests__/security/telephony-voice-invariants.test.ts:86     (admin-write source pin)
--   __tests__/security/inbound-email-isolation.test.ts:85        (admin-write source pin)

drop policy if exists "phone_numbers: admins can insert" on public.phone_numbers;
drop policy if exists "phone_numbers: admins can update" on public.phone_numbers;
drop policy if exists "phone_numbers: admins can delete" on public.phone_numbers;
revoke insert, update, delete, truncate on table public.phone_numbers from authenticated, anon;

drop policy if exists "email_inbound_routes: admins can insert" on public.email_inbound_routes;
drop policy if exists "email_inbound_routes: admins can update" on public.email_inbound_routes;
revoke insert, update, delete, truncate on table public.email_inbound_routes from authenticated, anon;
