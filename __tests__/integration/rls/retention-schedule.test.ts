import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Retention release schedule (Programme C extension) — DB invariants against
 * real Postgres (20261013).
 *
 *  - The range CHECKs (defects_liability_months 0–120, retention_first_release_pct
 *    0–100) are DB-enforced, not just app-side.
 *  - Writing the schedule terms is admin-only (the jobs UPDATE RLS): a non-admin
 *    member's update matches zero rows.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): { select(c: string): PromiseLike<Res<Row[]>> };
}
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-retsched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("retention schedule · DB CHECKs + admin-only RLS", () => {
  let orgId = "";
  let jobId = "";
  let staffId = "";
  let staffToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc.from("organizations").insert({ name: "RetSched Org", slug: TOKEN }).select("id").single();
    orgId = String(org.data?.id ?? "");
    const job = await svc.from("jobs").insert({ org_id: orgId, status: "new", retention_percent: 5 }).select("id").single();
    jobId = String(job.data?.id ?? "");
    if (!orgId || !jobId) throw new Error("fixture setup failed");

    // A non-admin (staff) member with a token.
    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    staffId = created.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id: staffId, email, full_name: "Staffer" });
    await db(serviceClient()).from("memberships").insert({ org_id: orgId, user_id: staffId, role: "staff" });
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    staffToken = signedIn.data.session?.access_token ?? "";
    if (!staffToken) throw new Error("failed to mint staff token");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgId) await svc.from("organizations").delete().eq("id", orgId);
    if (staffId) await serviceClient().auth.admin.deleteUser(staffId);
  });

  it("accepts valid schedule terms", async () => {
    const r = await db(serviceClient())
      .from("jobs")
      .update({ practical_completion_date: "2026-06-01", defects_liability_months: 12, retention_first_release_pct: 50 })
      .eq("id", jobId)
      .select("id");
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data?.length).toBe(1);
  });

  it("rejects a defects-liability period over 120 months (DB CHECK)", async () => {
    const r = await db(serviceClient())
      .from("jobs")
      .update({ defects_liability_months: 200 })
      .eq("id", jobId)
      .select("id");
    expect(r.error, "months > 120 must be rejected").not.toBeNull();
  });

  it("rejects a first-release percentage over 100 (DB CHECK)", async () => {
    const r = await db(serviceClient())
      .from("jobs")
      .update({ retention_first_release_pct: 150 })
      .eq("id", jobId)
      .select("id");
    expect(r.error, "pct > 100 must be rejected").not.toBeNull();
  });

  it("rejects a negative defects-liability period (DB CHECK)", async () => {
    const r = await db(serviceClient())
      .from("jobs")
      .update({ defects_liability_months: -1 })
      .eq("id", jobId)
      .select("id");
    expect(r.error).not.toBeNull();
  });

  it("a non-admin (staff) member cannot write the schedule terms (jobs UPDATE RLS)", async () => {
    const r = await db(userClient(staffToken))
      .from("jobs")
      .update({ defects_liability_months: 24 })
      .eq("id", jobId)
      .select("id");
    // RLS filters the row out for non-admins → zero rows, no error.
    expect(r.error).toBeNull();
    expect(r.data ?? []).toHaveLength(0);
    // Ground truth: unchanged (still 12 from the valid-update test).
    const check = await db(serviceClient()).from("jobs").select("defects_liability_months").eq("id", jobId);
    expect(Number((check.data?.[0]?.defects_liability_months as number) ?? 0)).toBe(12);
  });
});
