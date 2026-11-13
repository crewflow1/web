-- Least-privilege grant revoke (launch-readiness audit — identity P2).
--
-- The tenant-BOUNDARY tables memberships / organizations / users carried
-- INSERT/UPDATE/DELETE/TRUNCATE to anon AND authenticated, yet have SELECT-only RLS
-- (no write policy = default-deny). Every write flows via the service-role admin client
-- (BYPASSRLS), so these write grants are DEAD — and these are the highest-value tables
-- to keep at least privilege (org membership IS the tenant boundary). We revoke the dead
-- writes and KEEP SELECT, which the RLS read policies depend on (and anon SELECT on
-- organizations is retained for /api/health).
--
-- Scope note: this migration deliberately touches ONLY these three boundary tables. The
-- service-role-oriented tables (internal_notes, portal_uploads, tenant_search_documents,
-- receptionist_conversation_*) intentionally KEEP authenticated SELECT — they are the
-- ORG_EXPORT_TABLES that GDPR export + retention snapshots read as authenticated, pinned
-- by __tests__/integration/rls/slice15-pr2-cclass-least-privilege.test.ts — so they are
-- NOT revoked here.
--
-- NO FUNCTIONAL IMPACT: all writes use the service-role client; the grants removed here
-- are unreachable under RLS today. Guarded against regression by
-- __tests__/integration/rls/least-privilege-grants.test.ts.
-- data-api:exempt: this migration only REVOKES; it widens no client surface.
--
-- Rollback (manual, not recommended): re-GRANT the specific privileges below.

revoke insert, update, delete, truncate on public.memberships   from anon, authenticated;
revoke insert, update, delete, truncate on public.organizations from anon, authenticated;
revoke insert, update, delete, truncate on public.users         from anon, authenticated;
