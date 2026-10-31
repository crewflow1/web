-- ============================================================================
-- R5 — self-scoped own-row lookup RPCs for the material-request offline path.
-- ============================================================================
-- The Phase 3 slice narrowed material_requests SELECT to assigned jobs, which
-- broke the offline replay's KEY-FIRST idempotency read (the caller can no
-- longer SELECT its own job-less / now-unassigned draft under JWT). The first
-- fix used createAdminClient() in server/services/material-request-writes.ts —
-- but the trust-boundary suite CORRECTLY forbids a service-role client anywhere
-- in the offline write path ("expansion cores — exactly as privileged as the
-- online forms"), and the unit tier can't even construct the admin client
-- (Node without native WebSocket). Service-role was the wrong mechanism.
--
-- These two SECURITY DEFINER RPCs are the right one: the offline write path
-- calls them through the TENANT client (no service-role client in the path), and
-- each is SELF-SCOPED to the caller's OWN rows (`created_by = auth.uid()`), so a
-- definer that bypasses the narrowed SELECT can still only ever surface a row
-- THIS caller wrote. They take p_org_id, so they also carry the canonical
-- membership guard (current_org_ids() + 42501) the secdef-org-rpc guard requires.
-- No visibility is widened: a member still cannot browse another member's — or
-- their own non-assigned — requests; only the replay engine confirms its own
-- prior write, keyed on (org, client_write_key, created_by).
-- ROLLBACK:
--   drop function if exists public.find_own_material_request(uuid, text);
--   drop function if exists public.own_material_request_line_count(uuid, uuid);
-- ============================================================================

-- The id of THIS caller's material request for (org, client_write_key), or NULL.
create or replace function public.find_own_material_request(
  p_org_id uuid,
  p_client_write_key text
) returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  select id into v_id
  from public.material_requests
  where org_id = p_org_id
    and client_write_key = p_client_write_key
    and created_by = auth.uid();
  return v_id;
end;
$$;

-- The line count of a material request the caller OWNS (created_by = auth.uid()),
-- for the stranded-header recovery probe. Returns 0 when the caller does not own
-- it (so recovery never acts on someone else's request).
create or replace function public.own_material_request_line_count(
  p_org_id uuid,
  p_request_id uuid
) returns integer language plpgsql stable security definer set search_path = public as $$
declare
  v_count integer;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  select count(l.*)::int into v_count
  from public.material_request_lines l
  join public.material_requests r
    on r.id = l.material_request_id and r.org_id = l.org_id
  where r.id = p_request_id
    and r.org_id = p_org_id
    and r.created_by = auth.uid();
  return coalesce(v_count, 0);
end;
$$;

-- Same self-scoped idempotency lookup for the site_diary offline write core
-- (server/services/offline-writes.ts), which had the same service-role lookup
-- for the same R5 reason. Keyed on (org, client_write_key, created_by=auth.uid()).
create or replace function public.find_own_site_diary_entry(
  p_org_id uuid,
  p_client_write_key text
) returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role'
     and p_org_id not in (select public.current_org_ids()) then
    raise exception 'Forbidden: not a member of this org' using errcode = '42501';
  end if;
  select id into v_id
  from public.site_diary_entries
  where org_id = p_org_id
    and client_write_key = p_client_write_key
    and created_by = auth.uid();
  return v_id;
end;
$$;
