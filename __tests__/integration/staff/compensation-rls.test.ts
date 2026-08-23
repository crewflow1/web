import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * staff_compensation RLS — pay + emergency contact are SELF + ADMIN only, against
 * REAL Postgres (migration 20261218000000).
 *
 * The defect this closes: `hourly_pay` + `emergency_contact` used to live on
 * public.users, whose "members can read profiles of co-workers" policy grants
 * ROW-level SELECT to any org member — so an ordinary staff member could read a
 * co-worker's pay by direct API/DB, bypassing the admin-only UI. Moving the
 * columns to this table with a self-or-admin policy is the fix; these tests drive
 * the EXACT RLS the production user-JWT client hits and prove:
 *   · staff CANNOT read a co-worker's pay              (the reported leak, closed)
 *   · staff CAN read their OWN pay                     (the /me earnings estimate)
 *   · an org admin CAN read a member's pay             (payroll / roster / costing)
 *   · staff CANNOT write their own pay                 (no payroll self-escalation)
 *   · a member of ANOTHER org sees nothing             (cross-tenant isolation)
 *   · anon sees nothing
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Chain extends PromiseLike<Res> {
  select(c: string): Chain;
  eq(c: string, v: unknown): Chain;
  update(r: Record<string, unknown>): Chain;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Chain;
      update(r: Record<string, unknown>): Chain;
      insert(r: Record<string, unknown>): {
        select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> };
      };
    };
  };

const T = `it-comp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("staff_compensation RLS — pay is self + admin only (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let admin = { id: "", token: "" };
  let staff = { id: "", token: "" };
  let outsider = { id: "", token: "" };
  const svc = () => db(serviceClient());

  async function newUser(label: string, org: string, role: string) {
    const email = `${T}-${label}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: label });
    await svc().from("memberships").insert({ org_id: org, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "CO A", slug: `${T}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "CO B", slug: `${T}-b` }).select("id").single()).data?.id);
    admin = await newUser("admin", orgA, "owner");
    staff = await newUser("staff", orgA, "staff");
    outsider = await newUser("outsider", orgB, "owner");
    // Seed pay via the service role (bypasses RLS) — the admin's £45.50, staff's £18.00.
    await svc().from("staff_compensation").insert({ user_id: admin.id, hourly_pay: 45.5 });
    await svc().from("staff_compensation").insert({ user_id: staff.id, hourly_pay: 18.0 });
  });

  afterAll(async () => {
    const s = serviceClient();
    for (const uid of [admin.id, staff.id, outsider.id]) {
      if (!uid) continue;
      await s.from("staff_compensation").delete().eq("user_id", uid);
      await s.from("memberships").delete().eq("user_id", uid);
      await s.from("users").delete().eq("id", uid);
      await s.auth.admin.deleteUser(uid).catch(() => {});
    }
    for (const org of [orgA, orgB]) {
      if (org) await s.from("organizations").delete().eq("id", org);
    }
  });

  it("staff CANNOT read a co-worker's (the admin's) pay — the leak, closed", async () => {
    const res = await db(userClient(staff.token))
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .eq("user_id", admin.id);
    expect(res.error).toBeNull();
    expect(res.data ?? []).toEqual([]); // RLS returns zero rows — not the £45.50
  });

  it("staff CAN read their OWN pay (the /me earnings estimate)", async () => {
    const res = await db(userClient(staff.token))
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .eq("user_id", staff.id);
    expect(res.error).toBeNull();
    expect(res.data?.length).toBe(1);
    expect(Number(res.data?.[0]?.hourly_pay)).toBe(18);
  });

  it("an org admin CAN read a member's pay (payroll / roster / costing)", async () => {
    const res = await db(userClient(admin.token))
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .eq("user_id", staff.id);
    expect(res.error).toBeNull();
    expect(res.data?.length).toBe(1);
    expect(Number(res.data?.[0]?.hourly_pay)).toBe(18);
  });

  it("staff CANNOT write their own pay (no payroll self-escalation)", async () => {
    await db(userClient(staff.token))
      .from("staff_compensation")
      .update({ hourly_pay: 999 })
      .eq("user_id", staff.id);
    // Verify via the service role that the rate is UNCHANGED (RLS filtered the update).
    const check = await svc().from("staff_compensation").select("hourly_pay").eq("user_id", staff.id);
    expect(Number(check.data?.[0]?.hourly_pay)).toBe(18);
  });

  it("a member of ANOTHER org sees nothing (cross-tenant isolation)", async () => {
    const res = await db(userClient(outsider.token))
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .eq("user_id", staff.id);
    expect(res.error).toBeNull();
    expect(res.data ?? []).toEqual([]);
  });

  it("anon sees nothing", async () => {
    const res = await db(anonClient())
      .from("staff_compensation")
      .select("user_id, hourly_pay")
      .eq("user_id", staff.id);
    expect(res.data ?? []).toEqual([]);
  });
});
