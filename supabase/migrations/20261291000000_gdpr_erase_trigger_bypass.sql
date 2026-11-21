-- GDPR RIGHT-TO-ERASURE (Art. 17) — make the erasure primitive able to ACTUALLY
-- erase append-only / immutable tenant data, and FAIL CLOSED instead of silently
-- destroying statutory records.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- WHY THIS MIGRATION EXISTS (two reproduced defects in public.gdpr_erase_org).
-- ═════════════════════════════════════════════════════════════════════════════
-- The erasure primitive shipped in 20261169000000 was never exercised end-to-end
-- against realistic tenant data (the only tests were hermetic list-algebra). Two
-- defects were found that make it UNSAFE / NON-FUNCTIONAL the moment it touches a
-- real org:
--
--   DEFECT 1 — UNDELETABLE PERSONAL DATA (append-only guards block the erasure).
--   ~40 org-scoped tables carry BEFORE UPDATE / BEFORE DELETE "append-only" or
--   "immutable" triggers that RAISE for EVERY role incl. service_role (e.g.
--   ai_reply_audits_block_mutation, the receptionist_conversation_*_block_mutation
--   family, the cis_* / goods_received / supplier_payment / quote_versions /
--   stock_movements / tenant_attachment evidence freezes). The erasure ANONYMISE
--   step issues an UPDATE on statutory tables and the HARD-DELETE step issues a
--   DELETE; both hit these guards, which raise `restrict_violation`. That error is
--   NOT `foreign_key_violation`, so it is not caught by the topological loop — it
--   propagates and rolls the WHOLE transaction back. Net effect: once an org has a
--   single AI-reply audit (or any append-only row), its personal data can NEVER be
--   erased. Reproduced: `gdpr_erase_org` → "ai_reply_audits is append-only; UPDATE
--   is not permitted" (SQLSTATE 23001). This is the recurring "undeletable personal
--   data" defect class.
--
--   DEFECT 2 — STATUTORY RECORDS SILENTLY CASCADE-DESTROYED. Six FK constraints
--   from ANONYMISE (statutory keep-and-scrub) tables into HARD-DELETE parents are
--   ON DELETE CASCADE with ALL columns NOT NULL, so the existing nullable-FK detach
--   (20261169) cannot neutralise them:
--       job_billing_plans.job_id          → jobs
--       job_billing_stages.job_id         → jobs
--       job_valuations(org_id,job_id)      → jobs
--       job_valuation_variations(org_id,variation_quote_id) → quotes
--       retention_releases.job_id          → jobs
--       hmrc_submissions(org_id,connection_id) → hmrc_connections
--   When the hard-delete step removes jobs / quotes / hmrc_connections, the CASCADE
--   DELETES the (already-scrubbed) statutory children the classification promised to
--   RETAIN (Companies Act s386 / HMRC 6y). That is a silent statutory-retention
--   breach — the opposite failure to Defect 1.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FIX (self-contained; no schema change to tenant tables; DARK feature stays
-- dark — FEATURE_GDPR_ERASURE gates the only caller).
-- ─────────────────────────────────────────────────────────────────────────────
--  • Defect 1: inside the SECURITY DEFINER function (owned by `postgres`, which owns
--    every tenant table), transactionally `ALTER TABLE … DISABLE TRIGGER USER` on
--    the exact set of tables being erased, do the scrub + delete, then re-ENABLE.
--    This is SELF-MAINTAINING — a future append-only table added to the census is
--    covered automatically, so this defect class cannot silently recur. It is
--    transaction-local: on any rollback the DISABLE is reverted; the ACCESS
--    EXCLUSIVE locks are acceptable for a teardown. It disables only USER triggers,
--    NOT the system FK triggers, so FK CASCADE/RESTRICT still fire and the existing
--    topological delete loop still orders the deletes correctly. `session_replication_role`
--    (the usual bulk-bypass) is unavailable here — Supabase forbids setting it, even
--    inside a definer function owned by postgres (verified: "permission denied to set
--    parameter session_replication_role"), so DISABLE TRIGGER USER is the mechanism.
--
--  • Defect 2: a FAIL-CLOSED guard runs BEFORE any write. It detects any ON DELETE
--    CASCADE FK from an anonymise/retain (keep) table into a hard-delete table whose
--    columns are all NOT NULL (so the nullable-FK detach cannot save it) AND where
--    the keep-table actually holds rows for THIS org. If found, it RAISES and nothing
--    is destroyed — turning a silent statutory-data-loss bug into a safe, loud,
--    auditable refusal. (Fully RESUMING erasure for such orgs needs those six FK
--    columns made nullable — so the existing detach neutralises them per the
--    documented 20261169 intent — or a reclassification of `jobs`/`quotes`; that is a
--    schema + app-type change left for founder/DPO review. Until then the guard keeps
--    the function compliant-by-refusal rather than compliant-by-destruction.)
--
-- Additive and reversible: re-apply 20261169000000's definition to roll back.

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
  c_pii_rx constant text :=
    '(^|_)(name|full_name|first_name|last_name|forename|surname|maiden|' ||
    'email|phone|mobile|tel|fax|address|street|postcode|post_code|zip|city|town|' ||
    'dob|date_of_birth|national_insurance|ni_number|passport|utr|' ||
    'verification_reference|signature|signatory|ip_address|user_agent|' ||
    'latitude|longitude|geo|note|notes|description|message|body|subject|content|' ||
    'comment|reason|payload|metadata|recipient|sender|attendee|guest|nickname|' ||
    'username|avatar|photo|token|secret|password|credential)($|_)';
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
  v_retain_exist  text[];
  v_keep_exist    text[];
  v_remaining     text[];
  v_next          text[];
  v_progress      boolean;
  v_pass          integer := 0;
  v_rc            integer;
  v_anon_rows     integer := 0;
  v_anon_tables   integer := 0;
  v_del_rows      integer := 0;
  v_del_tables    integer := 0;
  -- Defect-2 guard working vars.
  v_child         text;
  v_parent        text;
  v_conname       text;
  v_child_rows    integer;
  v_parent_rows   integer;
  v_offenders     text[] := '{}';
begin
  -- ── a. AUTHZ ────────────────────────────────────────────────────────────────
  if auth.role() is distinct from 'service_role' then
    raise exception 'gdpr_erase_org: service_role only' using errcode = '42501';
  end if;

  select slug into v_slug from public.organizations where id = p_org_id;
  if v_slug is null then
    raise exception 'gdpr_erase_org: org % not found', p_org_id using errcode = 'no_data_found';
  end if;

  -- ── CONFIRMATION TOKEN (anti-misfire) ───────────────────────────────────────
  if p_confirm is null or btrim(p_confirm) = '' or p_confirm <> v_slug then
    raise exception 'gdpr_erase_org: confirmation token does not match org slug — refusing'
      using errcode = 'check_violation';
  end if;

  -- ── DISJOINTNESS ────────────────────────────────────────────────────────────
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
  select coalesce(array_agg(t), '{}') into v_anon_exist
    from unnest(coalesce(p_anonymise, '{}')) t
    where to_regclass('public.' || quote_ident(t)) is not null;
  select coalesce(array_agg(t), '{}') into v_del_exist
    from unnest(coalesce(p_hard_delete, '{}')) t
    where to_regclass('public.' || quote_ident(t)) is not null;
  select coalesce(array_agg(t), '{}') into v_retain_exist
    from unnest(coalesce(p_retain, '{}')) t
    where to_regclass('public.' || quote_ident(t)) is not null;
  -- The "keep" universe (never hard-deleted): anonymise + retain.
  v_keep_exist := v_anon_exist || v_retain_exist;

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

  -- ── DEFECT-2 GUARD: never CASCADE-destroy a retained statutory record ─────────
  -- An ON DELETE CASCADE FK from a KEEP table (anonymise/retain) into a HARD-DELETE
  -- table, whose columns are ALL NOT NULL (so the nullable-FK detach below cannot
  -- neutralise it), means deleting the parent would silently destroy a statutory
  -- child. If such a relationship exists AND the keep-table holds rows for THIS org
  -- (i.e. there is actually something to lose), FAIL CLOSED before touching a row.
  for v_child, v_parent, v_conname in
    select rel.relname, frel.relname, c.conname
    from pg_constraint c
    join pg_class rel  on rel.oid  = c.conrelid
    join pg_class frel on frel.oid = c.confrelid
    where c.contype = 'f'
      and c.confdeltype = 'c'                          -- ON DELETE CASCADE
      and rel.relnamespace = 'public'::regnamespace
      and rel.relname = any (v_keep_exist)
      and frel.relname = any (v_del_exist)
      and not exists (                                 -- every FK column is NOT NULL
        select 1 from pg_attribute a
        where a.attrelid = c.conrelid and a.attnum = any (c.conkey) and a.attnotnull = false
      )
  loop
    execute format('select count(*) from public.%I where org_id = $1', v_child)
      into v_child_rows using p_org_id;
    execute format('select count(*) from public.%I where org_id = $1', v_parent)
      into v_parent_rows using p_org_id;
    if v_child_rows > 0 and v_parent_rows > 0 then
      v_offenders := array_append(
        v_offenders,
        format('%s rows in "%s" would be destroyed by CASCADE from "%s" (%s)',
               v_child_rows, v_child, v_parent, v_conname));
    end if;
  end loop;
  if array_length(v_offenders, 1) is not null then
    raise exception 'gdpr_erase_org: refusing — erasure would CASCADE-destroy statutory records that must be RETAINED: %. Make these FK columns nullable (so the detach neutralises them) or reclassify the parent before erasing this org — NOTHING committed.',
      array_to_string(v_offenders, '; ')
      using errcode = 'raise_exception';
  end if;

  -- ── DEFECT-1 FIX: suppress USER triggers (append-only / immutable guards) on the
  -- exact set of tables being scrubbed/deleted. System FK triggers are UNAFFECTED,
  -- so CASCADE/RESTRICT still fire and the topological loop below still works.
  -- Transaction-local: any rollback reverts these DDLs.
  foreach v_tbl in array (v_anon_exist || v_del_exist) loop
    execute format('alter table public.%I disable trigger user', v_tbl);
  end loop;

  -- ── b. ANONYMISE (+ FK-detach) ──────────────────────────────────────────────
  foreach v_tbl in array v_anon_exist loop
    v_assign  := '{}';
    v_handled := '{}';

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
        continue;
      end if;
      v_handled := array_append(v_handled, v_col);
    end loop;

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
        v_next := array_append(v_next, v_tbl);
      end;
    end loop;

    exit when array_length(v_next, 1) is null;
    if not v_progress then
      raise exception 'gdpr_erase_org: hard-delete did not converge; blocked by FK: % — NOTHING committed', v_next
        using errcode = 'raise_exception';
    end if;
    v_remaining := v_next;
  end loop;

  -- ── Re-enable the USER triggers suppressed above (belt-and-braces; a rollback
  -- would revert the DISABLE regardless, but on the commit path we restore them so
  -- the append-only guards are live again the instant this transaction ends). The
  -- retained (anonymise) rows keep their guards for every future writer.
  foreach v_tbl in array (v_anon_exist || v_del_exist) loop
    if to_regclass('public.' || quote_ident(v_tbl)) is not null then
      execute format('alter table public.%I enable trigger user', v_tbl);
    end if;
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

-- ── PRIVILEGE LOCKDOWN (service_role only) — re-assert after CREATE OR REPLACE ──
-- CREATE OR REPLACE re-applies Supabase's default EXECUTE grant to anon +
-- authenticated; strip it again so this destructive function stays service_role-only.
revoke all     on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) from public;
revoke execute on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) from anon, authenticated;
grant  execute on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) to service_role;

comment on function public.gdpr_erase_org(uuid, text, text[], text[], text[], integer, uuid) is
  'GDPR Art.17 erasure primitive: single-transaction, service_role-only, '
  'confirmation-token-gated. Suppresses USER triggers (append-only/immutable guards) '
  'on the tables it erases via transaction-local DISABLE TRIGGER USER so personal '
  'data can never be undeletable; fails closed if a hard-delete would CASCADE-destroy '
  'a retained statutory record. Anonymises statutory-retention records in place and '
  'hard-deletes everything else for one org, writing gdpr_erasure_log. Classification '
  'passed in by the caller; validated here. Storage bytes cleaned via the Storage API.';
