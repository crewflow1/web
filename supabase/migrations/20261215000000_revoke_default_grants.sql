-- Security wave A.6 — default-grant least-privilege on service-role-only tables.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- FINDING. Supabase runs `alter default privileges in schema public grant all on
-- tables to anon, authenticated` at project setup, so EVERY public table is
-- created carrying INSERT/UPDATE/DELETE/SELECT/TRUNCATE/REFERENCES/TRIGGER for
-- both client roles. On a table that is meant to be SERVICE-ROLE-ONLY this is a
-- latent grant: today it is inert ONLY because the table's RLS has no permissive
-- policy (RLS denies the row), but the grant sits underneath waiting for a
-- future permissive policy — or any non-PostgREST path — to expose it. TRUNCATE
-- is worse still: TRUNCATE is NOT gated by RLS at all, only by the privilege, so
-- a client role holding TRUNCATE could wipe an entire service-role-only table
-- regardless of policies if it ever reached a TRUNCATE-capable path.
--
-- FIX. For each table PROVEN service-role-only, revoke the client grants it
-- should never have. This is defence-in-depth: it does not change today's
-- behaviour (RLS already denies), it removes the latent exposure and makes a
-- future accidental "add a permissive policy" migration fail-safe rather than
-- fail-open.
--
-- ── HOW THE TARGET LIST WAS PROVEN (not a schema-wide shotgun) ────────────────
-- Every target below was verified against the LIVE catalogue to be a public,
-- RLS-enabled table with ZERO row-level policies — i.e. no client (anon /
-- authenticated) can read or write it through any RLS-gated path; the app
-- touches it exclusively through the service-role admin client. A table with
-- zero policies provably has no legitimate client access to break, so revoking
-- its client grants is safe by construction. Tables that DO carry a client
-- policy (they legitimately need authenticated access via RLS) are deliberately
-- left ALONE — e.g. webhook_endpoints (authenticated INSERT policy) and
-- webhook_deliveries (member SELECT policy) are NOT touched.
--
-- The one exception to "revoke all" is public.activity_log, which carries a
-- member SELECT policy (its feed is read by tenants) but NO write policy: there
-- the client SELECT is legitimate and kept, and only the write/truncate grants
-- are stripped. (activity_log is also the A.5 append-only table; A.5 blocks the
-- writes at trigger level, A.6 removes the underlying grant — belt and braces.)
--
-- SCOPE NOTE. The live catalogue holds ~100 zero-policy RLS tables; this
-- migration deliberately covers the FINDING's proven, high-sensitivity classes
-- — impersonation, the audit/accountability trail, and inbound-webhook
-- ingestion (untrusted external payloads land here, service-role-only) — rather
-- than sweeping every zero-policy table in one pass. A broader least-privilege
-- sweep of the remaining zero-policy and SELECT-only-policy tables is a
-- follow-up that wants per-table write-path verification; it is intentionally
-- NOT bundled here.
--
-- Additive/idempotent: REVOKE of an absent privilege is a no-op, so re-applying
-- is safe. No RLS change, no schema/data change. Rollback (not recommended):
-- `grant all on <table> to anon, authenticated` — but that re-opens the latent
-- exposure, so don't.

-- ─────────────────────────────────────────────────────────────────────────────
-- IMPERSONATION — super-admin impersonation session grants. Service-role-only
-- (0 policies); a client write here would forge/extend an impersonation.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on public.impersonation_sessions from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- HQ ADMIN AUDIT TRAIL — admin_activity_log (0 policies): the append-only record
-- of super-admin actions, written/read only via the service-role admin client
-- (server/services/hq-audit.ts). No client should hold any grant on it.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on public.admin_activity_log from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- TENANT ACTIVITY FEED — activity_log (member SELECT policy, no write policy).
-- The feed is read by org members via RLS, so authenticated legitimately needs
-- SELECT — and ONLY select. Strip everything from both client roles, then
-- re-grant exactly authenticated SELECT. (revoke-all-then-grant rather than
-- naming verbs, so this stays portable across Postgres versions — e.g. PG17's
-- MAINTAIN privilege is removed without being named.) Complements the A.5
-- append-only triggers, which block the writes at trigger level too.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- INBOUND WEBHOOK INGESTION — untrusted external payloads (email + WhatsApp)
-- are received and stored by service-role webhook handlers only (0 policies).
-- A client grant here would let a future policy expose raw webhook ingestion.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on public.email_webhook_events    from anon, authenticated;
revoke all privileges on public.whatsapp_webhook_events from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- AI RECEPTIONIST — the inbound-call/conversation read-and-write model. Every
-- one of these is a service-role-only processing table (0 policies): the
-- receptionist engine reads/writes them through the admin client; tenants never
-- touch them directly. Revoke all client grants across the family.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on public.receptionist_conversations                     from anon, authenticated;
revoke all privileges on public.receptionist_messages                          from anon, authenticated;
revoke all privileges on public.receptionist_conversation_actions              from anon, authenticated;
revoke all privileges on public.receptionist_conversation_authorisations       from anon, authenticated;
revoke all privileges on public.receptionist_conversation_claim_reassignments  from anon, authenticated;
revoke all privileges on public.receptionist_conversation_claim_releases       from anon, authenticated;
revoke all privileges on public.receptionist_conversation_claims               from anon, authenticated;
revoke all privileges on public.receptionist_conversation_coordinations        from anon, authenticated;
revoke all privileges on public.receptionist_conversation_executions           from anon, authenticated;
revoke all privileges on public.receptionist_conversation_fulfilments          from anon, authenticated;
revoke all privileges on public.receptionist_conversation_lifecycles           from anon, authenticated;
revoke all privileges on public.receptionist_conversation_orchestrations       from anon, authenticated;
revoke all privileges on public.receptionist_conversation_outcomes             from anon, authenticated;
revoke all privileges on public.receptionist_conversation_recoveries           from anon, authenticated;
revoke all privileges on public.receptionist_conversation_resolutions          from anon, authenticated;
revoke all privileges on public.receptionist_conversation_verifications        from anon, authenticated;
revoke all privileges on public.receptionist_review_resolutions                from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- GUARD INTROSPECTION RPC — lets the A.6 regression test read the LIVE client
-- grants so a future migration cannot silently re-grant a client role write
-- access to these tables without CI catching it.
-- ═════════════════════════════════════════════════════════════════════════════
-- Mirrors public._introspect_bare_cross_tenant_fks (20261113): reads ONLY the
-- system catalogue — no tenant data — exposed via PostgREST RPC and granted to
-- service_role ONLY (which already reads the whole catalogue, so this adds no
-- exposure). NOT granted to anon/authenticated. Returns, for the requested
-- tables, every privilege held by anon or authenticated.
--
-- It reads pg_class.relacl via aclexplode (NOT information_schema.role_table_
-- grants), on purpose: role_table_grants is FILTERED to grants involving roles
-- the current user is a member of, so `security invoker` running as service_role
-- would not reliably see anon/authenticated grants. pg_class.relacl is
-- membership-independent and world-readable, so the audit sees the true ACL.
-- A NULL relacl (no explicit grants) expands to no rows — correctly reported as
-- "no client grant".
create or replace function public._introspect_client_table_grants(p_tables text[])
returns table (table_name text, grantee text, privilege_type text)
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select c.relname::text, r.rolname::text, a.privilege_type::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join lateral aclexplode(c.relacl) a
  join pg_roles r on r.oid = a.grantee
  where c.relkind = 'r'
    and c.relname = any (p_tables)
    and r.rolname in ('anon', 'authenticated')
  order by c.relname, r.rolname, a.privilege_type;
$$;

revoke all on function public._introspect_client_table_grants(text[]) from public;
revoke execute on function public._introspect_client_table_grants(text[]) from anon, authenticated;
grant execute on function public._introspect_client_table_grants(text[]) to service_role;

comment on function public._introspect_client_table_grants(text[]) is
  'A.6 least-privilege self-audit: lists the client (anon/authenticated) table '
  'privileges on the named public tables. Catalogue-only, service_role-only. '
  'Used by the grant-regression guard test.';
