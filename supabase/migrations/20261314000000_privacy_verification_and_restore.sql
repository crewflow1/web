-- ACCOUNT & DATA DELETION — verification + backup-restore re-application
-- (privacy/account-deletion, 4 of 4).
--
--   1. privacy_residue_scan       — catalogue-driven "is anything left?" probe.
--   2. _privacy_introspect_*      — catalogue facts for the drift guards.
--   3. privacy_tombstone_export   — the tombstones, as opaque JSON, for the
--                                   off-platform backup to carry.
--   4. privacy_tombstone_reapply  — after a RESTORE: turn a tombstone that the
--                                   restored database no longer honours back
--                                   into a runnable deletion request.
--
-- All service_role-only. Additive and reversible (drop the functions).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. RESIDUE SCAN
-- ─────────────────────────────────────────────────────────────────────────────
-- Searches EVERY text / citext / varchar / json / jsonb / text[] column of EVERY
-- ordinary table in every non-system schema (public, auth, storage, …) for each
-- marker, case-insensitively, and returns one row per (location, marker) with a
-- non-zero hit count. It assumes NOTHING about which tables "should" hold
-- personal data — a table nobody classified is searched like any other. That is
-- what makes a clean result evidence rather than a tautology.
--
-- An OPERATOR / TEST verification tool: it sequentially scans the database, so
-- it is never called from a request path. Markers shorter than 6 characters are
-- refused (they would match noise and prove nothing).
create or replace function public.privacy_residue_scan(p_markers text[])
returns table (location text, marker text, hits bigint)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  r   record;
  m   text;
  v_n bigint;
begin
  perform public._privacy_require_service_role('privacy_residue_scan');
  if p_markers is null or array_length(p_markers, 1) is null or array_length(p_markers, 1) > 20 then
    raise exception 'privacy_residue_scan: 1–20 markers required' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(p_markers) x where x is null or length(btrim(x)) < 6) then
    raise exception 'privacy_residue_scan: every marker must be at least 6 characters' using errcode = 'check_violation';
  end if;

  for r in
    select n.nspname as sch, c.relname as tbl, a.attname as col
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    where c.relkind = 'r'
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg\_%'
      and t.typname in ('text', 'varchar', 'bpchar', 'citext', 'json', 'jsonb', 'name', '_text', '_varchar', '_citext')
      and has_table_privilege(c.oid, 'select')
    order by 1, 2, 3
  loop
    foreach m in array p_markers loop
      execute format('select count(*) from %I.%I where %I::text ilike $1', r.sch, r.tbl, r.col)
        into v_n using '%' || replace(replace(replace(m, '\', '\\'), '%', '\%'), '_', '\_') || '%';
      if v_n > 0 then
        location := r.sch || '.' || r.tbl || '.' || r.col;
        marker := m;
        hits := v_n;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CATALOGUE INTROSPECTION (drift guards)
-- ─────────────────────────────────────────────────────────────────────────────
-- Every foreign key from a public table to a user (public.users / auth.users).
create or replace function public._privacy_introspect_user_refs()
returns table (tbl text, col text, on_delete text, not_null boolean, org_scoped boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select rel.relname::text, att.attname::text,
         case c.confdeltype when 'c' then 'cascade' when 'n' then 'set_null'
                            when 'r' then 'restrict' when 'a' then 'no_action' else 'other' end,
         att.attnotnull,
         exists (select 1 from pg_attribute o where o.attrelid = rel.oid and o.attname = 'org_id' and not o.attisdropped)
  from pg_constraint c
  join pg_class rel on rel.oid = c.conrelid
  join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
  where c.contype = 'f'
    and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass)
    and rel.relnamespace = 'public'::regnamespace and rel.relkind = 'r'
    and att.attname <> 'org_id'
    and not (rel.relname = 'users' and att.attname = 'id')
    and auth.role() = 'service_role'
  order by 1, 2
$$;

-- Every row-level DELETE trigger on an org-scoped public table whose function
-- can RAISE, with whether its source carries the teardown escape (a reference to
-- public.organizations). A guard that raises unconditionally makes the tenant
-- impossible to delete; the integration guard fails CI on a new one.
create or replace function public._privacy_introspect_delete_guards()
returns table (tbl text, fn text, has_org_escape boolean)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select distinct c.relname::text, p.proname::text, (p.prosrc ilike '%organizations%')
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal
    and c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and (t.tgtype & 1) > 0            -- row-level
    and (t.tgtype & 8) > 0            -- DELETE
    and p.prosrc ilike '%raise exception%'
    and exists (select 1 from pg_attribute o where o.attrelid = c.oid and o.attname = 'org_id' and not o.attisdropped)
    and auth.role() = 'service_role'
  order by 1, 2
$$;

-- Every storage bucket (the erasure bucket census must cover them all).
create or replace function public._privacy_introspect_buckets()
returns table (bucket text)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select b.id::text from storage.buckets b where auth.role() = 'service_role' order by 1
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. TOMBSTONE EXPORT
-- ─────────────────────────────────────────────────────────────────────────────
-- A database backup taken BEFORE a deletion still contains the deleted data,
-- and — because the ledger lives in the same database — does NOT contain the
-- tombstone. Restoring that backup would silently resurrect erased people and
-- companies. The off-platform backup job therefore writes this export to a
-- SEPARATE, append-only object next to (never inside) the database dump. It is
-- safe to keep indefinitely: opaque ids, kinds and timestamps only.
create or replace function public.privacy_tombstone_export(p_since timestamptz default null)
returns setof jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
           'id', r.id, 'kind', r.kind,
           'target_org_id', r.target_org_id, 'target_user_id', r.target_user_id,
           'completed_at', r.completed_at, 'retention_until', r.retention_until)
  from public.privacy_deletion_requests r
  where r.status = 'completed'
    and (p_since is null or r.completed_at >= p_since)
    and auth.role() = 'service_role'
  order by r.completed_at, r.id
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. TOMBSTONE RE-APPLICATION (run after ANY restore, before reopening)
-- ─────────────────────────────────────────────────────────────────────────────
-- For one exported tombstone, decide what the restored database needs:
--   • a COMPLETED ledger row with that id exists      → 'already_applied'.
--   • a live (scheduled/failed/running) row exists    → the restore rewound an
--     in-flight job: its cooling-off is over (the deletion DID complete), so it
--     is made due now → 'resumed'.
--   • no row, and the target no longer exists         → 'nothing_to_reapply'.
--   • no row, and the target is back                  → a NEW request is
--     recorded (actor_role 'restore_reapply', reapply_of = the tombstone id),
--     due immediately → 'reapply_scheduled'.
-- It only RECORDS the work; the normal executor then runs the request through
-- the same resumable steps as any other deletion. No human confirmation is
-- re-collected: the authority is the original, completed deletion.
create or replace function public.privacy_tombstone_reapply(p_tombstone jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id     uuid;
  v_kind   text;
  v_org    uuid;
  v_user   uuid;
  v_row    public.privacy_deletion_requests%rowtype;
  v_exists boolean;
  v_new    uuid;
begin
  perform public._privacy_require_service_role('privacy_tombstone_reapply');

  v_id   := (p_tombstone ->> 'id')::uuid;
  v_kind := p_tombstone ->> 'kind';
  v_org  := (p_tombstone ->> 'target_org_id')::uuid;
  v_user := (p_tombstone ->> 'target_user_id')::uuid;
  if v_id is null or v_kind is null or v_kind not in ('org', 'user_account', 'staff_erasure') then
    raise exception 'privacy_tombstone_reapply: malformed tombstone' using errcode = 'check_violation';
  end if;

  select * into v_row from public.privacy_deletion_requests
   where id = v_id or reapply_of = v_id
   order by (status = 'completed') desc, created_at desc
   limit 1
   for update;
  if found then
    if v_row.status = 'completed' then
      return jsonb_build_object('outcome', 'already_applied', 'request_id', v_row.id);
    end if;
    if v_row.status in ('scheduled', 'failed', 'running') then
      update public.privacy_deletion_requests
         set scheduled_for = least(scheduled_for, now())
       where id = v_row.id;
      return jsonb_build_object('outcome', 'resumed', 'request_id', v_row.id);
    end if;
    -- 'cancelled' in the restored copy, yet a tombstone says it completed: the
    -- cancelled row is sealed, so fall through and record a fresh re-application.
  end if;

  if v_kind = 'org' then
    v_exists := exists (select 1 from public.organizations where id = v_org);
  elsif v_kind = 'user_account' then
    v_exists := exists (
      select 1 from public.users u
      where u.id = v_user
        and (u.email::text not like 'deleted-%@deleted.invalid'
             or exists (select 1 from public.memberships m where m.user_id = u.id)));
  else
    v_exists := exists (select 1 from public.memberships where org_id = v_org and user_id = v_user);
  end if;
  if not v_exists then
    return jsonb_build_object('outcome', 'nothing_to_reapply');
  end if;

  begin
    insert into public.privacy_deletion_requests
      (kind, target_org_id, target_user_id, actor_user_id, actor_role, scheduled_for, reapply_of)
    values (v_kind,
            case when v_kind = 'user_account' then null else v_org end,
            case when v_kind = 'org' then null else v_user end,
            null, 'restore_reapply', now(), v_id)
    returning id into v_new;
  exception when unique_violation then
    select id into v_new from public.privacy_deletion_requests r
     where r.kind = v_kind
       and r.target_org_id is not distinct from (case when v_kind = 'user_account' then null else v_org end)
       and r.target_user_id is not distinct from (case when v_kind = 'org' then null else v_user end)
       and r.status in ('scheduled', 'running', 'failed')
     limit 1;
    update public.privacy_deletion_requests set scheduled_for = least(scheduled_for, now()) where id = v_new;
    return jsonb_build_object('outcome', 'resumed', 'request_id', v_new);
  end;
  return jsonb_build_object('outcome', 'reapply_scheduled', 'request_id', v_new);
end;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
revoke all on function public.privacy_residue_scan(text[]) from public;
revoke execute on function public.privacy_residue_scan(text[]) from anon, authenticated;
grant  execute on function public.privacy_residue_scan(text[]) to service_role;

revoke all on function public._privacy_introspect_user_refs() from public;
revoke execute on function public._privacy_introspect_user_refs() from anon, authenticated;
grant  execute on function public._privacy_introspect_user_refs() to service_role;

revoke all on function public._privacy_introspect_delete_guards() from public;
revoke execute on function public._privacy_introspect_delete_guards() from anon, authenticated;
grant  execute on function public._privacy_introspect_delete_guards() to service_role;

revoke all on function public._privacy_introspect_buckets() from public;
revoke execute on function public._privacy_introspect_buckets() from anon, authenticated;
grant  execute on function public._privacy_introspect_buckets() to service_role;

revoke all on function public.privacy_tombstone_export(timestamptz) from public;
revoke execute on function public.privacy_tombstone_export(timestamptz) from anon, authenticated;
grant  execute on function public.privacy_tombstone_export(timestamptz) to service_role;

revoke all on function public.privacy_tombstone_reapply(jsonb) from public;
revoke execute on function public.privacy_tombstone_reapply(jsonb) from anon, authenticated;
grant  execute on function public.privacy_tombstone_reapply(jsonb) to service_role;
