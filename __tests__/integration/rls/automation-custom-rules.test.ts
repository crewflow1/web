import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Custom automation rules + approvals (20261133) — RLS against real Postgres.
 *
 * Proves the member-read / admin-write posture at the DATABASE and that org
 * scoping is load-bearing:
 *   · an admin authors custom rules for their org; a staff member reads but
 *     cannot write; an admin of A cannot write B's rows; anon sees nothing;
 *   · the approval gate is member-read, admin-decidable, org-scoped;
 *   · the composite FK keeps a gate bound to a rule in the SAME org.
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
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-autocustom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const DEF = {
  trigger: "lead.created",
  conditions: null,
  actions: [{ type: "create_notification", params: { title: "hi" } }],
  requiresApproval: true,
  approvalPosition: 0,
};

describeIntegration("automation custom rules + approvals · RLS", () => {
  let orgA = "";
  let orgB = "";
  let adminAId = "";
  let adminAToken = "";
  let staffId = "";
  let staffToken = "";
  let ruleAId = "";

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
    orgA = await makeOrg("Auto Custom A", `${TOKEN}-a`);
    orgB = await makeOrg("Auto Custom B", `${TOKEN}-b`);

    const adminA = await makeUser("admina");
    adminAId = adminA.id;
    adminAToken = adminA.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

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
      for (const t of ["automation_custom_rules", "automation_approvals"]) {
        const residue = await svc().from(t).select("id").eq("org_id", id);
        expect(residue.data ?? [], `${t} leaked past org teardown`).toHaveLength(0);
      }
    }
    for (const id of [adminAId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── automation_custom_rules ──────────────────────────────────────────────────

  it("an ADMIN can create a custom rule for their org", async () => {
    const ins = await db(userClient(adminAToken))
      .from("automation_custom_rules")
      .insert({
        org_id: orgA,
        name: "Big lead",
        trigger_event: "lead.created",
        definition: DEF,
        enabled: true,
        created_by: adminAId,
      })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    ruleAId = String(ins.data?.id ?? "");
    expect(ruleAId).not.toBe("");
  });

  it("a STAFF member is REFUSED a write by RLS, but CAN read", async () => {
    const write = await db(userClient(staffToken))
      .from("automation_custom_rules")
      .insert({ org_id: orgA, name: "sneaky", trigger_event: "lead.created", definition: DEF })
      .select("id")
      .single();
    expect(write.error, "staff must not write custom rules").not.toBeNull();
    expect(write.error?.message ?? "").toMatch(/row-level security|policy/i);

    const readBack = await db(userClient(staffToken))
      .from("automation_custom_rules")
      .select("id, name")
      .eq("org_id", orgA);
    expect(readBack.error, readBack.error?.message).toBeNull();
    expect((readBack.data ?? []).length).toBeGreaterThan(0);
  });

  it("an admin of A CANNOT write a custom rule for B", async () => {
    const bad = await db(userClient(adminAToken))
      .from("automation_custom_rules")
      .insert({ org_id: orgB, name: "cross", trigger_event: "lead.created", definition: DEF })
      .select("id")
      .single();
    expect(bad.error, "cross-org write must be refused").not.toBeNull();
  });

  it("an anonymous caller sees no custom rules at all", async () => {
    const r = await db(anonClient()).from("automation_custom_rules").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });

  // ── automation_approvals ─────────────────────────────────────────────────────

  it("a gate is member-readable, admin-decidable, and org-scoped", async () => {
    // Seed a pending gate via service role (the engine's path).
    const gate = await svc()
      .from("automation_approvals")
      .insert({
        org_id: orgA,
        custom_rule_id: ruleAId,
        rule_name: "Big lead",
        event_type: "lead.created",
        source_table: "leads",
        source_id: "lead-xyz",
        correlation_id: "lead.created:leads:lead-xyz",
        payload: {},
        pending_actions: DEF.actions,
        status: "pending",
      })
      .select("id")
      .single();
    expect(gate.error, gate.error?.message).toBeNull();
    const gateId = String(gate.data?.id ?? "");

    // Staff can READ it.
    const staffRead = await db(userClient(staffToken))
      .from("automation_approvals")
      .select("id, status")
      .eq("org_id", orgA);
    expect(staffRead.error, staffRead.error?.message).toBeNull();
    expect((staffRead.data ?? []).length).toBeGreaterThan(0);

    // Staff CANNOT decide it.
    const staffDecide = await db(userClient(staffToken))
      .from("automation_approvals")
      .update({ status: "approved" })
      .eq("id", gateId)
      .eq("org_id", orgA);
    expect(staffDecide.error, "staff must not decide approvals").not.toBeNull();

    // Admin CAN decide it.
    const adminDecide = await db(userClient(adminAToken))
      .from("automation_approvals")
      .update({ status: "approved", decided_by: adminAId })
      .eq("id", gateId)
      .eq("org_id", orgA);
    expect(adminDecide.error, adminDecide.error?.message).toBeNull();
  });

  it("the composite FK refuses a gate whose org does not match its rule", async () => {
    const bad = await svc()
      .from("automation_approvals")
      .insert({
        org_id: orgB, // rule lives in org A → composite FK violation
        custom_rule_id: ruleAId,
        rule_name: "x",
        event_type: "lead.created",
        source_table: "leads",
        source_id: "lead-bad",
        correlation_id: "lead.created:leads:lead-bad",
        pending_actions: [],
        status: "pending",
      })
      .select("id")
      .single();
    expect(bad.error, "org-mismatched gate must be refused by the composite FK").not.toBeNull();
  });

  it("an anonymous caller sees no approvals at all", async () => {
    const r = await db(anonClient()).from("automation_approvals").select("id");
    expect(r.data ?? []).toHaveLength(0);
  });
});
