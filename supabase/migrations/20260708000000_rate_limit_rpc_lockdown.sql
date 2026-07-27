-- Security hardening: lock the rate-limit RPCs down to the service role only.
--
-- 20260707000000_rate_limit_counters.sql created public.rate_limit_hit() and
-- public.rate_limit_sweep() and ran `revoke all ... from public`, INTENDING
-- service-role-only execution (see that file's own comment, "Only the service
-- role may execute it").
--
-- That intent was not achieved. Supabase configures default privileges
-- (ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO
-- anon, authenticated, service_role), so every new public function is granted
-- EXECUTE to anon + authenticated as ROLE-SPECIFIC grants at creation time.
-- `revoke ... from public` does NOT remove role-specific grants, so anon and
-- authenticated retained EXECUTE and could invoke these SECURITY DEFINER RPCs
-- through PostgREST (POST /rest/v1/rpc/...) using the public anon key:
--   * rate_limit_sweep()  -> deletes counters, defeating the limiter that
--     protects auth email-send, customer-portal token routes, public quote
--     accept/decline, and the waitlist.
--   * rate_limit_hit(k,l,w) -> can pre-exhaust a victim's fixed window for a
--     targeted login / portal DoS.
--
-- Fix: explicitly revoke EXECUTE from anon + authenticated. The application
-- calls these only via the service-role admin client (lib/security/rate-limit.ts
-- -> createAdminClient().rpc(...)), and service_role keeps EXECUTE, so all
-- application behaviour is unchanged. Idempotent: revoking an absent privilege
-- is a no-op, so this is safe to (re)apply.

revoke execute on function public.rate_limit_hit(text, integer, integer) from anon, authenticated;
revoke execute on function public.rate_limit_sweep() from anon, authenticated;
