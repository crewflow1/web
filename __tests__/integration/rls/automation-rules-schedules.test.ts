import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Automation rules + schedules (20261096) — RLS against real Postgres.
 *
 * Proves the member-read / admin-write posture at the DATABASE (not merely in
 * the server action), and that the tenancy pin is load-bearing:
 *   · a plain member READS the org's rules/schedules but a member WRITE is
 *     refused by RLS;
 *   · an admin of org A CANNOT write org B's rows (is_org_admin is per-org);
 *   · a dual-org admin sees BOTH orgs through RLS alone — the reason the service
 *     layer pins org_id on every read;
 *   · an anonymous caller sees nothing.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(patch: Row): Upd;
  delete(): Upd;
  upsert(rows: Row, opts?: Record<string, unknown>): Ins;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-autorule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("automation rules + schedules · RLS", () => {
  let orgA = "";
  let orgB = "";
  let dualId = "";
  let dualToken = "";
  let adminAId = "";
  let adminAToken = "";
  let staffId = "";
  let staffToken = "";

  const svc = () => db(serviceClient());

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${suffix}@example.test`;
    const password = `Pw-${TOKEN}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `Auto ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(name: string, slug: string): Promise<string> {
    const r = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("Auto Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Auto Probe B", `${TOKEN}-b`);

    const dual = await makeUser("dual");
    dualId = dual.id;
    dualToken = dual.token;
    const adminA = await makeUser("admina");
    adminAId = adminA.id;
    adminAToken = adminA.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    const ma = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: adminAId, role: "admin" })
      .select("user_id")
      .single();
    expect(ma.error, ma.error?.message).toBeNull();
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc().from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
      for (const t of ["automation_rules", "automation_schedules"]) {
        const residue = await svc().from(t).select("id").eq("org_id", id);
        expect(residue.data ?? [], `${t} leaked past org teardown`).toHaveLength(0);
      }
    }
    for (const id of [dualId, adminAId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── automation_rules ────────────────────────────────────────────────────────

  it("an ADMIN can upsert a rule override for their org", async () => {
    const up = await db(userClient(dualToken))
      .from("automation_rules")
      .upsert(
        { org_id: orgA, rule_key: "quote_accepted_notify", enabled: false, updated_by: dualId },
        { onConflict: "org_id,rule_key" },
      )
      .select("id")
      .single();
    expect(up.error, up.error?.message).toBeNull();
  });

  it("a STAFF member is REFUSED a write by RLS, but CAN read", async () => {
    const write = await db(userClient(staffToken))
      .from("automation_rules")
      .insert({ org_id: orgA, rule_key: "invoice_overdue_alert", enabled: false })
      .select("id")
      .single();
    expect(write.error, "staff must not write automation rules").not.toBeNull();
    expect(write.error?.message ?? "").toMatch(/row-level security|policy/i);

    const readBack = await db(userClient(staffToken))
      .from("automation_rules")
      .select("rule_key, enabled")
      .eq("org_id", orgA);
    expect(readBack.error, readBack.error?.message).toBeNull();
    expect((readBack.data ?? []).length).toBeGreaterThan(0);
  });

  it("an admin of A CANNOT write a rule for B (is_org_admin is per-org)", async () => {
    const bad = await db(userClient(adminAToken))
      .from("automation_rules")
      .insert({ org_id: orgB, rule_key: "quote_accepted_notify", enabled: false })
      .select("id")
      .single();
    expect(bad.error, "cross-org write must be refused").not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/row-level security|policy/i);
  });

  it("the dual-org admin sees BOTH orgs through RLS alone — the pin is load-bearing", async () => {
    // Seed a row for org B via service role, then read UNPINNED as the dual admin.
    const seed = await svc()
      .from("automation_rules")
      .upsert(
        { org_id: orgB, rule_key: "invoice_overdue_alert", enabled: false },
        { onConflict: "org_id,rule_key" },
      )
      .select("id")
      .single();
    expect(seed.error, seed.error?.message).toBeNull();

    const unpinned = await db(userClient(dualToken)).from("automation_rules").select("org_id");
    expect(unpinned.error, unpinned.error?.message).toBeNull();
    const orgs = new Set((unpinned.data ?? []).map((r) => String(r.org_id)));
    expect(orgs.has(orgA)).toBe(true);
    expect(orgs.has(orgB), "RLS ALONE BLENDS THE TWO ORGS — the pin is what scopes").toBe(true);

    const pinned = await db(userClient(dualToken))
      .from("automation_rules")
      .select("org_id")
      .eq("org_id", orgA);
    const pinnedOrgs = new Set((pinned.data ?? []).map((r) => String(r.org_id)));
    expect(pinnedOrgs).toEqual(new Set([orgA]));
  });

  it("an anonymous caller sees no rules at all", async () => {
    const r = await db(anonClient()).from("automation_rules").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });

  // ── automation_schedules ─────────────────────────────────────────────────────

  it("an ADMIN can create a schedule; a STAFF member cannot", async () => {
    const ok = await db(userClient(dualToken))
      .from("automation_schedules")
      .insert({
        org_id: orgA,
        rule_key: "quote_accepted_notify",
        cron_expr: "0 9 * * 1",
        enabled: true,
        next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_by: dualId,
      })
      .select("id")
      .single();
    expect(ok.error, ok.error?.message).toBeNull();

    const denied = await db(userClient(staffToken))
      .from("automation_schedules")
      .insert({
        org_id: orgA,
        rule_key: "quote_accepted_notify",
        cron_expr: "0 9 * * 2",
        enabled: true,
        next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    expect(denied.error, "staff must not create schedules").not.toBeNull();
    expect(denied.error?.message ?? "").toMatch(/row-level security|policy/i);
  });

  it("a staff member CAN read schedules; an admin of A cannot write B's", async () => {
    const readBack = await db(userClient(staffToken))
      .from("automation_schedules")
      .select("id")
      .eq("org_id", orgA);
    expect(readBack.error, readBack.error?.message).toBeNull();
    expect((readBack.data ?? []).length).toBeGreaterThan(0);

    const bad = await db(userClient(adminAToken))
      .from("automation_schedules")
      .insert({
        org_id: orgB,
        rule_key: "quote_accepted_notify",
        cron_expr: "0 9 * * 3",
        enabled: true,
        next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .select("id")
      .single();
    expect(bad.error, "cross-org schedule write must be refused").not.toBeNull();
  });

  it("an anonymous caller sees no schedules at all", async () => {
    const r = await db(anonClient()).from("automation_schedules").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
});
