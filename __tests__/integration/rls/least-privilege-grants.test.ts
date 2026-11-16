import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

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
    // `users` keeps it at COLUMN level since 20261342 (phone / employment_type / start_date
    // carry no client grant), so a table-level row is no longer the right evidence for it:
    // prove the grant behaviourally — a client can still select the non-private columns.
    for (const t of BOUNDARY_TABLES) {
      const tableLevel = rows.some((r) => r.table_name === t && r.privilege_type === "SELECT");
      const probe = await anonClient().from(t as "users").select("id").limit(1);
      expect(
        tableLevel || probe.error === null,
        `${t} must retain a client SELECT grant for its RLS read policies (${probe.error?.message ?? "ok"})`,
      ).toBe(true);
      expect(probe.error, `${t}: a client select of the id column must not be refused`).toBeNull();
    }
  });
});
