-- Safe "how many recovery codes do I have left?" reader.
--
-- WHY
-- ---
-- public.mfa_recovery_codes is service-role only (previous migration) — the
-- authenticated role cannot SELECT it, by design, so the raw hashes are never
-- browser-reachable. But the security settings page legitimately needs to show
-- the user how many UNUSED codes remain. This SECURITY DEFINER function is the
-- safe seam: it runs as owner (so it can read the locked table), is guarded to
-- the caller's own auth.uid(), and returns ONLY an integer count — never a hash,
-- never another user's data.
--
-- Pattern mirrors the guarded SECURITY DEFINER RPCs already in this codebase
-- (e.g. 20261116000000_secdef_org_rpc_membership_guard.sql): definer + fixed
-- search_path + an explicit auth guard, EXECUTE granted only to authenticated
-- (never anon).
--
-- Additive + idempotent (create or replace).

create or replace function public.mfa_recovery_codes_remaining()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n   integer;
begin
  -- No session → no count. Never leak a global tally to an anonymous caller.
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select count(*)::int
    into n
    from public.mfa_recovery_codes
   where user_id = uid
     and used_at is null;

  return coalesce(n, 0);
end;
$$;

comment on function public.mfa_recovery_codes_remaining() is
  'Returns the count of the CALLER''s unused MFA recovery codes (auth.uid()). '
  'SECURITY DEFINER so it can read the service-role-only table; returns only a '
  'count, never secret material.';

-- Default-deny then grant narrowly: authenticated only.
revoke all on function public.mfa_recovery_codes_remaining() from public, anon;
grant execute on function public.mfa_recovery_codes_remaining() to authenticated;
