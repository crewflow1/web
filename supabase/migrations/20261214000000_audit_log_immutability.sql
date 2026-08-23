-- Security wave A.5 — audit-log immutability (append-only DB enforcement).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- FINDING. public.activity_log (per-tenant feed) and public.admin_activity_log
-- (HQ super-admin trail) are protected from TENANTS by RLS-with-no-write-policy:
-- a member/anon caller can neither insert, update nor delete a row (RLS denies,
-- the SECURITY DEFINER trigger writers are the only inserters). But service_role
-- BYPASSES RLS, so a leaked service key — or a buggy/hostile server code path —
-- could silently UPDATE or DELETE recorded audit rows to rewrite or erase
-- history. There was no DB-level append-only enforcement. This migration adds it.
--
-- ── THE HOUSE IDIOM WE MIRROR ────────────────────────────────────────────────
-- public.ai_invocations (20261062) is the same category of object: an
-- append-only, org-scoped, erasure-classified ("anonymise") ledger. Its
-- immutability trigger is the pattern this migration follows deliberately:
--   * a BEFORE UPDATE guard that RAISES for EVERY role incl. service_role,
--     EXCEPT one NARROW, SHAPE-CHECKED hole that is an *erasure* path, not an
--     edit (there it is user_id→null; here it is the GDPR PII scrub);
--   * DELETE treated as an erasure/teardown concern — see the per-table notes,
--     because activity_log and admin_activity_log differ on whether any
--     legitimate DELETE path exists at all.
--
-- ── THE TWO SANCTIONED WRITE PATHS WE PROVED, AND MUST NOT BREAK ─────────────
-- Enumerated from the codebase + migration history + live catalogue:
--
--   1. GDPR erasure (public.gdpr_erase_org, 20261169) ANONYMISES activity_log.
--      activity_log is in erasure_anonymise (lib/gdpr/org-tables.json): the row
--      is KEPT and PII-named columns are scrubbed. Concretely it runs, with the
--      org still present:
--        update activity_log set actor_name='[erased]', metadata='null'::jsonb
--        where org_id = <org>;
--      (admin_activity_log is NOT org-scoped and is absent from the GDPR census,
--      so gdpr_erase_org never touches it.)
--
--   2. Retention (public.purge_activity_log, 20260710) DELETEs aged activity_log
--      rows in batches. It is DARK (opt-in, unscheduled; the newer
--      retention_purge_run in 20261184 explicitly EXCLUDES activity_log), but it
--      exists and an operator may run it, so it must keep working. It is
--      re-created below to raise a transaction-local maintenance marker the
--      DELETE guard honours (the exact set_config(..., true) idiom used by the
--      stock write-path guards in 20261071 — 'crewflow.stock_write').
--
--   3. Tenant teardown: `delete from organizations` cascades to activity_log via
--      its org_id FK (on delete cascade). The cascade removes the org row FIRST,
--      then deletes the children — so at child-delete time the org is already
--      gone. The DELETE guard allows exactly this ("org no longer exists"),
--      mirroring the org-existence check the cascade fix already relies on in
--      _record_activity (20261052). No marker is possible on a cascade, so this
--      is a distinct, structurally-detected exception.
--
--   4. admin_activity_log has NO legitimate DELETE path (not org-scoped → no
--      org cascade; no retention; no code deletes it). Its only non-INSERT write
--      is actor_id→null via `actor_id references users(id) on delete set null`
--      when a user is hard-deleted (Postgres implements set-null as an UPDATE).
--      So its DELETE guard blocks EVERYONE incl. service_role, and its UPDATE
--      guard allows only the actor_id→null erasure shape (ai_invocations idiom).
--
-- ── SECURITY EFFECT (and its honest limit) ───────────────────────────────────
-- These triggers make both tables APPEND-ONLY for all CLIENT roles (anon /
-- authenticated) and block accidental or buggy service-role UPDATE / DELETE /
-- TRUNCATE and any silent history-rewrite:
--   activity_log:        UPDATE is refused for every role except the exact GDPR
--                        PII scrub (event facts always frozen); DELETE of a LIVE
--                        tenant's rows is refused for every role — only the
--                        org-cascade teardown and the sanctioned retention
--                        primitive delete; TRUNCATE is refused outright.
--   admin_activity_log:  UPDATE is refused except the actor_id→null user erasure;
--                        DELETE is refused (marker-gated for a future sanctioned
--                        primitive); TRUNCATE is refused outright.
--
-- LIMIT — this is NOT tamper-proof against the service-role KEY. A holder of the
-- service-role key retains ultimate DB power: it can ALTER/DISABLE these triggers
-- (or DROP them) and then mutate the tables freely. The triggers raise the bar
-- from "one silent statement rewrites history" to "history cannot be altered
-- without first, conspicuously, disabling an append-only guard" — a strong
-- integrity control against accident, bugs, compromised app code paths, and
-- client roles, but protection of the service-role key remains the OUTER control.
--
-- Additive/idempotent: functions via CREATE OR REPLACE, triggers dropped-then-
-- created. No RLS change, no grant change, no schema/data change. INSERT paths
-- are untouched. Rollback: drop the six triggers + five trigger functions, and
-- re-apply purge_activity_log from 20260710 (its contract is unchanged here).

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. activity_log — UPDATE guard (event facts immutable; PII scrub permitted)
-- ═════════════════════════════════════════════════════════════════════════════
-- The ONLY UPDATE this table accepts is the exact GDPR PII scrub that
-- gdpr_erase_org (20261169) issues for an anonymise-classified table. Verified
-- against that function: activity_log's only PII-named columns are actor_name
-- (text → the '[erased]' sentinel) and metadata (jsonb → 'null'::jsonb), and it
-- has NO nullable FK to a hard-delete table, so no FK-detach assignment is added
-- — i.e. the literal statement is
--   update activity_log set actor_name='[erased]', metadata='null'::jsonb where org_id=…
-- (actor_id is NOT scrubbed, so it stays unchanged; we ALSO defensively allow
-- actor_id→null in case the classifier ever widens). Everything else is refused,
-- for EVERY role incl. service_role: an event-fact edit, an actor_id repoint to a
-- different non-null user, an arbitrary metadata or actor_name rewrite. The check
-- is a null-safe whole-row comparison against the permitted post-scrub shape,
-- mirroring the admin_activity_log erasure guard below and the ai_invocations
-- idiom (shape-checked, not caller-checked).
create or replace function public.tg_activity_log_append_only_update()
returns trigger language plpgsql
set search_path = public as $$
declare
  v_scrub public.activity_log%rowtype;
begin
  -- Permitted shape 1: the exact gdpr_erase_org scrub (actor_id unchanged).
  v_scrub := old;
  v_scrub.actor_name := '[erased]';
  v_scrub.metadata   := 'null'::jsonb;
  if new is not distinct from v_scrub then
    return new;
  end if;
  -- Permitted shape 2: same scrub, actor_id additionally nulled (defensive).
  v_scrub.actor_id := null;
  if new is not distinct from v_scrub then
    return new;
  end if;
  raise exception 'activity_log is append-only: only the GDPR PII scrub (actor_name=''[erased]'', metadata=''null''::jsonb, event facts unchanged) may update a row; all other edits are refused (row %)', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists activity_log_append_only_update on public.activity_log;
create trigger activity_log_append_only_update
  before update on public.activity_log
  for each row execute function public.tg_activity_log_append_only_update();

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. activity_log — DELETE guard (only org-cascade teardown or sanctioned purge)
-- ═════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER so the organizations existence probe is reliable regardless
-- of the caller's RLS (mirrors _record_activity, 20261052). The marker check is
-- first so the batched retention purge pays no per-row catalogue lookup.
--   * marker set        → sanctioned retention (purge_activity_log). Allow.
--   * org row absent     → this delete is the org-cascade teardown firing after
--                          `delete from organizations`. Allow.
--   * otherwise          → a live tenant's audit row is being deleted directly.
--                          Refuse, service_role included.
create or replace function public.tg_activity_log_append_only_delete()
returns trigger language plpgsql
security definer
set search_path = public as $$
begin
  if coalesce(current_setting('crewflow.audit_maintenance', true), '') = 'on' then
    return old; -- sanctioned retention purge (marker raised by purge_activity_log)
  end if;
  if not exists (select 1 from public.organizations where id = old.org_id) then
    return old; -- org-cascade teardown (org row already removed by the cascade)
  end if;
  raise exception 'activity_log is append-only: deleting a live org''s audit rows is not permitted (row %)', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists activity_log_append_only_delete on public.activity_log;
create trigger activity_log_append_only_delete
  before delete on public.activity_log
  for each row execute function public.tg_activity_log_append_only_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2a. Re-create purge_activity_log to raise the sanctioned maintenance marker.
-- ─────────────────────────────────────────────────────────────────────────────
-- Byte-for-byte the 20260710 definition (same signature, same batched-delete
-- contract, same service-role lock re-asserted below) with ONE addition: it sets
-- the transaction-local 'crewflow.audit_maintenance' marker around its deletes
-- so the DELETE guard above recognises it as the sanctioned retention path. The
-- marker is transaction-local (set_config third arg = true) so it cannot leak
-- to another statement or session; it is cleared again before return. This is
-- the ONLY code that may bulk-delete activity_log, and it stays service_role-
-- only. (This re-creation is confined to this migration file; 20260710 is not
-- edited. Its ops guard test reads the 20260710 file text and is unaffected.)
create or replace function public.purge_activity_log(
  p_retention interval default interval '24 months',
  p_batch     integer  default 5000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff  timestamptz := now() - p_retention;
  v_deleted integer := 0;
  v_chunk   integer;
begin
  if p_batch is null or p_batch <= 0 then
    raise exception 'purge_activity_log: p_batch must be a positive integer (got %)', p_batch
      using errcode = '22023';
  end if;
  if p_retention is null or p_retention < interval '0' then
    raise exception 'purge_activity_log: p_retention must be a non-negative interval (got %)', p_retention
      using errcode = '22023';
  end if;

  -- Raise the sanctioned-maintenance marker so the append-only DELETE guard
  -- permits these aged-row deletions (and only these).
  perform set_config('crewflow.audit_maintenance', 'on', true);

  -- Batched delete: each pass removes the oldest <= p_batch rows past the
  -- cutoff and stops as soon as a pass deletes nothing.
  loop
    delete from public.activity_log
    where id in (
      select id
      from public.activity_log
      where created_at < v_cutoff
      order by created_at
      limit p_batch
    );
    get diagnostics v_chunk = row_count;
    v_deleted := v_deleted + v_chunk;
    exit when v_chunk = 0;
  end loop;

  -- Lower the marker again (transaction-local; would clear at commit regardless).
  perform set_config('crewflow.audit_maintenance', '', true);

  return v_deleted;
end;
$$;

-- Re-assert the service-role-only lock from 20260710 (idempotent).
revoke execute on function public.purge_activity_log(interval, integer)
  from public, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. admin_activity_log — UPDATE guard (only actor_id→null erasure permitted)
-- ═════════════════════════════════════════════════════════════════════════════
-- The single legitimate UPDATE is the FK's own `on delete set null` firing when
-- a user is hard-deleted: actor_id goes from a value to null and every other
-- column is byte-identical. This is the ai_invocations idiom verbatim. Anything
-- else — an edited action/target, a re-pointed actor, a rewritten metadata — is
-- refused for every role incl. service_role. (actor_email is denormalised and
-- intentionally survives user deletion, per the table's own design note, so it
-- must stay unchanged here too.)
create or replace function public.tg_admin_activity_log_append_only_update()
returns trigger language plpgsql
set search_path = public as $$
declare
  v_anonymised public.admin_activity_log%rowtype;
begin
  if old.actor_id is not null and new.actor_id is null then
    v_anonymised := old;
    v_anonymised.actor_id := null;
    -- IS NOT DISTINCT FROM: row equality across a NULL column yields NULL, which
    -- `if` treats as "not equal" — that would refuse every legitimate erasure of
    -- a row holding a null column. Use null-safe equality.
    if new is not distinct from v_anonymised then
      return new;
    end if;
  end if;
  raise exception 'admin_activity_log is append-only: rows are immutable (only actor_id may be nulled by user erasure) (row %)', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists admin_activity_log_append_only_update on public.admin_activity_log;
create trigger admin_activity_log_append_only_update
  before update on public.admin_activity_log
  for each row execute function public.tg_admin_activity_log_append_only_update();

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. admin_activity_log — DELETE guard (blocked unless a sanctioned marker set)
-- ═════════════════════════════════════════════════════════════════════════════
-- admin_activity_log is not org-scoped (no org cascade reaches it), has no
-- retention primitive, and nothing in production code or migrations deletes it —
-- so today every DELETE is refused, service_role included. The check mirrors the
-- activity_log DELETE guard's sanctioned-marker mechanism (crewflow.audit_
-- maintenance) so that IF a sanctioned admin-audit retention primitive is ever
-- added, it can opt in by raising the marker exactly as purge_activity_log does
-- — rather than someone having to weaken this trigger. No such primitive exists
-- yet, so the effective posture is: append-only, deletion refused for all roles.
--
-- NOTE (test harness): several receptionist integration tests delete this table
-- in an UNASSERTED afterAll to tidy the shared DB (it has no org FK, so an org
-- delete cannot cascade it away). Those hygiene deletes now no-op — their error
-- is ignored, the tests do not assert on it, and the un-deleted rows are scoped
-- by metadata->>org_id to the test's own org, so they cannot collide with any
-- other test. Production keeps a complete, tamper-proof HQ audit trail.
create or replace function public.tg_admin_activity_log_append_only_delete()
returns trigger language plpgsql
set search_path = public as $$
begin
  if coalesce(current_setting('crewflow.audit_maintenance', true), '') = 'on' then
    return old; -- reserved for a future sanctioned admin-audit retention primitive
  end if;
  raise exception 'admin_activity_log is append-only: deletion is not permitted (row %)', old.id
    using errcode = 'check_violation';
end $$;

drop trigger if exists admin_activity_log_append_only_delete on public.admin_activity_log;
create trigger admin_activity_log_append_only_delete
  before delete on public.admin_activity_log
  for each row execute function public.tg_admin_activity_log_append_only_delete();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. TRUNCATE guard — append-only ⇒ never truncatable (BOTH tables)
-- ═════════════════════════════════════════════════════════════════════════════
-- The BEFORE UPDATE/DELETE guards above are ROW triggers; they do NOT fire on
-- TRUNCATE, and service_role keeps the default TRUNCATE privilege — so a single
-- `truncate activity_log` / `truncate admin_activity_log` would erase the whole
-- trail untriggered (and TRUNCATE is not gated by RLS at all). Close that with a
-- STATEMENT-level BEFORE TRUNCATE trigger that RAISES unconditionally. Nothing
-- legitimate truncates these tables: retention deletes (purge_activity_log uses
-- DELETE), and GDPR/erasure + org teardown use UPDATE/DELETE — grep confirms no
-- TRUNCATE of either table anywhere in code, migrations or tests. One shared
-- function (tg_table_name distinguishes the table in the message).
create or replace function public.tg_audit_log_no_truncate()
returns trigger language plpgsql
set search_path = public as $$
begin
  raise exception '% is append-only: TRUNCATE is not permitted', tg_table_name
    using errcode = 'check_violation';
end $$;

drop trigger if exists activity_log_no_truncate on public.activity_log;
create trigger activity_log_no_truncate
  before truncate on public.activity_log
  for each statement execute function public.tg_audit_log_no_truncate();

drop trigger if exists admin_activity_log_no_truncate on public.admin_activity_log;
create trigger admin_activity_log_no_truncate
  before truncate on public.admin_activity_log
  for each statement execute function public.tg_audit_log_no_truncate();
