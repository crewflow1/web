import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Least-privilege grant revoke — regression guard (real Postgres) for
 * supabase/migrations/20261295000000_least_privilege_grant_revoke.sql.
 *
 * Catalogue assertion via the service-role introspection RPC (same approach as
 * slice15-pr1 / audit-log-grant-lockdown): we read the LIVE ACL, not source text.
 *
 * The tenant-BOUNDARY tables keep SELECT but carry NO write grant to any client role
 * (every write flows via the service-role admin client).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type AclRow = { table_name?: string; grantee: string; privilege_type: string };
const svc = () =>
  serviceClient() as unknown as {
    rpc: (fn: string, args?: Record<string, unknown>) => Promise<Res<AclRow[]>>;
  };

const CLIENT_ROLES = new Set(["anon", "authenticated", "PUBLIC"]);
const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "TRUNCATE"]);
const BOUNDARY_TABLES = ["memberships", "organizations", "users"];

describeIntegration("least-privilege grant revoke (20261295)", () => {
  it("tenant-boundary tables carry NO client WRITE grant, but keep SELECT", async () => {
    const res = await svc().rpc("_introspect_client_table_grants", { p_tables: BOUNDARY_TABLES });
    expect(res.error, res.error?.message).toBeNull();
    const rows = (res.data ?? []).filter((r) => CLIENT_ROLES.has(r.grantee));

    const writes = rows.filter((r) => WRITES.has(r.privilege_type));
    expect(
      writes,
      `tenant-boundary tables must have zero client write grants — found: ${JSON.stringify(writes)}`,
    ).toHaveLength(0);

    // SELECT must survive (RLS read policies depend on it; /api/health reads organizations as anon).
    for (const t of BOUNDARY_TABLES) {
      const hasSelect = rows.some((r) => r.table_name === t && r.privilege_type === "SELECT");
      expect(hasSelect, `${t} must retain a client SELECT grant for its RLS read policies`).toBe(true);
    }
  });
});
