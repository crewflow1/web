-- Schema self-audit RPC for the GDPR/DSAR export drift guard — the REVERSE
-- direction the guard was missing.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
-- The DSAR export (app/api/gdpr/export/route.ts) exports ORG_EXPORT_TABLES =
-- KNOWN minus EXCLUDED, where KNOWN (lib/gdpr/org-tables.json) is a
-- hand-maintained snapshot of every public BASE table carrying an `org_id`
-- column. Anything not in KNOWN is, by construction, never exported — the safe
-- default for an unclassified table, but ALSO a SILENT DROP: a newly-added
-- org-scoped table (potentially PII-bearing) is simply omitted from a STATUTORY
-- export with green CI.
--
-- The only live-schema check the guard had asserted the FORWARD direction only —
-- every KNOWN table exists live (catches a dropped/renamed table). It NEVER
-- asserted the REVERSE — every LIVE org-scoped table is in KNOWN — so
-- `accounting_pushed_entities` (this file's sibling era, mig 20261110000000)
-- shipped org-scoped, unclassified, and silently absent from every tenant DSAR
-- while CI stayed green. The list-algebra security test proves EXPORT ∪ EXCLUDED
-- = KNOWN but never touches Postgres, so no automated test asserted LIVE ⊆ KNOWN.
--
-- ── WHAT THIS IS ─────────────────────────────────────────────────────────────
-- A catalog-only introspection function returning every public BASE table
-- (relkind='r') that has an `org_id` column — i.e. the exact universe the KNOWN
-- snapshot is meant to mirror. It is the LIVE side of the bidirectional guard in
-- __tests__/integration/rls/gdpr-export.test.ts: the test asserts every row this
-- returns is a member of KNOWN, failing CI on any live org-scoped table that has
-- not been classified include/exclude. This is the SAME shape as
-- _introspect_bare_cross_tenant_fks (20261113000000) and
-- _introspect_secdef_org_rpcs (20261116000000): supabase-js cannot run arbitrary
-- SQL, so the DB-less test tiers cannot run this — it is service_role only.
--
-- VIEWS are excluded (relkind='r' only): the export reads base tables exclusively
-- (a definer-run view could bypass RLS), so the guard's universe is base tables,
-- matching the catalogue query documented in lib/gdpr/export-tables.ts.
--
-- Reads only the system catalog (pg_class / information_schema.columns) — NO
-- tenant data. Additive and reversible:
--   drop function public._introspect_org_scoped_tables();
create or replace function public._introspect_org_scoped_tables()
returns table (table_name text)
language sql
stable
security invoker
set search_path = pg_catalog, public, information_schema
as $$
  select c.relname::text as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and exists (
      select 1 from information_schema.columns col
      where col.table_schema = 'public'
        and col.table_name = c.relname
        and col.column_name = 'org_id'
    )
  order by c.relname;
$$;

-- ── PRIVILEGE LOCKDOWN (service_role only) ───────────────────────────────────
-- Supabase default privileges (ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON
-- FUNCTIONS TO anon, authenticated, service_role) grant role-specific EXECUTE to
-- anon + authenticated at CREATE time, and `revoke ... from public` does NOT
-- strip those — the exact defect 20261114000000 had to fix retroactively for
-- _introspect_bare_cross_tenant_fks. This new function includes the explicit
-- anon/authenticated revoke UP FRONT so it can never ship anon-reachable. The
-- pin in gdpr-export.test.ts asserts the boundary via the authoritative
-- execution path so a later CREATE OR REPLACE cannot silently re-expose it.
revoke all on function public._introspect_org_scoped_tables() from public;
revoke execute on function public._introspect_org_scoped_tables() from anon, authenticated;
grant execute on function public._introspect_org_scoped_tables() to service_role;

comment on function public._introspect_org_scoped_tables() is
  'Schema self-audit for the GDPR DSAR export drift guard (reverse direction): '
  'lists every public BASE table (relkind=r) with an org_id column — the universe '
  'KNOWN_ORG_SCOPED_TABLES must classify. Catalog-only, no tenant data; '
  'service_role only.';
