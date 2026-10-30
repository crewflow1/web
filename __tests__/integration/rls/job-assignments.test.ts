import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * R5 Phase 1 — job_assignments is service-role-only (migration 20261242000000),
 * against real Postgres.
 *
 * Phase 1 lands the table DARK: RLS enabled, NO client policy, client grants
 * revoked. Nothing reads it on the Data API yet. This proves the posture holds
 * at the database — the anon (client) role cannot read the table, while the
 * service-role client (the only writer in Phase 1) can. Phase 2 will add an
 * authenticated SELECT policy + grant when the app starts reading assignments;
 * this test will be tightened then.
 *
 * (The composite FK same-org integrity, unique(job_id,user_id) and
 * on-delete-cascade are exercised by CI applying the migration to a fresh PG
 * plus the Phase-2 assignment-write tests.)
 */

type ListRes = { data: unknown[] | null; error: { message: string; code?: string } | null };
type Db = { from: (t: string) => { select: (c: string) => Promise<ListRes> } };
const db = (c: unknown): Db => c as unknown as Db;

describeIntegration("rls · job_assignments is service-role-only (20261242)", () => {
  it("the anon client CANNOT read job_assignments (no client grant/policy)", async () => {
    const res = await db(anonClient()).from("job_assignments").select("id");
    // revoke-all on the anon role surfaces a permission error (not a silent
    // empty set) — the table is not reachable through the Data API.
    expect(res.error, "anon read must be refused, not return rows").not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("the service-role client CAN read job_assignments", async () => {
    const res = await db(serviceClient()).from("job_assignments").select("id");
    expect(res.error, res.error?.message).toBeNull();
    expect(Array.isArray(res.data)).toBe(true);
  });
});
