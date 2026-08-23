import { beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, anonClient, userClient } from "../_harness";

/**
 * A.6 — default-grant least-privilege guard · 20261215000000.
 *
 * Supabase grants ALL table privileges to anon+authenticated by default. On a
 * service-role-only table (RLS enabled, zero policies) those grants are latent
 * exposure: inert only until a future permissive policy is added, and TRUNCATE
 * is not gated by RLS at all. The migration REVOKEs them on the proven-safe set.
 *
 * This test reads the LIVE catalogue (via the locked-down introspection RPC) and
 * asserts:
 *   - the targets carry NO client write (INSERT/UPDATE/DELETE/TRUNCATE) grant;
 *   - the fully-locked targets carry NO client grant of any kind;
 *   - activity_log KEEPS authenticated SELECT (the feed is read by members);
 *   - control tables that legitimately need client access are UNAFFECTED;
 *   - the introspection RPC itself is service_role-only.
 *
 * A future migration that re-grants a client write silently would fail here.
 */

type Grant = { table_name: string; grantee: string; privilege_type: string };
type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
const rpc = (client: unknown) =>
  client as unknown as { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<Res<Grant[]>> };

const WRITE = new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);

// Fully locked (zero-policy service-role-only): no client grant of any kind.
const FULLY_LOCKED = [
  "impersonation_sessions",
  "admin_activity_log",
  "email_webhook_events",
  "whatsapp_webhook_events",
  "receptionist_conversations",
  "receptionist_messages",
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
  "receptionist_review_resolutions",
];

// Write-locked but keeps authenticated SELECT (member-readable feed).
const WRITE_LOCKED_KEEP_SELECT = ["activity_log"];

// Controls: legitimately client-accessible via RLS — must be UNTOUCHED.
const CONTROLS = ["webhook_endpoints", "webhook_deliveries"];

describeIntegration("A.6 default-grant least-privilege (20261215000000)", () => {
  let grants: Grant[] = [];

  beforeAll(async () => {
    const all = [...FULLY_LOCKED, ...WRITE_LOCKED_KEEP_SELECT, ...CONTROLS];
    const res = await rpc(serviceClient()).rpc("_introspect_client_table_grants", { p_tables: all });
    expect(res.error, res.error?.message).toBeNull();
    grants = res.data ?? [];
  });

  const forTable = (t: string) => grants.filter((g) => g.table_name === t);

  it("fully-locked tables have NO client grant of any kind", () => {
    for (const t of FULLY_LOCKED) {
      const g = forTable(t);
      expect(g, `${t} still carries client grants: ${JSON.stringify(g)}`).toHaveLength(0);
    }
  });

  it("write-locked tables have NO client write grant", () => {
    for (const t of WRITE_LOCKED_KEEP_SELECT) {
      const writes = forTable(t).filter((g) => WRITE.has(g.privilege_type));
      expect(writes, `${t} still writable by a client: ${JSON.stringify(writes)}`).toHaveLength(0);
    }
  });

  it("activity_log KEEPS authenticated SELECT (member feed) but nothing for anon", () => {
    const g = forTable("activity_log");
    const authSelect = g.some((x) => x.grantee === "authenticated" && x.privilege_type === "SELECT");
    expect(authSelect, "authenticated lost its legitimate SELECT on activity_log").toBe(true);
    expect(g.some((x) => x.grantee === "anon"), "anon should hold no grant on activity_log").toBe(false);
  });

  it("control tables that legitimately need client access are UNAFFECTED", () => {
    // webhook_endpoints has an authenticated INSERT policy; webhook_deliveries a
    // member SELECT policy. Both must still carry their client grants — proof the
    // revoke was targeted, not a schema-wide shotgun.
    expect(
      forTable("webhook_endpoints").some((g) => g.grantee === "authenticated"),
      "webhook_endpoints lost its legitimate authenticated grant",
    ).toBe(true);
    expect(
      forTable("webhook_deliveries").some((g) => g.grantee === "authenticated" && g.privilege_type === "SELECT"),
      "webhook_deliveries lost its legitimate authenticated SELECT",
    ).toBe(true);
  });

  it("the introspection RPC is service_role-only (anon + authenticated refused)", async () => {
    const anon = await rpc(anonClient()).rpc("_introspect_client_table_grants", { p_tables: ["activity_log"] });
    expect(anon.error, "anon could call the grant-introspection RPC").not.toBeNull();

    const email = `it-a6-${Date.now()}@example.test`;
    const password = `Pw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    const token = signedIn.data.session?.access_token ?? "";
    const authed = await rpc(userClient(token)).rpc("_introspect_client_table_grants", { p_tables: ["activity_log"] });
    expect(authed.error, "authenticated could call the grant-introspection RPC").not.toBeNull();
    await serviceClient().auth.admin.deleteUser(created.data.user?.id ?? "").catch(() => undefined);
  });
});
