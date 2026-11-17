-- ACCOUNT & DATA DELETION — one person (privacy/account-deletion, 3 of 4).
--
-- Two flows share these primitives:
--   • user_account  — a person deletes their OWN account (every org they are in);
--   • staff_erasure — an owner/admin removes a staff member from ONE company and
--                     erases the personal data that company holds about them.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE DATA-CLASS MODEL (the registry lives in lib/gdpr/user-erasure.json)
-- ═════════════════════════════════════════════════════════════════════════════
-- 255 foreign keys point at a user. Each (table.column) is in exactly one class:
--
--   DELETE       rows that exist only FOR the person (membership, notification
--                and device state, rota, assignments, AI drafts they made…) —
--                removed.
--   SCRUB        the row is a record the company must keep (working time, leave)
--                but carries free text / location about the person — the row
--                stays, its PII-named columns are blanked.
--   CONDITIONAL  the NI number: deleted unless a payroll line still needs it.
--   RETAIN       statutory or evidential records (payroll, pension, holiday
--                entitlement, signed H&S acknowledgements, inductions, quality
--                sign-offs) — kept, with the reason recorded in the registry.
--   PSEUDONYMISE (the derived default: every other, nullable, "who did this"
--                reference — created_by, approved_by, …) — the business record
--                is the company's and is left intact. It stops identifying the
--                person because the IDENTITY it points at is destroyed or
--                replaced by a placeholder (account deletion), or is no longer
--                readable by that company (staff erasure: RLS exposes a user's
--                profile only to co-members).
--
-- The registry is handed in as arrays (the classification lives ONCE, in the
-- repo, exactly like the org erasure registry) and is VALIDATED here against the
-- live catalogue before a single row is touched: any NOT NULL, CASCADE or
-- RESTRICT user reference on an org-scoped table that the caller did not
-- classify RAISES. A new table that hard-links a person cannot be silently
-- ignored by an erasure.
--
-- Additive and reversible (drop the functions).

-- PII column-name pattern: the 20261169 pattern, widened with the location,
-- signature-snapshot and hashed-network columns found on person-owned rows
-- (gps_lat/gps_lng, signed_name, person_name, ip_hash, review_note).
create or replace function public._privacy_pii_column_rx()
returns text language sql immutable set search_path = pg_catalog as $$
  select '(^|_)(name|full_name|first_name|last_name|forename|surname|maiden|'
      || 'email|phone|mobile|tel|fax|address|street|postcode|post_code|zip|city|town|'
      || 'dob|date_of_birth|national_insurance|ni_number|passport|utr|'
      || 'verification_reference|signature|signatory|ip_address|ip_hash|user_agent|'
      || 'latitude|longitude|geo|gps|lat|lng|lon|note|notes|description|message|body|subject|content|'
      || 'comment|reason|payload|metadata|recipient|sender|attendee|guest|nickname|'
      || 'username|avatar|photo|token|secret|password|credential)($|_)'
$$;

revoke all on function public._privacy_pii_column_rx() from public;
revoke execute on function public._privacy_pii_column_rx() from anon, authenticated;
grant execute on function public._privacy_pii_column_rx() to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. LOCKOUT for an account deletion — re-prove, then freeze the org list
-- ─────────────────────────────────────────────────────────────────────────────
-- DELETION RACING A ROLE CHANGE. The sole-owner rule was checked when the
-- request was created; it is checked AGAIN here under row locks, at run time. If
-- a co-owner was demoted or removed in between, deleting this account would now
-- orphan a company, so the request is CANCELLED ('sole_owner') instead of run.
-- The set of orgs to erase from is then frozen into the ledger, so a crash after
-- some memberships are gone still knows every org it has to finish.
create or replace function public.privacy_user_lockout(p_request_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row    public.privacy_deletion_requests%rowtype;
  v_orgs   uuid[];
  v_more   uuid[];
  v_detail jsonb;
  r        record;
begin
  perform public._privacy_require_service_role('privacy_user_lockout');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.kind <> 'user_account' or v_row.status <> 'running' then
    raise exception 'privacy_user_lockout: not a running account-deletion request' using errcode = 'check_violation';
  end if;
  if v_row.steps ? 'lockout' then
    return v_row.steps -> 'lockout';
  end if;

  perform 1 from public.memberships where user_id = v_row.target_user_id for update;
  if exists (
    select 1 from public.memberships m
    where m.user_id = v_row.target_user_id and m.role = 'owner'
      and not exists (
        select 1 from public.memberships o
        where o.org_id = m.org_id and o.role = 'owner' and o.user_id <> v_row.target_user_id
      )
  ) then
    update public.privacy_deletion_requests
       set status = 'cancelled', cancelled_at = now(), cancelled_reason = 'sole_owner',
           lease_expires_at = null, work = '{}'::jsonb
     where id = p_request_id;
    return jsonb_build_object('cancelled', true, 'reason', 'sole_owner');
  end if;

  -- Every org that holds ANY row linked to this person — not only current
  -- memberships: a former member's rows are still theirs to have erased.
  -- Catalogue-driven, so a table added later is covered without an edit here.
  select coalesce(array_agg(distinct org_id), '{}') into v_orgs
    from public.memberships where user_id = v_row.target_user_id;
  for r in
    select rel.relname as tbl, att.attname as col
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
    where c.contype = 'f'
      and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass)
      and rel.relnamespace = 'public'::regnamespace and rel.relkind = 'r'
      and array_length(c.conkey, 1) = 1
      and att.attname <> 'org_id'
      and exists (select 1 from pg_attribute o where o.attrelid = rel.oid and o.attname = 'org_id'
                    and o.atttypid = 'uuid'::regtype and not o.attisdropped)
  loop
    execute format(
      'select coalesce(array_agg(distinct org_id), ''{}'') from public.%I where %I = $1 and org_id is not null',
      r.tbl, r.col) into v_more using v_row.target_user_id;
    v_orgs := array(select distinct x from unnest(v_orgs || v_more) x);
  end loop;

  v_detail := jsonb_build_object('orgs', coalesce(array_length(v_orgs, 1), 0), 'done_at', now());
  update public.privacy_deletion_requests
     set steps = steps || jsonb_build_object('lockout', v_detail),
         work = work || jsonb_build_object('org_ids', to_jsonb(v_orgs))
   where id = p_request_id;
  return v_detail;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ERASE one person's footprint in ONE org — single transaction, fail-closed
-- ─────────────────────────────────────────────────────────────────────────────
-- The org and the user come from the LEDGER ROW. p_org_id only SELECTS among the
-- orgs the ledger already authorises (the one org of a staff erasure; one of the
-- frozen org_ids of an account deletion) — it can never widen the target.
--
-- Each entry of the class arrays is 'table.column'.
create or replace function public.privacy_user_erase_in_org(
  p_request_id  uuid,
  p_org_id      uuid,
  p_delete      text[],
  p_scrub       text[],
  p_conditional text[],
  p_retain      text[],
  p_employer_global text[] default '{}'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  c_protected_rx constant text := '^(id|org_id|created_at|updated_at|created_by|updated_by)$';
  v_row       public.privacy_deletion_requests%rowtype;
  v_user      uuid;
  v_step      text;
  v_entry     text;
  v_tbl       text;
  v_col       text;
  v_c         text;
  v_dtype     text;
  v_nullable  text;
  v_assign    text[];
  v_all       text[];
  v_missing   text[];
  v_remaining text[];
  v_next      text[];
  v_progress  boolean;
  v_pass      integer := 0;
  v_rc        bigint;
  v_deleted   jsonb := '{}'::jsonb;
  v_scrubbed  jsonb := '{}'::jsonb;
  v_retained  jsonb := '{}'::jsonb;
  v_detail    jsonb;
begin
  perform public._privacy_require_service_role('privacy_user_erase_in_org');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.status <> 'running' or v_row.kind not in ('user_account', 'staff_erasure') then
    raise exception 'privacy_user_erase_in_org: not a running person-erasure request' using errcode = 'check_violation';
  end if;
  v_user := v_row.target_user_id;

  if v_row.kind = 'staff_erasure' then
    if p_org_id is distinct from v_row.target_org_id then
      raise exception 'privacy_user_erase_in_org: org is not the target of this request' using errcode = '42501';
    end if;
  else
    if not (v_row.steps ? 'lockout')
       or not (coalesce(v_row.work -> 'org_ids', '[]'::jsonb) @> to_jsonb(array[p_org_id::text])) then
      raise exception 'privacy_user_erase_in_org: org is not in this request''s frozen org list' using errcode = '42501';
    end if;
  end if;

  v_step := 'erase_org:' || p_org_id::text;
  if v_row.steps ? v_step then
    return v_row.steps -> v_step;
  end if;

  -- ── VALIDATION ──────────────────────────────────────────────────────────────
  v_all := coalesce(p_delete, '{}') || coalesce(p_scrub, '{}')
        || coalesce(p_conditional, '{}') || coalesce(p_retain, '{}');
  if (select count(*) from unnest(v_all)) <> (select count(distinct e) from unnest(v_all) e) then
    raise exception 'privacy_user_erase_in_org: class sets overlap — refusing' using errcode = 'raise_exception';
  end if;
  -- Every ACTION entry that exists here must be an org-scoped base table with a
  -- uuid column of that name (absent tables are tolerated: migrate-first skew).
  foreach v_entry in array (coalesce(p_delete, '{}') || coalesce(p_scrub, '{}') || coalesce(p_conditional, '{}')) loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    if not exists (
         select 1 from pg_class c
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
         join pg_attribute u on u.attrelid = c.oid and u.attname = v_col and not u.attisdropped
                             and u.atttypid = 'uuid'::regtype
         where c.oid = to_regclass('public.' || quote_ident(v_tbl)) and c.relkind = 'r'
       ) then
      raise exception 'privacy_user_erase_in_org: refusing — "%" is not an org-scoped user reference', v_entry
        using errcode = 'raise_exception';
    end if;
  end loop;
  -- DRIFT, FAIL-CLOSED: every HARD user link on an org-scoped table must be
  -- classified. "Hard" = the column is NOT NULL, or the FK is CASCADE/RESTRICT.
  select coalesce(array_agg(distinct rel.relname || '.' || att.attname), '{}') into v_missing
  from pg_constraint c
  join pg_class rel on rel.oid = c.conrelid
  join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
  where c.contype = 'f'
    and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass)
    and rel.relnamespace = 'public'::regnamespace and rel.relkind = 'r'
    and att.attname <> 'org_id'
    and exists (select 1 from pg_attribute o where o.attrelid = rel.oid and o.attname = 'org_id' and not o.attisdropped)
    and (att.attnotnull or c.confdeltype in ('c', 'r'))
    and not ((rel.relname || '.' || att.attname) = any (v_all));
  if array_length(v_missing, 1) is not null then
    raise exception 'privacy_user_erase_in_org: unclassified hard user reference(s): % — classify in lib/gdpr/user-erasure.json', v_missing
      using errcode = 'raise_exception';
  end if;

  -- ── SCRUB (row kept, personal detail blanked) ───────────────────────────────
  foreach v_entry in array coalesce(p_scrub, '{}') loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;

    if v_tbl = 'activity_log' then
      -- The append-only guard (20261214) accepts exactly ONE update shape: the
      -- PII scrub. Issue precisely that shape, and only for rows not yet scrubbed.
      update public.activity_log
         set actor_name = '[erased]', metadata = 'null'::jsonb
       where org_id = p_org_id and actor_id = v_user
         and (actor_name is distinct from '[erased]' or metadata is distinct from 'null'::jsonb);
      get diagnostics v_rc = row_count;
    else
      v_assign := '{}';
      for v_c, v_dtype, v_nullable in
        select column_name, data_type, is_nullable
        from information_schema.columns
        where table_schema = 'public' and table_name = v_tbl
          and column_name !~ c_protected_rx
          and column_name <> v_col
          and column_name ~* public._privacy_pii_column_rx()
          and is_generated = 'NEVER'
      loop
        if v_nullable = 'YES' then
          v_assign := array_append(v_assign, format('%I = NULL', v_c));
        elsif v_dtype in ('text', 'character varying', 'character', 'citext') then
          v_assign := array_append(v_assign, format('%I = %L', v_c, '[erased]'));
        elsif v_dtype = 'jsonb' then
          v_assign := array_append(v_assign, format('%I = %L::jsonb', v_c, '{}'));
        end if; -- a NOT NULL non-text column cannot be blanked safely; left.
      end loop;
      v_rc := 0;
      if array_length(v_assign, 1) is not null then
        execute format('update public.%I set %s where org_id = $1 and %I = $2',
                       v_tbl, array_to_string(v_assign, ', '), v_col)
          using p_org_id, v_user;
        get diagnostics v_rc = row_count;
      end if;
    end if;
    if v_rc > 0 then v_scrubbed := v_scrubbed || jsonb_build_object(v_tbl, v_rc); end if;
  end loop;

  -- ── CONDITIONAL (NI number: gone unless payroll still needs it) ─────────────
  foreach v_entry in array coalesce(p_conditional, '{}') loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    if exists (select 1 from public.payroll_lines where org_id = p_org_id and user_id = v_user) then
      execute format('select count(*) from public.%I where org_id = $1 and %I = $2', v_tbl, v_col)
        into v_rc using p_org_id, v_user;
      if v_rc > 0 then v_retained := v_retained || jsonb_build_object(v_entry, v_rc); end if;
    else
      execute format('delete from public.%I where org_id = $1 and %I = $2', v_tbl, v_col)
        using p_org_id, v_user;
      get diagnostics v_rc = row_count;
      if v_rc > 0 then v_deleted := v_deleted || jsonb_build_object(v_tbl, v_rc); end if;
    end if;
  end loop;

  -- ── DELETE (topological retry, fail-closed — the 20261169 loop) ─────────────
  v_remaining := array(
    select e from unnest(coalesce(p_delete, '{}')) e
    where to_regclass('public.' || quote_ident(split_part(e, '.', 1))) is not null);
  loop
    exit when array_length(v_remaining, 1) is null;
    v_pass := v_pass + 1;
    v_progress := false;
    v_next := '{}';
    foreach v_entry in array v_remaining loop
      v_tbl := split_part(v_entry, '.', 1);
      v_col := split_part(v_entry, '.', 2);
      begin
        execute format('delete from public.%I where org_id = $1 and %I = $2', v_tbl, v_col)
          using p_org_id, v_user;
        get diagnostics v_rc = row_count;
        if v_rc > 0 then
          v_deleted := v_deleted || jsonb_build_object(v_tbl, coalesce((v_deleted ->> v_tbl)::bigint, 0) + v_rc);
        end if;
        v_progress := true;
      exception when foreign_key_violation then
        v_next := array_append(v_next, v_entry);
      end;
    end loop;
    exit when array_length(v_next, 1) is null;
    if not v_progress or v_pass > 50 then
      raise exception 'privacy_user_erase_in_org: delete did not converge; blocked by FK: % — NOTHING committed', v_next
        using errcode = 'raise_exception';
    end if;
    v_remaining := v_next;
  end loop;

  -- ── EMPLOYER-HELD rows that are keyed by user ALONE (pay rate + emergency
  -- contact live in a table with no org_id). They can only be attributed to
  -- this company when the person belongs to no other one, so they are removed
  -- exactly then; otherwise they are left and reported.
  foreach v_entry in array coalesce(p_employer_global, '{}') loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    if exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || quote_ident(v_tbl))
                 and attname = 'org_id' and not attisdropped) then
      raise exception 'privacy_user_erase_in_org: "%" is org-scoped — it belongs in the per-org classes', v_entry
        using errcode = 'raise_exception';
    end if;
    if exists (select 1 from public.memberships where user_id = v_user) then
      execute format('select count(*) from public.%I where %I = $1', v_tbl, v_col) into v_rc using v_user;
      if v_rc > 0 then v_retained := v_retained || jsonb_build_object(v_entry || ':other_membership', v_rc); end if;
    else
      execute format('delete from public.%I where %I = $1', v_tbl, v_col) using v_user;
      get diagnostics v_rc = row_count;
      if v_rc > 0 then v_deleted := v_deleted || jsonb_build_object(v_tbl, v_rc); end if;
    end if;
  end loop;

  -- ── RETAINED (counted, for the tombstone — never touched) ───────────────────
  foreach v_entry in array coalesce(p_retain, '{}') loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    continue when not exists (
      select 1 from pg_attribute where attrelid = to_regclass('public.' || quote_ident(v_tbl))
        and attname = v_col and not attisdropped);
    execute format('select count(*) from public.%I where org_id = $1 and %I = $2', v_tbl, v_col)
      into v_rc using p_org_id, v_user;
    if v_rc > 0 then v_retained := v_retained || jsonb_build_object(v_entry, v_rc); end if;
  end loop;

  v_detail := jsonb_build_object('deleted', v_deleted, 'scrubbed', v_scrubbed, 'retained', v_retained, 'done_at', now());
  update public.privacy_deletion_requests
     set steps = steps || jsonb_build_object(v_step, v_detail)
   where id = p_request_id;
  return v_detail;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. IDENTITY — blank the profile, clear user-keyed personal rows, measure
--    what still points at the person
-- ─────────────────────────────────────────────────────────────────────────────
-- Allowed for the target of an account deletion, and for a former member of a
-- company that has just been deleted (their id is in that request's captured
-- member set) — never for the subject of a staff erasure: an employer can erase
-- what IT holds, not delete someone's login.
--
-- A user who still belongs to ANY organisation is skipped untouched
-- ('has_memberships'): their account is in use elsewhere.
--
-- Returns the FOOTPRINT — every row, in any table, that still references the
-- user. The executor uses it to choose the end state of the auth identity:
--   footprint = 0  → the auth user is HARD-deleted (nothing is left to cascade
--                    into or to be blocked by);
--   footprint > 0  → retained records still need a row to point at, so the auth
--                    user is SOFT-deleted: credentials, sessions, email and
--                    metadata destroyed, an anonymous placeholder left behind.
create or replace function public.privacy_user_identity_scrub(
  p_request_id    uuid,
  p_user_id       uuid,
  p_global_delete text[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row       public.privacy_deletion_requests%rowtype;
  v_entry     text;
  v_tbl       text;
  v_col       text;
  v_rc        bigint;
  v_deleted   jsonb := '{}'::jsonb;
  v_footprint jsonb := '{}'::jsonb;
  v_total     bigint := 0;
  r           record;
begin
  perform public._privacy_require_service_role('privacy_user_identity_scrub');

  select * into v_row from public.privacy_deletion_requests where id = p_request_id for update;
  if not found or v_row.status <> 'running' then
    raise exception 'privacy_user_identity_scrub: request is not running' using errcode = 'check_violation';
  end if;
  if v_row.kind = 'user_account' then
    if p_user_id is distinct from v_row.target_user_id then
      raise exception 'privacy_user_identity_scrub: user is not the target of this request' using errcode = '42501';
    end if;
  elsif v_row.kind = 'org' then
    if not (v_row.steps ? 'teardown')
       or not (coalesce(v_row.work -> 'member_ids', '[]'::jsonb) @> to_jsonb(array[p_user_id::text])) then
      raise exception 'privacy_user_identity_scrub: user is not a captured member of the deleted company' using errcode = '42501';
    end if;
  else
    raise exception 'privacy_user_identity_scrub: a staff erasure never touches the person''s account' using errcode = '42501';
  end if;

  if not exists (select 1 from public.users where id = p_user_id) then
    return jsonb_build_object('outcome', 'already_gone', 'footprint_total', 0);
  end if;
  perform 1 from public.users where id = p_user_id for update;

  if exists (select 1 from public.memberships where user_id = p_user_id) then
    if v_row.kind = 'user_account' then
      raise exception 'privacy_user_identity_scrub: memberships remain — the per-org erasure has not finished'
        using errcode = 'check_violation';
    end if;
    return jsonb_build_object('outcome', 'has_memberships', 'footprint_total', null);
  end if;

  -- User-keyed personal rows that live OUTSIDE any org (pay rate + emergency
  -- contact, MFA recovery codes).
  foreach v_entry in array coalesce(p_global_delete, '{}') loop
    v_tbl := split_part(v_entry, '.', 1);
    v_col := split_part(v_entry, '.', 2);
    continue when to_regclass('public.' || quote_ident(v_tbl)) is null;
    if exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || quote_ident(v_tbl))
                 and attname = 'org_id' and not attisdropped) then
      raise exception 'privacy_user_identity_scrub: "%" is org-scoped — it belongs in the per-org classes', v_entry
        using errcode = 'raise_exception';
    end if;
    execute format('delete from public.%I where %I = $1', v_tbl, v_col) using p_user_id;
    get diagnostics v_rc = row_count;
    if v_rc > 0 then v_deleted := v_deleted || jsonb_build_object(v_tbl, v_rc); end if;
  end loop;

  -- The profile becomes a placeholder. The id survives so that retained records
  -- stay coherent ("Deleted user" did this) without naming anyone.
  update public.users
     set email = ('deleted-' || id::text || '@deleted.invalid'),
         full_name = 'Deleted user',
         phone = null,
         avatar_url = null,
         employment_type = null,
         start_date = null
   where id = p_user_id;

  -- Footprint: every remaining reference to the user, in any public table.
  for r in
    select rel.relname as tbl, att.attname as col
    from pg_constraint c
    join pg_class rel on rel.oid = c.conrelid
    join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
    where c.contype = 'f'
      and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass)
      and rel.relnamespace = 'public'::regnamespace and rel.relkind = 'r'
      and array_length(c.conkey, 1) = 1
      and not (rel.relname = 'users' and att.attname = 'id')
    order by rel.relname, att.attname
  loop
    execute format('select count(*) from public.%I where %I = $1', r.tbl, r.col) into v_rc using p_user_id;
    if v_rc > 0 then
      v_footprint := v_footprint || jsonb_build_object(r.tbl || '.' || r.col, v_rc);
      v_total := v_total + v_rc;
    end if;
  end loop;

  return jsonb_build_object(
    'outcome', 'scrubbed',
    'global_deleted', v_deleted,
    'footprint', v_footprint,
    'footprint_total', v_total
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. AUTH AUDIT PURGE — after the auth user is gone
-- ─────────────────────────────────────────────────────────────────────────────
-- Deleting a user makes GoTrue write one more `user_deleted` entry to its
-- in-database audit trail, quoting the email it just deleted. This is called
-- AFTER the Auth delete to remove that entry too. Hosted Supabase keeps auth
-- events in the platform log pipeline instead (the table is empty there), so on
-- production this is a no-op; it matters for self-hosted / local stacks and for
-- an honest residue scan. Same authority rule as the identity scrub.
create or replace function public.privacy_user_auth_audit_purge(
  p_request_id uuid,
  p_user_id    uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.privacy_deletion_requests%rowtype;
  v_n   bigint := 0;
begin
  perform public._privacy_require_service_role('privacy_user_auth_audit_purge');
  select * into v_row from public.privacy_deletion_requests where id = p_request_id;
  if not found or v_row.status <> 'running' then
    raise exception 'privacy_user_auth_audit_purge: request is not running' using errcode = 'check_violation';
  end if;
  if not (
       (v_row.kind = 'user_account' and p_user_id = v_row.target_user_id)
    or (v_row.kind = 'org' and coalesce(v_row.work -> 'member_ids', '[]'::jsonb) @> to_jsonb(array[p_user_id::text]))
  ) then
    raise exception 'privacy_user_auth_audit_purge: user is not a target of this request' using errcode = '42501';
  end if;
  -- Never purge the trail of an account that still exists and is in use.
  if exists (select 1 from auth.users where id = p_user_id and deleted_at is null) then
    return 0;
  end if;
  if to_regclass('auth.audit_log_entries') is not null then
    begin
      delete from auth.audit_log_entries
       where payload ->> 'actor_id' = p_user_id::text
          or payload -> 'traits' ->> 'user_id' = p_user_id::text;
      get diagnostics v_n = row_count;
    exception when insufficient_privilege or undefined_column then
      v_n := -1;
    end;
  end if;
  return v_n;
end;
$$;

revoke all on function public.privacy_user_auth_audit_purge(uuid, uuid) from public;
revoke execute on function public.privacy_user_auth_audit_purge(uuid, uuid) from anon, authenticated;
grant  execute on function public.privacy_user_auth_audit_purge(uuid, uuid) to service_role;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
revoke all on function public.privacy_user_lockout(uuid) from public;
revoke execute on function public.privacy_user_lockout(uuid) from anon, authenticated;
grant  execute on function public.privacy_user_lockout(uuid) to service_role;

revoke all on function public.privacy_user_erase_in_org(uuid, uuid, text[], text[], text[], text[], text[]) from public;
revoke execute on function public.privacy_user_erase_in_org(uuid, uuid, text[], text[], text[], text[], text[]) from anon, authenticated;
grant  execute on function public.privacy_user_erase_in_org(uuid, uuid, text[], text[], text[], text[], text[]) to service_role;

revoke all on function public.privacy_user_identity_scrub(uuid, uuid, text[]) from public;
revoke execute on function public.privacy_user_identity_scrub(uuid, uuid, text[]) from anon, authenticated;
grant  execute on function public.privacy_user_identity_scrub(uuid, uuid, text[]) to service_role;
