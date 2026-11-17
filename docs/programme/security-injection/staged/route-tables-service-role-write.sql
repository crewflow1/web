-- IMPLEMENTED 2026-11-16 as supabase/migrations/20261364000000_route_tables_service_role_write.sql
-- (slot assigned by the lead; renumbered at ship time if the release order changes).
-- Tests updated in the same branch to assert the NEW rule. This file is kept as the
-- staging record only — the migration is the source of truth.
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
-- Tests updated (they pinned the old admin-write posture; now assert service-role-only write):
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
