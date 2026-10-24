-- Slice 1.5 — PR 2 · C-class service/internal least-privilege hardening.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- CONTEXT. Supabase ran, at project setup, `alter default privileges in schema
-- public grant all on tables to anon, authenticated`. So every public table is
-- created carrying SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/
-- MAINTAIN for BOTH client roles — granted DIRECTLY to anon+authenticated, not
-- only via PUBLIC. On a table meant to be SERVICE-ROLE-ONLY (RLS enabled, ZERO
-- row-level policies) that is a latent over-grant: inert today only because RLS
-- denies the row, but waiting for a future permissive policy — or any non-
-- PostgREST path — to fail OPEN. TRUNCATE is worse: it is not gated by RLS at
-- all, only by the privilege.
--
-- A.6 (20261215000000) locked the highest-sensitivity classes (impersonation,
-- the admin audit trail, inbound-webhook ingestion + the receptionist model) and
-- explicitly deferred "a broader least-privilege sweep of the remaining zero-
-- policy and SELECT-only-policy tables … as a follow-up that wants per-table
-- write-path verification". Slice 1.5 PR 1 (20261231000000) closed the confirmed
-- client-reachable holes. THIS migration is that deferred broader sweep: the
-- C-class (service-role-only) remainder.
--
-- ── HOW THE TARGET LIST WAS PROVEN (fresh zero-based census, not an old list) ──
-- 1. CATALOGUE: every public relation (ordinary table `r` AND partitioned parent
--    `p`) that is RLS-enabled, has ZERO row-level policies, and still carries an
--    anon/authenticated grant → 102 relations.
-- 2. CALLER TRACE: every one of the 102 was traced to its real callers in the
--    app. `createClient()` (lib/supabase/server.ts) = user-JWT (anon/authenticated,
--    RLS + grants). `createAdminClient()` (lib/supabase/admin.ts) = service_role
--    (bypasses RLS + grants). Each table was classified by whether a *user-JWT*
--    code path legitimately reads it:
--      • 82 relations → touched EXCLUSIVELY by service_role (createAdminClient)
--        or have no app references at all → FULLY LOCKED here.
--      • 20 relations → a user-JWT path legitimately reads them → authenticated
--        SELECT KEPT (everything else revoked).
--    No table has ANY legitimate authenticated INSERT/UPDATE/DELETE path (the
--    writes are all service_role), so no client write grant is preserved anywhere.
--
-- This is defence-in-depth: it does not change today's behaviour (RLS already
-- denies client rows on every target; the kept SELECTs already returned zero
-- rows to non-members), it removes the latent exposure, and it makes a future
-- accidental "add a permissive policy" migration fail-SAFE instead of fail-open.
-- Additive/idempotent: REVOKE of an absent privilege is a no-op; re-applying is
-- safe. No RLS/policy change, no table schema change, no data change; the only
-- DDL beyond grants is a widen-only redefinition of the catalogue-only guard RPC
-- (bottom of file). service_role is NEVER touched — every internal/admin
-- workflow keeps full access.
--
-- Forward-fix (not a down-migration): a mistaken revoke surfaces as a legitimate
-- 42501; the inverse is the obvious `grant <priv> on <table> to <role>` in a new
-- one-line migration. No PITR needed — no row is ever touched.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- CLASS A — KEEP AUTHENTICATED SELECT (20). A user-JWT path legitimately READS
-- these; revoking SELECT would turn a working read into 42501. We revoke
-- everything else (all anon, and authenticated's write + non-SELECT verbs) and
-- re-grant ONLY authenticated SELECT — the minimum the real callers need.
--
--   • internal_notes, portal_uploads + the 17 receptionist_* tables are
--     ORG_EXPORT_TABLES (lib/gdpr/org-tables.json `known` MINUS `excluded`,
--     export-tables.ts), read by the GDPR/DSAR export loop through the
--     user-JWT SSR client (gdpr-export.ts:187,200 — its header deliberately
--     uses the user-JWT client, NOT service_role). Revoking authenticated
--     SELECT breaks the whole DSAR export with 42501 (readFailure throws).
--   • admin_alert_state is NOT GDPR-exported, but retention-snapshot.ts (user-JWT
--     client, :50) issues a live org-scoped head-count read of it (:160-164) on
--     the dashboard / AI-question path. Revoking authenticated SELECT would make
--     that read 42501 and reject the dashboard's Promise.all. SELECT kept.
--
--   The 17 receptionist_* tables previously carried anon+authenticated SELECT
--   (A.6 stripped only writes); here we additionally drop anon entirely and
--   authenticated's non-SELECT verbs — none of them has an anon reader (the
--   export uses the authenticated client), so this is strict least-privilege.
-- ─────────────────────────────────────────────────────────────────────────────
revoke all privileges on table public.admin_alert_state from anon, authenticated;
grant select on table public.admin_alert_state to authenticated;
revoke all privileges on table public.internal_notes from anon, authenticated;
grant select on table public.internal_notes to authenticated;
revoke all privileges on table public.portal_uploads from anon, authenticated;
grant select on table public.portal_uploads to authenticated;
revoke all privileges on table public.receptionist_conversation_actions from anon, authenticated;
grant select on table public.receptionist_conversation_actions to authenticated;
revoke all privileges on table public.receptionist_conversation_authorisations from anon, authenticated;
grant select on table public.receptionist_conversation_authorisations to authenticated;
revoke all privileges on table public.receptionist_conversation_claim_reassignments from anon, authenticated;
grant select on table public.receptionist_conversation_claim_reassignments to authenticated;
revoke all privileges on table public.receptionist_conversation_claim_releases from anon, authenticated;
grant select on table public.receptionist_conversation_claim_releases to authenticated;
revoke all privileges on table public.receptionist_conversation_claims from anon, authenticated;
grant select on table public.receptionist_conversation_claims to authenticated;
revoke all privileges on table public.receptionist_conversation_coordinations from anon, authenticated;
grant select on table public.receptionist_conversation_coordinations to authenticated;
revoke all privileges on table public.receptionist_conversation_executions from anon, authenticated;
grant select on table public.receptionist_conversation_executions to authenticated;
revoke all privileges on table public.receptionist_conversation_fulfilments from anon, authenticated;
grant select on table public.receptionist_conversation_fulfilments to authenticated;
revoke all privileges on table public.receptionist_conversation_lifecycles from anon, authenticated;
grant select on table public.receptionist_conversation_lifecycles to authenticated;
revoke all privileges on table public.receptionist_conversation_orchestrations from anon, authenticated;
grant select on table public.receptionist_conversation_orchestrations to authenticated;
revoke all privileges on table public.receptionist_conversation_outcomes from anon, authenticated;
grant select on table public.receptionist_conversation_outcomes to authenticated;
revoke all privileges on table public.receptionist_conversation_recoveries from anon, authenticated;
grant select on table public.receptionist_conversation_recoveries to authenticated;
revoke all privileges on table public.receptionist_conversation_resolutions from anon, authenticated;
grant select on table public.receptionist_conversation_resolutions to authenticated;
revoke all privileges on table public.receptionist_conversation_verifications from anon, authenticated;
grant select on table public.receptionist_conversation_verifications to authenticated;
revoke all privileges on table public.receptionist_conversations from anon, authenticated;
grant select on table public.receptionist_conversations to authenticated;
revoke all privileges on table public.receptionist_messages from anon, authenticated;
grant select on table public.receptionist_messages to authenticated;
revoke all privileges on table public.receptionist_review_resolutions from anon, authenticated;
grant select on table public.receptionist_review_resolutions to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- CLASS B — FULLY LOCKED (82 relations that hold a live client grant, plus every
-- current hq_events partition swept dynamically). No client reader of any kind:
-- every reference is createAdminClient (service_role), or the relation has no app
-- references at all. Revoke ALL client privileges from anon + authenticated.
-- ─────────────────────────────────────────────────────────────────────────────

-- HQ EVENT SPINE — partitioned table `hq_events` + its partitions. The internal
-- event log, written via the service-role spine consumer only; not in the GDPR
-- census; no user-JWT reader.
--
-- Revoking on the PARTITIONED PARENT denies client access through the parent
-- (the PostgREST path) regardless of any partition's own ACL — VERIFIED on a
-- real DB: `set role anon; select from hq_events` → 42501 after the parent
-- revoke alone, even while partitions still held their grants. The parent lock
-- is therefore the durable, environment-independent client-path fix: monthly
-- partitions are created/dropped at RUNTIME (not by migrations), so new ones
-- re-acquire the default-privileges grant on the PARTITION — but the parent lock
-- already denies the client path, leaving that residue inert. (Removing the
-- default grant itself is Slice 1.5 PR 5 / the CLI+default-privileges change.)
--
-- Partitions are ADDITIONALLY swept here for defence-in-depth (direct-partition /
-- TRUNCATE paths). The sweep is DYNAMIC over pg_inherits — never a hardcoded
-- partition list — so it is correct whatever partition set the target
-- environment holds at apply time, and cannot error on a missing/renamed one.
revoke all privileges on table public.hq_events from anon, authenticated;
do $$
declare part regclass;
begin
  for part in
    select inhrelid::regclass
    from pg_inherits
    where inhparent = 'public.hq_events'::regclass
  loop
    execute format('revoke all privileges on table %s from anon, authenticated', part);
  end loop;
end $$;

-- HQ CONSOLE — AI tasks/exec/memory/workflow/sales/comms/decisions/settings.
-- The super-admin "HQ" surface is 100% service_role: app/admin/* has zero
-- user-JWT (lib/supabase/server) imports; every admin action/page uses
-- createAdminClient or delegates to server/services/hq-* which create the admin
-- client internally (e.g. hq-task-queue.ts:274, hq-qa.ts:79). None is in the
-- GDPR census. So no authenticated path touches any hq_* table.
revoke all privileges on table public.hq_ai_executor_shadow_observations from anon, authenticated;
revoke all privileges on table public.hq_ai_schedule_runs from anon, authenticated;
revoke all privileges on table public.hq_ai_schedules from anon, authenticated;
revoke all privileges on table public.hq_ai_task_stage_events from anon, authenticated;
revoke all privileges on table public.hq_ai_tasks from anon, authenticated;
revoke all privileges on table public.hq_application_records from anon, authenticated;
revoke all privileges on table public.hq_apply_audit from anon, authenticated;
revoke all privileges on table public.hq_approvals from anon, authenticated;
revoke all privileges on table public.hq_backfill_state from anon, authenticated;
revoke all privileges on table public.hq_capabilities from anon, authenticated;
revoke all privileges on table public.hq_capability_grants from anon, authenticated;
revoke all privileges on table public.hq_ceo_briefings from anon, authenticated;
revoke all privileges on table public.hq_comms_suppressions from anon, authenticated;
revoke all privileges on table public.hq_communications from anon, authenticated;
revoke all privileges on table public.hq_competitor_notes from anon, authenticated;
revoke all privileges on table public.hq_consumer_retries from anon, authenticated;
revoke all privileges on table public.hq_consumer_selftest from anon, authenticated;
revoke all privileges on table public.hq_decision_events from anon, authenticated;
revoke all privileges on table public.hq_decisions from anon, authenticated;
revoke all privileges on table public.hq_drafts from anon, authenticated;
revoke all privileges on table public.hq_embedding_runs from anon, authenticated;
revoke all privileges on table public.hq_event_consumers from anon, authenticated;
revoke all privileges on table public.hq_memories from anon, authenticated;
revoke all privileges on table public.hq_memory_access_grants from anon, authenticated;
revoke all privileges on table public.hq_memory_employee_links from anon, authenticated;
revoke all privileges on table public.hq_memory_events from anon, authenticated;
revoke all privileges on table public.hq_memory_relationships from anon, authenticated;
revoke all privileges on table public.hq_memory_sources from anon, authenticated;
revoke all privileges on table public.hq_memory_types from anon, authenticated;
revoke all privileges on table public.hq_memory_versions from anon, authenticated;
revoke all privileges on table public.hq_saga_events from anon, authenticated;
revoke all privileges on table public.hq_saga_steps from anon, authenticated;
revoke all privileges on table public.hq_sales_ai_tasks from anon, authenticated;
revoke all privileges on table public.hq_sales_call_scripts from anon, authenticated;
revoke all privileges on table public.hq_sales_calls from anon, authenticated;
revoke all privileges on table public.hq_sales_channel_types from anon, authenticated;
revoke all privileges on table public.hq_sales_channels from anon, authenticated;
revoke all privileges on table public.hq_sales_companies from anon, authenticated;
revoke all privileges on table public.hq_sales_contacts from anon, authenticated;
revoke all privileges on table public.hq_sales_external_records from anon, authenticated;
revoke all privileges on table public.hq_sales_integrations from anon, authenticated;
revoke all privileges on table public.hq_sales_learnings from anon, authenticated;
revoke all privileges on table public.hq_sales_locations from anon, authenticated;
revoke all privileges on table public.hq_sales_objections from anon, authenticated;
revoke all privileges on table public.hq_sales_recommendations from anon, authenticated;
revoke all privileges on table public.hq_sales_research_reports from anon, authenticated;
revoke all privileges on table public.hq_sales_sources from anon, authenticated;
revoke all privileges on table public.hq_sales_task_types from anon, authenticated;
revoke all privileges on table public.hq_sales_timeline_events from anon, authenticated;
revoke all privileges on table public.hq_settings from anon, authenticated;
revoke all privileges on table public.hq_timeline from anon, authenticated;
revoke all privileges on table public.hq_workflow_sagas from anon, authenticated;

-- AI-EMPLOYEE FRAMEWORK — HQ roster runtime, service_role only (ai-employees.ts,
-- ai-boardroom/actions.ts via admin svc). Not in the GDPR census.
revoke all privileges on table public.ai_employee_kpis from anon, authenticated;
revoke all privileges on table public.ai_employee_memory from anon, authenticated;
revoke all privileges on table public.ai_employee_tasks from anon, authenticated;
revoke all privileges on table public.ai_employees from anon, authenticated;

-- AI-RECEPTIONIST REPLY LEDGERS — outbound transports/receipts/send-claims/audits.
-- In the GDPR `known` list but ALSO in `excluded`, so ORG_EXPORT_TABLES does NOT
-- include them — the DSAR export never reads them. Every reference is the admin
-- (service_role) client: outbound-audit.ts:84/97 ("service-role — RLS-locked
-- table"), receptionist.ts:666/743, hq-qa.ts:107. No authenticated reader.
revoke all privileges on table public.ai_reply_audits from anon, authenticated;
revoke all privileges on table public.ai_reply_delivery_receipts from anon, authenticated;
revoke all privileges on table public.ai_reply_send_claims from anon, authenticated;
revoke all privileges on table public.ai_reply_transports from anon, authenticated;

-- PLATFORM BILLING / WEBHOOK INGESTION / QUEUES / OPS — all service_role, none
-- read by a user-JWT path (all are in the GDPR `excluded` deny-list where they
-- appear at all), so none is a DSAR-export read:
--   • billing_events/billing_invoices — Stripe webhook + admin billing (admin
--     client); /settings/billing issues no .from() on either.
--   • email_webhook_events/whatsapp_webhook_events — inbound ingestion, admin
--     client (email-webhook-handler.ts, whatsapp-events-sweep.ts). [A.6 kept
--     their SELECT on the mistaken premise they were GDPR-exported; they are in
--     `excluded`, so the export never reads them — SELECT removed here. A.6's
--     test is updated to assert them fully locked.]
--   • notification_email_queue — service_role (lib/notifications/email.ts,
--     cis-statement-emails.ts admin client; file header "service-role-only").
--   • automation_runs — automation-dispatcher.ts (admin); app/(app) hits are
--     comments only, no .from().
--   • health_score_events — hq-health-* (admin).
--   • cron_runs, ops_backup_runs — ops telemetry/snapshot (admin, read by
--     /admin/ops). ops_backup_runs is the latent default grant explicitly
--     recorded by Slice 1.5 PR 1 for this PR; writer is the off-platform backup
--     script (pooler-superuser). Both service_role — no client access.
--   • dead_events, rate_limit_counters, waitlist — no app references / service
--     infra only.
revoke all privileges on table public.automation_runs from anon, authenticated;
revoke all privileges on table public.billing_events from anon, authenticated;
revoke all privileges on table public.billing_invoices from anon, authenticated;
revoke all privileges on table public.cron_runs from anon, authenticated;
revoke all privileges on table public.dead_events from anon, authenticated;
revoke all privileges on table public.email_webhook_events from anon, authenticated;
revoke all privileges on table public.health_score_events from anon, authenticated;
revoke all privileges on table public.notification_email_queue from anon, authenticated;
revoke all privileges on table public.ops_backup_runs from anon, authenticated;
revoke all privileges on table public.rate_limit_counters from anon, authenticated;
revoke all privileges on table public.waitlist from anon, authenticated;
revoke all privileges on table public.whatsapp_webhook_events from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- GUARD EXTENSION — teach the canonical ACL-introspection RPC about partitioned
-- parents. A.6's _introspect_client_table_grants (20261215000000) filtered
-- `relkind = 'r'`, so it could not SEE the partitioned parent `hq_events`
-- (relkind = 'p') — the only partitioned public table — which would make a
-- regression guard on the parent vacuous (it would return zero rows whether or
-- not the parent were re-granted). Widen to `relkind in ('r','p')` so the
-- live-ACL guard pins partitioned parents too. Body otherwise identical: still
-- catalogue-only (reads pg_class.relacl via aclexplode — no tenant data),
-- `security invoker`, and service_role-only. (Sequences/views/functions remain
-- the PR 4 guard extension.) CREATE OR REPLACE preserves the function's ACL; the
-- revoke/grant trio below is re-asserted idempotently for defence-in-depth.
-- ═════════════════════════════════════════════════════════════════════════════
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
  where c.relkind in ('r', 'p')
    and c.relname = any (p_tables)
    and r.rolname in ('anon', 'authenticated')
  order by c.relname, r.rolname, a.privilege_type;
$$;

revoke all on function public._introspect_client_table_grants(text[]) from public;
revoke execute on function public._introspect_client_table_grants(text[]) from anon, authenticated;
grant execute on function public._introspect_client_table_grants(text[]) to service_role;
