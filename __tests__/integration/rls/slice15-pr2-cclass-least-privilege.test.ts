import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Slice 1.5 — PR 2 regression guard (real Postgres).
 *
 * Proves BOTH sides of the C-class least-privilege migration
 * supabase/migrations/20261236000000_slice15_pr2_cclass_least_privilege.sql:
 *   • every service-role-only table is now UNREACHABLE by anon + authenticated
 *     (no client grant → 42501); and
 *   • every legitimate authenticated READ the change preserves still SUCCEEDS
 *     (the GDPR/DSAR export census + the retention-snapshot head-count); and
 *   • service_role retains full access everywhere (no internal workflow breaks).
 *
 * Mechanisms (per the Slice 1.5 directive), in order of preference:
 *   • CATALOGUE — read the LIVE ACL via the service-role introspection RPC
 *     `_introspect_client_table_grants` (same canonical guard A.6 uses). This
 *     pins the exact end-state and is a real-DB assertion, not a source scan.
 *   • BEHAVIORAL — drive the real client (anon / authenticated / service_role)
 *     against a representative subset and assert the outcome (the property
 *     itself: 42501 for hostile roles, rows-or-empty for legitimate readers).
 *
 * This EXTENDS the canonical privilege guard: a future migration that silently
 * re-grants a client role on any of these tables fails here.
 */

type Grant = { table_name: string; grantee: string; privilege_type: string };
type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
const rpc = (client: unknown) =>
  client as unknown as { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Res<Grant[]>> };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  limit(n: number): PromiseLike<Res<Row[]>>;
}
const from = (client: unknown, t: string) =>
  (client as unknown as { from(t: string): { select(c?: string): Sel } }).from(t);

/**
 * A PRIVILEGE denial, and ONLY that. The live behaviour on a fully-revoked table
 * is Postgres `42501 permission denied for table X` surfaced through PostgREST
 * (verified directly against the DB: `set role anon; select …` → 42501). Matched
 * strictly on the 42501 code / "permission denied" text — deliberately NOT a bare
 * `PGRST` nor "does not exist"/"schema cache", which would let an unrelated error
 * (no rows, a dropped/renamed relation, a JWT problem) masquerade as a grant
 * denial and hide a different failure.
 */
const isDenied = (e: { message: string; code?: string } | null) =>
  e != null && (e.code === "42501" || /permission denied|not allowed/i.test(e.message));

// KEEP_AUTH_SELECT (20): authenticated SELECT only; no anon; no authenticated write.
// internal_notes + portal_uploads + the 17 receptionist_* are ORG_EXPORT_TABLES
// (read by the user-JWT GDPR export); admin_alert_state is read by the user-JWT
// retention-snapshot head-count. All operational writes are service_role.
const KEEP_AUTH_SELECT = [
  "admin_alert_state",
  "internal_notes",
  "portal_uploads",
  "receptionist_conversation_actions",
  "receptionist_conversation_authorisations",
  "receptionist_conversation_claim_reassignments",
  "receptionist_conversation_claim_releases",
  "receptionist_conversation_claims",
  "receptionist_conversation_coordinations",
  "receptionist_conversation_executions",
  "receptionist_conversation_fulfilments",
  "receptionist_conversation_lifecycles",
  "receptionist_conversation_orchestrations",
  "receptionist_conversation_outcomes",
  "receptionist_conversation_recoveries",
  "receptionist_conversation_resolutions",
  "receptionist_conversation_verifications",
  "receptionist_conversations",
  "receptionist_messages",
  "receptionist_review_resolutions",
];

// FULLY_LOCKED — no client grant of any kind. The stable, migration-created set
// (plus the hq_events partitioned PARENT + its default partition). The dated
// monthly hq_events_YYYY_MM partitions are created/dropped at RUNTIME, so they
// are intentionally NOT pinned by name here; the migration sweeps them with a
// dynamic pg_inherits loop, and the PARENT lock (asserted below, catalogue +
// behavioural) is the durable client-path guard regardless of the partition set.
const FULLY_LOCKED = [
  "ai_employee_kpis",
  "ai_employee_memory",
  "ai_employee_tasks",
  "ai_employees",
  "ai_reply_audits",
  "ai_reply_delivery_receipts",
  "ai_reply_send_claims",
  "ai_reply_transports",
  "automation_runs",
  "billing_events",
  "billing_invoices",
  "cron_runs",
  "dead_events",
  "email_webhook_events",
  "health_score_events",
  "hq_ai_executor_shadow_observations",
  "hq_ai_schedule_runs",
  "hq_ai_schedules",
  "hq_ai_task_stage_events",
  "hq_ai_tasks",
  "hq_application_records",
  "hq_apply_audit",
  "hq_approvals",
  "hq_backfill_state",
  "hq_capabilities",
  "hq_capability_grants",
  "hq_ceo_briefings",
  "hq_comms_suppressions",
  "hq_communications",
  "hq_competitor_notes",
  "hq_consumer_retries",
  "hq_consumer_selftest",
  "hq_decision_events",
  "hq_decisions",
  "hq_drafts",
  "hq_embedding_runs",
  "hq_event_consumers",
  "hq_events",
  "hq_events_default",
  "hq_memories",
  "hq_memory_access_grants",
  "hq_memory_employee_links",
  "hq_memory_events",
  "hq_memory_relationships",
  "hq_memory_sources",
  "hq_memory_types",
  "hq_memory_versions",
  "hq_saga_events",
  "hq_saga_steps",
  "hq_sales_ai_tasks",
  "hq_sales_call_scripts",
  "hq_sales_calls",
  "hq_sales_channel_types",
  "hq_sales_channels",
  "hq_sales_companies",
  "hq_sales_contacts",
  "hq_sales_external_records",
  "hq_sales_integrations",
  "hq_sales_learnings",
  "hq_sales_locations",
  "hq_sales_objections",
  "hq_sales_recommendations",
  "hq_sales_research_reports",
  "hq_sales_sources",
  "hq_sales_sourcing_imports",
  "hq_sales_sourcing_pool",
  "hq_sales_task_types",
  "hq_sales_timeline_events",
  "hq_settings",
  "hq_timeline",
  "hq_workflow_sagas",
  "notification_email_queue",
  "ops_backup_runs",
  "rate_limit_counters",
  "waitlist",
  "whatsapp_webhook_events",
];

// Representative behavioural subset (bounds runtime; one per distinct class).
const LOCK_PROBE = [
  "ops_backup_runs", // the latent grant recorded by PR 1 for this PR
  "hq_settings",
  "hq_events", // partitioned parent — client path must be closed
  "hq_sales_sourcing_pool", // #901 sourcing pool — created after original census
  "billing_invoices",
  "email_webhook_events", // reclassified from A.6 keep-SELECT → full lock
  "whatsapp_webhook_events",
  "ai_reply_transports",
  "dead_events",
];
const KEEP_PROBE = ["receptionist_conversations", "internal_notes", "portal_uploads", "admin_alert_state"];

describeIntegration("Slice 1.5 PR2 C-class least-privilege (20261236000000)", () => {
  let grants: Grant[] = [];
  let token = "";
  let userId = "";

  beforeAll(async () => {
    const all = [...FULLY_LOCKED, ...KEEP_AUTH_SELECT];
    const res = await rpc(serviceClient()).rpc("_introspect_client_table_grants", { p_tables: all });
    expect(res.error, res.error?.message).toBeNull();
    grants = res.data ?? [];

    // Any signed-in user proves the GRANT boundary (42501 is enforced before RLS);
    // no membership is needed. KEEP tables return 0 rows (RLS denies), not an error.
    const email = `it-s15pr2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@x.test`;
    const password = `Pw-${Date.now()}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    userId = created.data.user?.id ?? "";
    const s = await anonClient().auth.signInWithPassword({ email, password });
    expect(s.error, s.error?.message).toBeNull();
    token = s.data.session?.access_token ?? "";
  });

  afterAll(async () => {
    if (userId) await serviceClient().auth.admin.deleteUser(userId).catch(() => undefined);
  });

  const forTable = (t: string) => grants.filter((g) => g.table_name === t);

  // ─── CATALOGUE: exact end-state ────────────────────────────────────────────
  it("every FULLY_LOCKED table carries NO anon/authenticated grant of any kind", () => {
    const offenders = FULLY_LOCKED.map((t) => [t, forTable(t)] as const).filter(([, g]) => g.length > 0);
    expect(
      offenders,
      `still client-granted: ${JSON.stringify(offenders.map(([t, g]) => ({ t, g })))}`,
    ).toHaveLength(0);
  });

  it("every KEEP_AUTH_SELECT table carries authenticated SELECT and NOTHING else", () => {
    for (const t of KEEP_AUTH_SELECT) {
      const g = forTable(t);
      // no anon grant at all
      expect(g.filter((x) => x.grantee === "anon"), `${t}: anon still granted`).toHaveLength(0);
      // authenticated holds exactly SELECT
      const auth = g.filter((x) => x.grantee === "authenticated").map((x) => x.privilege_type).sort();
      expect(auth, `${t}: authenticated grants are not exactly [SELECT]`).toEqual(["SELECT"]);
    }
  });

  // ─── BEHAVIORAL: hostile roles denied ──────────────────────────────────────
  it("anon + authenticated are DENIED on FULLY_LOCKED tables (incl. ops_backup_runs + hq_events parent)", async () => {
    for (const t of LOCK_PROBE) {
      const asAnon = await from(anonClient(), t).select("*").limit(1);
      expect(isDenied(asAnon.error), `anon reached ${t}: ${JSON.stringify(asAnon.error)}`).toBe(true);
      const asAuth = await from(userClient(token), t).select("*").limit(1);
      expect(isDenied(asAuth.error), `authenticated reached ${t}: ${JSON.stringify(asAuth.error)}`).toBe(true);
    }
  });

  it("anon is DENIED on KEEP_AUTH_SELECT tables (anon grant was removed)", async () => {
    for (const t of KEEP_PROBE) {
      const asAnon = await from(anonClient(), t).select("*").limit(1);
      expect(isDenied(asAnon.error), `anon reached ${t}: ${JSON.stringify(asAnon.error)}`).toBe(true);
    }
  });

  // ─── BEHAVIORAL: legitimate readers preserved ──────────────────────────────
  it("authenticated SELECT SUCCEEDS on KEEP_AUTH_SELECT tables (GDPR export + retention-snapshot reads survive)", async () => {
    for (const t of KEEP_PROBE) {
      const res = await from(userClient(token), t).select("*").limit(1);
      // RLS denies rows (0 policies) ⇒ empty set, but NO privilege error.
      expect(res.error, `authenticated lost its legitimate SELECT on ${t}: ${JSON.stringify(res.error)}`).toBeNull();
      expect(Array.isArray(res.data)).toBe(true);
    }
  });

  it("service_role retains full access on FULLY_LOCKED tables (no internal workflow breaks)", async () => {
    for (const t of LOCK_PROBE) {
      const res = await from(serviceClient(), t).select("*").limit(1);
      expect(res.error, `service_role lost access to ${t}: ${JSON.stringify(res.error)}`).toBeNull();
    }
  });
});
