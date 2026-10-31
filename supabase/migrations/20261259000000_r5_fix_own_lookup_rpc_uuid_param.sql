-- ============================================================================
-- R5 FIX — own-row lookup RPCs: client_write_key is UUID, not TEXT.
-- ============================================================================
-- 20261255 declared find_own_material_request / find_own_site_diary_entry with
-- `p_client_write_key text` and compared it directly in SQL to the
-- `client_write_key` column — which is type UUID on both material_requests and
-- site_diary_entries. In plpgsql there is no implicit uuid↔text cast, so the
-- comparison raised `42883 operator does not exist: uuid = text` EVERY time the
-- function ran. These RPCs only run on the offline replay's idempotency branch
-- (after a 23505 unique-violation on a re-sent queued item), so a first sync
-- succeeded but a REPLAY turned the lookup error into {status:"retry"} and the
-- device outbox never drained (caught by e2e/offline-diary-queue.spec.ts
-- "a REPLAYED queued item still yields exactly one row"). The admin-client
-- version this replaced used `.eq("client_write_key", key)`, where PostgREST
-- coerced the string to uuid — which is why the regression only appeared once
-- the lookup moved into an in-SQL comparison.
--
-- FIX: recreate both with `p_client_write_key uuid` (uuid = uuid). The offline
-- write path passes the key as a JSON string; PostgREST coerces it to uuid for
-- the uuid parameter, exactly as it did for the `.eq()` filter. A new argument
-- TYPE is a new overload, so the text versions are dropped first. The org guard
-- (current_org_ids() + 42501) and the (org, client_write_key, created_by)
-- self-scope are unchanged — no visibility is widened.
-- ROLLBACK:
--   drop function if exists public.find_own_material_request(uuid, uuid);
--   drop function if exists public.find_own_site_diary_entry(uuid, uuid);
--   -- then recreate the (uuid, text) versions from 20261255 (still broken).
-- ============================================================================

drop function if exists public.find_own_material_request(uuid, text);
drop function if exists public.find_own_site_diary_entry(uuid, text);

-- The id of THIS caller's material request for (org, client_write_key), or NULL.
create or replace function public.find_own_material_request(
  p_org_id uuid,
  p_client_write_key uuid
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

-- Same self-scoped idempotency lookup for the site_diary offline write core
-- (server/services/offline-writes.ts). Keyed on (org, client_write_key,
-- created_by = auth.uid()).
create or replace function public.find_own_site_diary_entry(
  p_org_id uuid,
  p_client_write_key uuid
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
