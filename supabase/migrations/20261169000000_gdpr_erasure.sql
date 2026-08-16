-- GDPR RIGHT-TO-ERASURE (Art. 17) — account teardown / data-subject erasure.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- THE DESTRUCTIVE MIRROR OF THE EXPORT CAPABILITY. HIGHEST SAFETY BAR.
-- ═════════════════════════════════════════════════════════════════════════════
-- Where 20261105000000 records a READ-ONLY export, this migration ships the
-- DESTRUCTIVE half GDPR Art. 17 requires: erase one organisation's personal
-- data. Two objects:
--
--   1. public.gdpr_erasure_log — the append-only accountability trail (Art.5(2))
--      of every erasure, the destructive sibling of gdpr_export_log.
--   2. public.gdpr_erase_org(...) — a SINGLE-TRANSACTION, service_role-only,
--      fail-closed primitive that ANONYMISES statutory-retention records in
--      place and HARD-DELETES everything else for one org, then writes the log.
--
-- ── WHY A SECURITY DEFINER FUNCTION (not app-side per-table writes) ───────────
-- Atomicity. A partial erasure — some tables destroyed, others not — is the
-- worst outcome (personal data half-gone, integrity broken, non-idempotent).
-- One plpgsql function is ONE transaction: it either erases fully and commits,
-- or raises and rolls back leaving the org byte-for-byte as it was. There is no
-- middle state. Everything below is engineered so that ANY surprise (an
-- unexpected FK, a missing table, a type mismatch) RAISES rather than proceeds.
--
-- ── THE CLASSIFICATION IS NOT DUPLICATED HERE ────────────────────────────────
-- The per-table disposition (anonymise / retain / hard-delete) lives ONCE, in
-- lib/gdpr/org-tables.json → lib/gdpr/erase-tables.ts, drift-guarded against the
-- live schema by the SAME bidirectional reverse guard the export uses. The
-- caller (server/services/gdpr-erase.ts) passes the three sets in as ARRAYS, so
-- SQL never holds a second, drift-prone copy. The function VALIDATES what it is
-- handed (every action table is a real org-scoped BASE table; the sets are
-- disjoint) before touching a single row — a malformed or hostile call is
-- refused, not executed.
--
-- ── STORAGE BYTES ARE CLEANED IN TS, NOT HERE ────────────────────────────────
-- Deleting a `storage.objects` ROW in SQL does NOT delete the backing S3 object
-- (a well-known Supabase gotcha) — it would orphan the bytes. Storage cleanup
-- therefore goes through the Storage API in the service (idempotent, org-prefix
-- scoped) and its result count is passed in for the audit row. This function is
-- DB-only.
--
-- ── GATING (DARK BY DEFAULT — CANNOT FIRE ACCIDENTALLY) ───────────────────────
-- Three independent locks, ALL required:
--   • service_role only — revoked from public/anon/authenticated; the anon key
--     can never reach it. auth.role() is re-checked inside as defence in depth.
--   • confirmation token — p_confirm MUST equal the org's slug, re-verified in
--     the DB (belt-and-braces on top of the route's owner + confirm checks).
--   • feature flag — the ROUTE refuses unless FEATURE_GDPR_ERASURE='true'
--     (server-only env, default off). The flag never reaches SQL; it gates the
--     only caller.
--
-- Additive and reversible:
--   drop function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid);
--   drop table public.gdpr_erasure_log;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE ACCOUNTABILITY TRAIL — append-only, member-read, service_role-write.
-- ─────────────────────────────────────────────────────────────────────────────
-- Records WHEN, FOR WHOM, BY WHOM an erasure ran and its counts. Carries NO
-- money, NO PII, NO secrets — counts + a slug + a status. It is itself in the
-- ERASURE 'retain' set (lib/gdpr/org-tables.json): the record of an erasure must
-- survive the erasure it documents. Only status 'erased' exists.
--
-- No AFTER-DELETE activity trigger and cascade-to-org (the 20261052 teardown
-- rule: a child with both breaks `delete from organizations`).
create table if not exists public.gdpr_erasure_log (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references public.organizations(id) on delete cascade,
  -- The slug the caller confirmed against (proves the anti-misfire gate ran).
  confirmed_slug           text not null,
  anonymised_tables        integer not null default 0 check (anonymised_tables >= 0),
  anonymised_rows          integer not null default 0 check (anonymised_rows >= 0),
  deleted_tables           integer not null default 0 check (deleted_tables >= 0),
  deleted_rows             integer not null default 0 check (deleted_rows >= 0),
  storage_objects_deleted  integer not null default 0 check (storage_objects_deleted >= 0),
  status                   text not null default 'erased' check (status in ('erased')),
  requested_by             uuid references public.users(id) on delete set null,
  note                     text,
  created_at               timestamptz not null default now(),
  constraint gdpr_erasure_log_id_org_key unique (id, org_id)
);

create index if not exists gdpr_erasure_log_org_created_idx
  on public.gdpr_erasure_log (org_id, created_at desc);

alter table public.gdpr_erasure_log enable row level security;

-- Members may READ their org's erasure history (accountability). NOTE: erasure
-- hard-deletes `memberships`, so post-erasure only service_role/super-admin can
-- read the trail — which is correct (the org is erased). No insert/update/delete
-- policy: only the SECURITY DEFINER function (running as service_role) writes,
-- and the row is append-only evidence.
drop policy if exists "gdpr_erasure_log: members can select" on public.gdpr_erasure_log;
create policy "gdpr_erasure_log: members can select" on public.gdpr_erasure_log
  for select to authenticated using (org_id in (select public.current_org_ids()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE ERASURE PRIMITIVE — one transaction, fail-closed, idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
-- Arguments:
--   p_org_id                   the org to erase.
--   p_confirm                  MUST equal the org slug (anti-misfire gate).
--   p_anonymise                statutory tables to scrub-in-place.
--   p_hard_delete              tables to destroy.
--   p_retain                   platform/evidence tables to leave (passed for
--                              disjointness validation only — never touched).
--   p_storage_objects_deleted  count of storage objects the service already
--                              removed via the Storage API (for the audit row).
--   p_requested_by             the authenticated owner/super-admin who triggered
--                              it (for the audit row).
--
-- Returns a jsonb summary of everything it did.
--
-- ORDER OF OPERATIONS (order is load-bearing):
--   a. AUTHZ + CONFIRM + VALIDATION — refuse anything unsafe before any write.
--   b. ANONYMISE — scrub PII-named columns on statutory tables, AND null any
--      nullable FK column that points at a hard-delete table. That FK-detach is
--      the key correctness step: it lets a hard-delete PARENT (customers, jobs)
--      be removed WITHOUT destroying the retained statutory CHILD (invoices,
--      finances) — neutralising RESTRICT / NO ACTION (delete would be blocked)
--      AND CASCADE (delete would destroy the retained row) alike, because the
--      reference is already NULL before the parent is deleted.
--   c. HARD-DELETE — a topological loop: delete every table that will delete
--      this pass (each in its own savepoint), carry FK-blocked tables to the
--      next pass, and RAISE (roll everything back) if a pass makes no progress.
--      Order-independent and self-maintaining — no hand-kept FK ordering to rot.
--   d. AUDIT — append one gdpr_erasure_log row.
create or replace function public.gdpr_erase_org(
  p_org_id                  uuid,
  p_confirm                 text,
  p_anonymise               text[],
  p_hard_delete             text[],
  p_retain                  text[],
  p_storage_objects_deleted integer default 0,
  p_requested_by            uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, information_schema
as $$
declare
  -- PII column-name pattern — the erasure mirror of export's SENSITIVE_COLUMN_RX,
  -- widened to identity/contact PII. Matches columns holding data that could
  -- identify a natural person; statutory VALUE columns (amount, total, vat, rate,
  -- date, number, period, quantity, status, code, currency) are NOT matched, so
  -- an anonymised financial record keeps its statutory figures.
  c_pii_rx constant text :=
    '(^|_)(name|full_name|first_name|last_name|forename|surname|maiden|' ||
    'email|phone|mobile|tel|fax|address|street|postcode|post_code|zip|city|town|' ||
    'dob|date_of_birth|national_insurance|ni_number|passport|utr|' ||
    'verification_reference|signature|signatory|ip_address|user_agent|' ||
    'latitude|longitude|geo|note|notes|description|message|body|subject|content|' ||
    'comment|reason|payload|metadata|recipient|sender|attendee|guest|nickname|' ||
    'username|avatar|photo|token|secret|password|credential)($|_)';
  -- Structural columns never scrubbed: identity, tenancy pin, timestamps, and
  -- the audit actor columns (nulling them would break integrity / the trail).
  c_protected_rx constant text := '^(id|org_id|created_at|updated_at|created_by|updated_by)$';

  v_slug          text;
  v_tbl           text;
  v_col           text;
  v_dtype         text;
  v_nullable      text;
  v_assign        text[];
  v_handled       text[];
  v_anon_exist    text[];
  v_del_exist     text[];
  v_remaining     text[];
  v_next          text[];
  v_progress      boolean;
  v_pass          integer := 0;
  v_rc            integer;
  v_anon_rows     integer := 0;
  v_anon_tables   integer := 0;
  v_del_rows      integer := 0;
  v_del_tables    integer := 0;
begin
  -- ── a. AUTHZ ────────────────────────────────────────────────────────────────
  -- service_role only. The GRANT already restricts this, but re-check inside so
  -- a future mis-grant (or a CREATE OR REPLACE re-applying Supabase default
  -- privileges) cannot open a destructive door.
  if auth.role() is distinct from 'service_role' then
    raise exception 'gdpr_erase_org: service_role only' using errcode = '42501';
  end if;

  -- Org must exist.
  select slug into v_slug from public.organizations where id = p_org_id;
  if v_slug is null then
    raise exception 'gdpr_erase_org: org % not found', p_org_id using errcode = 'no_data_found';
  end if;

  -- ── CONFIRMATION TOKEN (anti-misfire) ───────────────────────────────────────
  -- Even at the service_role layer, the caller MUST prove intent by echoing the
  -- exact org slug. A blank or wrong token refuses — the erasure cannot fire on
  -- a fat-fingered org id alone.
  if p_confirm is null or btrim(p_confirm) = '' or p_confirm <> v_slug then
    raise exception 'gdpr_erase_org: confirmation token does not match org slug — refusing'
      using errcode = 'check_violation';
  end if;

  -- ── DISJOINTNESS ────────────────────────────────────────────────────────────
  -- A table in two dispositions is a classification bug; refuse rather than pick.
  if exists (
        select 1 from unnest(coalesce(p_anonymise, '{}')) a
        where a = any(coalesce(p_hard_delete, '{}')) or a = any(coalesce(p_retain, '{}'))
     )
     or exists (
        select 1 from unnest(coalesce(p_hard_delete, '{}')) h
        where h = any(coalesce(p_retain, '{}'))
     ) then
    raise exception 'gdpr_erase_org: disposition sets overlap — refusing' using errcode = 'raise_exception';
  end if;

  -- ── EXISTENCE + SHAPE VALIDATION ────────────────────────────────────────────
  -- Migrate-first tolerance: an action table absent from THIS schema is skipped
  -- (benign snapshot/live skew). But any action table that DOES exist MUST be a
  -- public BASE TABLE carrying org_id — otherwise a mis-classification could
  -- scrub/destroy a non-org table. That case RAISES (fail-closed).
  select coalesce(array_agg(t), '{}') into v_anon_exist
    from unnest(coalesce(p_anonymise, '{}')) t
    where to_regclass('public.' || quote_ident(t)) is not null;
  select coalesce(array_agg(t), '{}') into v_del_exist
    from unnest(coalesce(p_hard_delete, '{}')) t
    where to_regclass('public.' || quote_ident(t)) is not null;

  foreach v_tbl in array (v_anon_exist || v_del_exist) loop
    if not exists (
         select 1 from information_schema.tables
         where table_schema = 'public' and table_name = v_tbl and table_type = 'BASE TABLE'
       )
       or not exists (
         select 1 from information_schema.columns
         where table_schema = 'public' and table_name = v_tbl and column_name = 'org_id'
       ) then
      raise exception 'gdpr_erase_org: refusing — "%" is not an org-scoped public base table', v_tbl
        using errcode = 'raise_exception';
    end if;
  end loop;

  -- ── b. ANONYMISE (+ FK-detach) ──────────────────────────────────────────────
  foreach v_tbl in array v_anon_exist loop
    v_assign  := '{}';
    v_handled := '{}';

    -- PII-named columns → token (text) / json null (jsonb) / NULL (nullable).
    for v_col, v_dtype, v_nullable in
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = v_tbl
        and column_name !~ c_protected_rx
        and column_name ~* c_pii_rx
    loop
      if v_dtype in ('text', 'character varying', 'character', 'citext', 'name') then
        v_assign := array_append(v_assign, format('%I = %L', v_col, '[erased]'));
      elsif v_dtype = 'jsonb' then
        v_assign := array_append(v_assign, format('%I = %L::jsonb', v_col, 'null'));
      elsif v_dtype = 'json' then
        v_assign := array_append(v_assign, format('%I = %L::json', v_col, 'null'));
      elsif v_nullable = 'YES' then
        v_assign := array_append(v_assign, format('%I = NULL', v_col));
      else
        continue; -- non-nullable, non-text PII (rare) — cannot safely null; leave
      end if;
      v_handled := array_append(v_handled, v_col);
    end loop;

    -- FK-detach: null every NULLABLE fk column on this retained table that points
    -- at a HARD-DELETE table, so the parent can be destroyed without cascading
    -- into (or being blocked by) this statutory row.
    for v_col in
      select att.attname
      from pg_constraint c
      join pg_class rel  on rel.oid  = c.conrelid
      join pg_class frel on frel.oid = c.confrelid
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = any (c.conkey)
      where c.contype = 'f'
        and rel.relnamespace = 'public'::regnamespace
        and rel.relname = v_tbl
        and frel.relname = any (v_del_exist)
        and att.attnotnull = false
    loop
      if not (v_col = any (v_handled)) then
        v_assign  := array_append(v_assign, format('%I = NULL', v_col));
        v_handled := array_append(v_handled, v_col);
      end if;
    end loop;

    if array_length(v_assign, 1) is not null then
      execute format('update public.%I set %s where org_id = $1', v_tbl, array_to_string(v_assign, ', '))
        using p_org_id;
      get diagnostics v_rc = row_count;
      v_anon_rows   := v_anon_rows + v_rc;
      v_anon_tables := v_anon_tables + 1;
    end if;
  end loop;

  -- ── c. HARD-DELETE (topological loop, fail-closed) ──────────────────────────
  v_remaining := v_del_exist;
  loop
    exit when array_length(v_remaining, 1) is null;
    v_pass := v_pass + 1;
    if v_pass > 200 then
      -- Cannot happen for a finite acyclic set that makes progress; a guard so a
      -- pathological schema can never spin. Raising rolls the whole tx back.
      raise exception 'gdpr_erase_org: hard-delete exceeded 200 passes (schema pathology) — nothing committed'
        using errcode = 'raise_exception';
    end if;
    v_progress := false;
    v_next := '{}';

    foreach v_tbl in array v_remaining loop
      begin
        execute format('delete from public.%I where org_id = $1', v_tbl) using p_org_id;
        get diagnostics v_rc = row_count;
        v_del_rows   := v_del_rows + v_rc;
        v_del_tables := v_del_tables + 1;
        v_progress   := true;
      exception when foreign_key_violation then
        -- Still referenced by a table not yet deleted this pass — retry next pass.
        v_next := array_append(v_next, v_tbl);
      end;
    end loop;

    exit when array_length(v_next, 1) is null;
    if not v_progress then
      -- A pass deleted nothing yet tables remain: an unresolved FK from a
      -- retained/anonymised row (unexpected — FK-detach should have cleared it)
      -- or a genuine cycle. FAIL CLOSED — roll everything back rather than leave
      -- a half-erased org.
      raise exception 'gdpr_erase_org: hard-delete did not converge; blocked by FK: % — NOTHING committed', v_next
        using errcode = 'raise_exception';
    end if;
    v_remaining := v_next;
  end loop;

  -- ── d. AUDIT ────────────────────────────────────────────────────────────────
  insert into public.gdpr_erasure_log (
    org_id, confirmed_slug, anonymised_tables, anonymised_rows,
    deleted_tables, deleted_rows, storage_objects_deleted, status, requested_by
  ) values (
    p_org_id, v_slug, v_anon_tables, v_anon_rows,
    v_del_tables, v_del_rows, greatest(coalesce(p_storage_objects_deleted, 0), 0), 'erased', p_requested_by
  );

  return jsonb_build_object(
    'org_id', p_org_id,
    'status', 'erased',
    'anonymised_tables', v_anon_tables,
    'anonymised_rows', v_anon_rows,
    'deleted_tables', v_del_tables,
    'deleted_rows', v_del_rows,
    'storage_objects_deleted', greatest(coalesce(p_storage_objects_deleted, 0), 0)
  );
end;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
-- Supabase default privileges grant EXECUTE on new public functions to anon +
-- authenticated at CREATE time, and `revoke ... from public` does NOT strip
-- those role-specific grants. Revoke them EXPLICITLY up front so this destructive
-- function can never ship anon/authenticated-reachable, then grant only
-- service_role. The route is the sole caller and uses the service-role client.
revoke all on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) from public;
revoke execute on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) from anon, authenticated;
grant  execute on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) to service_role;

comment on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) is
  'GDPR Art.17 erasure primitive: single-transaction, service_role-only, '
  'confirmation-token-gated. Anonymises statutory-retention records in place '
  '(PII columns scrubbed, statutory figures kept) and hard-deletes everything '
  'else for one org, writing gdpr_erasure_log. Fail-closed (any surprise rolls '
  'back) and idempotent. Classification passed in by the caller; validated here. '
  'Storage bytes cleaned separately via the Storage API.';
