import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, ukTodayIso, userClient } from "../_harness";

/**
 * AI Cost Governor ledger · tenant isolation, rollup correctness, teardown (20261062).
 *
 * `ai_invocations` records how much money each org's AI usage cost. That makes
 * it two sensitive things at once:
 *
 *   - CROSS-TENANT: org A's totals must be unreachable from org B, including
 *     through the rollup FUNCTIONS, which are the tempting place to accidentally
 *     grant definer rights and hand every caller the whole estate.
 *   - INTRA-TENANT: usage reveals how a firm works and which capabilities its
 *     staff lean on. That is owner/admin information, so a plain MEMBER of the
 *     very same org must be denied too — an isolation test that only proved
 *     A-cannot-see-B would pass while every crew member read the books.
 *
 * The ceiling itself depends on the rollup being right, so the month window is
 * exercised at the boundary that actually bites: an invocation at 23:30 UTC on
 * 31 July, which is already 1 August in BST and must therefore be spent from
 * AUGUST's budget.
 */

type Err = { message: string; code?: string } | null;
type Res<T> = { data: T | null; error: Err };
type Row = Record<string, unknown>;

interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Upd;
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<Row[]>>;
  };

const T = `it-aigov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A complete, valid ledger row. Individual tests override one field at a time. */
function invocation(orgId: string, over: Row = {}): Row {
  return {
    org_id: orgId,
    user_id: null,
    feature: "expense.receipt_extraction",
    task_class: "classification",
    provider: "test-vendor",
    model: "test-model",
    input_tokens: 1_000,
    output_tokens: 200,
    estimated_cost_pence: 100,
    latency_ms: 250,
    success: true,
    ...over,
  };
}

describeIntegration("ai_invocations · isolation, rollups, teardown (20261062)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let adminA = { id: "", token: "" };
  let staffA = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  async function makeUser(suffix: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${suffix}@example.test`;
    const password = `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await svc()
      .from("users")
      .insert({ id, email, full_name: `AI Gov ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(label: string): Promise<string> {
    const r = await svc()
      .from("organizations")
      .insert({ name: `AI Gov ${label}`, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("a");
    orgB = await makeOrg("b");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    adminA = await makeUser("admin-a");
    staffA = await makeUser("staff-a");
    adminB = await makeUser("admin-b");

    for (const [org, user, role] of [
      [orgA, adminA.id, "admin"],
      [orgA, staffA.id, "staff"],
      [orgB, adminB.id, "admin"],
    ] as const) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: user, role })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }

    // Org A: two successes and one failure this month.
    const seeded = await svc()
      .from("ai_invocations")
      .insert([
        invocation(orgA, { estimated_cost_pence: 100, input_tokens: 1_000, output_tokens: 200 }),
        invocation(orgA, {
          feature: "receptionist.reply_draft",
          task_class: "drafting",
          estimated_cost_pence: 250,
          input_tokens: 2_000,
          output_tokens: 500,
          user_id: adminA.id,
        }),
        invocation(orgA, {
          estimated_cost_pence: 25,
          success: false,
          error_code: "provider_timeout",
        }),
      ]);
    expect(seeded.error, seeded.error?.message).toBeNull();

    // Org B: a deliberately DIFFERENT total, so a leak is an obviously wrong
    // number rather than a coincidence.
    const seededB = await svc()
      .from("ai_invocations")
      .insert(invocation(orgB, { estimated_cost_pence: 7_777 }));
    expect(seededB.error, seededB.error?.message).toBeNull();
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const u of [adminA.id, staffA.id, adminB.id]) {
      if (u) await serviceClient().auth.admin.deleteUser(u);
    }
  });

  // ── 1. Reads ───────────────────────────────────────────────────────────────

  it("service_role reads what it wrote (RLS bypassed)", async () => {
    const { data, error } = await svc()
      .from("ai_invocations")
      .select("id")
      .eq("org_id", orgA);
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBe(3);
  });

  it("anon is denied the ledger entirely", async () => {
    const { data, error } = await db(anonClient()).from("ai_invocations").select("*");
    expect(error ? true : (data ?? []).length === 0, "ledger leaked to anon").toBe(true);
  });

  it("org A's ADMIN reads org A's invocations", async () => {
    const { data, error } = await db(userClient(adminA.token))
      .from("ai_invocations")
      .select("id, org_id");
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBe(3);
    for (const row of data ?? []) expect(String(row.org_id)).toBe(orgA);
  });

  it("org A's admin CANNOT read org B's invocations — the cross-tenant boundary", async () => {
    const { data, error } = await db(userClient(adminA.token))
      .from("ai_invocations")
      .select("id")
      .eq("org_id", orgB);
    expect(error ? true : (data ?? []).length === 0, "org B leaked to org A's admin").toBe(true);
  });

  it("a plain MEMBER of org A cannot read ANY invocation — usage is admin-only", async () => {
    // The intra-tenant half of the boundary. An isolation suite that only
    // checked A-vs-B would pass while every crew member read the org's books.
    const { data, error } = await db(userClient(staffA.token))
      .from("ai_invocations")
      .select("id");
    expect(error ? true : (data ?? []).length === 0, "ledger leaked to a member").toBe(true);
  });

  it("org B's admin sees ONLY org B's single row", async () => {
    const { data, error } = await db(userClient(adminB.token))
      .from("ai_invocations")
      .select("id, estimated_cost_pence");
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBe(1);
    expect(Number((data ?? [])[0]?.estimated_cost_pence)).toBe(7_777);
  });

  // ── 2. Writes ──────────────────────────────────────────────────────────────

  it("an org ADMIN cannot INSERT — there is no INSERT policy at all", async () => {
    // If a user could write, a user could fabricate spend to trip their own
    // ceiling, or record zero-cost rows while real spend went unrecorded.
    const { error } = await db(userClient(adminA.token))
      .from("ai_invocations")
      .insert(invocation(orgA, { estimated_cost_pence: 1 }));
    expect(error, "an admin was able to write to the ledger").not.toBeNull();
  });

  it("an org admin cannot DELETE their own org's invocations", async () => {
    const before = await svc().from("ai_invocations").select("id").eq("org_id", orgA);
    await db(userClient(adminA.token)).from("ai_invocations").delete().eq("org_id", orgA);
    const after = await svc().from("ai_invocations").select("id").eq("org_id", orgA);
    expect((after.data ?? []).length).toBe((before.data ?? []).length);
  });

  it("a recorded invocation is IMMUTABLE — even for the service role", async () => {
    // Rewriting telemetry is either a mistake or an attempt to hide spend.
    const { data } = await svc().from("ai_invocations").select("id").eq("org_id", orgB);
    const id = String((data ?? [])[0]?.id);
    const { error } = await svc()
      .from("ai_invocations")
      .update({ estimated_cost_pence: 0 })
      .eq("id", id);
    expect(error, "a ledger row was rewritten").not.toBeNull();
    expect(error?.message ?? "").toMatch(/immutable/i);
  });

  it("a DETERMINISTIC invocation is structurally unrepresentable", async () => {
    // The TypeScript wrapper refuses it; the database refuses it for every role.
    const { error } = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { task_class: "deterministic" }));
    expect(error, "a deterministic invocation was recorded").not.toBeNull();
  });

  it("a failure without a code, and a success WITH one, are both refused", async () => {
    const noCode = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { success: false, error_code: null }));
    expect(noCode.error, "an unexplained failure was recorded").not.toBeNull();

    const bogus = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { success: true, error_code: "something" }));
    expect(bogus.error, "a success carried an error code").not.toBeNull();
  });

  it("a non-hex content_hash is refused — the column is a SHA-256 fingerprint", async () => {
    const { error } = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { content_hash: "not-a-hash" }));
    expect(error).not.toBeNull();

    const ok = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { content_hash: "a".repeat(64), estimated_cost_pence: 0 }));
    expect(ok.error, ok.error?.message).toBeNull();
    // Clean up so the totals below stay predictable.
    await svc().from("ai_invocations").delete().eq("content_hash", "a".repeat(64));
  });

  // ── 3. The rollups ─────────────────────────────────────────────────────────

  it("the org-month rollup totals org A correctly (successes AND failures)", async () => {
    const today = ukTodayIso();
    const { data, error } = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
      p_org_id: orgA,
      p_month: today,
    });
    expect(error, error?.message).toBeNull();
    const row = (data ?? [])[0];
    expect(row, "no totals row for org A").toBeTruthy();
    expect(Number(row!.invocations)).toBe(3);
    expect(Number(row!.successes)).toBe(2);
    expect(Number(row!.failures)).toBe(1);
    // A failed call still cost latency and (usually) input tokens, so its spend
    // counts toward the ceiling: 100 + 250 + 25.
    expect(Number(row!.total_cost_pence)).toBe(375);
    expect(Number(row!.input_tokens)).toBe(1_000 + 2_000 + 1_000);
    expect(Number(row!.output_tokens)).toBe(200 + 500 + 200);
  });

  it("p_org_id = null groups the estate — one row per org, HQ's view", async () => {
    const today = ukTodayIso();
    const { data, error } = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
      p_org_id: null,
      p_month: today,
    });
    expect(error, error?.message).toBeNull();
    const byOrg = new Map((data ?? []).map((r) => [String(r.org_id), Number(r.total_cost_pence)]));
    expect(byOrg.get(orgA)).toBe(375);
    expect(byOrg.get(orgB)).toBe(7_777);
  });

  it("the rollup is INVOKER-RIGHTS — org A's admin gets nothing for org B", async () => {
    // THE pin. A SECURITY DEFINER rollup would be a cross-tenant read
    // primitive: any authenticated caller could name another tenant's id and
    // receive their spend. The function holds no privilege of its own, so RLS
    // has already decided what is visible before the aggregate runs.
    const today = ukTodayIso();
    const { data, error } = await rpc(userClient(adminA.token)).rpc(
      "ai_invocations_month_totals",
      { p_org_id: orgB, p_month: today },
    );
    expect(error ? true : (data ?? []).length === 0, "org B's totals leaked").toBe(true);
  });

  it("the rollup is invoker-rights for the ESTATE query too — a null org is not a skeleton key", async () => {
    const today = ukTodayIso();
    const { data, error } = await rpc(userClient(adminA.token)).rpc(
      "ai_invocations_month_totals",
      { p_org_id: null, p_month: today },
    );
    expect(error, error?.message).toBeNull();
    const orgs = (data ?? []).map((r) => String(r.org_id));
    expect(orgs).not.toContain(orgB);
    expect(orgs.every((o) => o === orgA)).toBe(true);
  });

  it("a plain member gets NO totals at all", async () => {
    const today = ukTodayIso();
    const { data, error } = await rpc(userClient(staffA.token)).rpc(
      "ai_invocations_month_totals",
      { p_org_id: orgA, p_month: today },
    );
    expect(error ? true : (data ?? []).length === 0, "totals leaked to a member").toBe(true);
  });

  it("the per-feature rollup splits the spend by capability", async () => {
    const today = ukTodayIso();
    const { data, error } = await rpc(serviceClient()).rpc("ai_invocations_month_by_feature", {
      p_month: today,
      p_org_id: orgA,
    });
    expect(error, error?.message).toBeNull();
    const byFeature = new Map(
      (data ?? []).map((r) => [String(r.feature), Number(r.total_cost_pence)]),
    );
    expect(byFeature.get("expense.receipt_extraction")).toBe(125); // 100 + the 25p failure
    expect(byFeature.get("receptionist.reply_draft")).toBe(250);
  });

  // ── 4. The month boundary — Europe/London, where the ceiling actually bites ─

  it("bucketing is EUROPE/LONDON: 23:30Z on 31 July is AUGUST's budget", async () => {
    // Under BST the UK month begins an hour before UTC midnight. Bucketing this
    // row into July would spend August's money from July's budget — and, at a
    // blocked boundary, refuse the first call of a fresh month.
    const boundaryOrg = await makeOrg("boundary");
    try {
      const seeded = await svc()
        .from("ai_invocations")
        .insert([
          invocation(boundaryOrg, {
            estimated_cost_pence: 500,
            created_at: "2026-07-31T23:30:00Z", // 00:30 on 1 Aug, UK
          }),
          invocation(boundaryOrg, {
            estimated_cost_pence: 111,
            created_at: "2026-07-31T22:30:00Z", // 23:30 on 31 Jul, UK
          }),
        ]);
      expect(seeded.error, seeded.error?.message).toBeNull();

      const august = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
        p_org_id: boundaryOrg,
        p_month: "2026-08-15",
      });
      expect(Number((august.data ?? [])[0]?.total_cost_pence)).toBe(500);

      const july = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
        p_org_id: boundaryOrg,
        p_month: "2026-07-15",
      });
      expect(Number((july.data ?? [])[0]?.total_cost_pence)).toBe(111);
    } finally {
      await svc().from("organizations").delete().eq("id", boundaryOrg);
    }
  });

  it("a GMT month boundary is a plain UTC midnight", async () => {
    const gmtOrg = await makeOrg("gmt");
    try {
      await svc()
        .from("ai_invocations")
        .insert([
          invocation(gmtOrg, { estimated_cost_pence: 9, created_at: "2026-01-31T23:30:00Z" }),
          invocation(gmtOrg, { estimated_cost_pence: 90, created_at: "2026-02-01T00:30:00Z" }),
        ]);
      const jan = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
        p_org_id: gmtOrg,
        p_month: "2026-01-10",
      });
      const feb = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
        p_org_id: gmtOrg,
        p_month: "2026-02-10",
      });
      expect(Number((jan.data ?? [])[0]?.total_cost_pence)).toBe(9);
      expect(Number((feb.data ?? [])[0]?.total_cost_pence)).toBe(90);
    } finally {
      await svc().from("organizations").delete().eq("id", gmtOrg);
    }
  });

  it("a month with NO spend returns no row — callers coalesce to zero", async () => {
    const { data, error } = await rpc(serviceClient()).rpc("ai_invocations_month_totals", {
      p_org_id: orgA,
      p_month: "2019-01-15",
    });
    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBe(0);
  });

  // ── 5. Teardown ────────────────────────────────────────────────────────────

  it("deleting the org CASCADES the ledger — tenant teardown is not blocked", async () => {
    // A BEFORE DELETE immutability guard here would have aborted this, which is
    // the failure 20261052 was written to fix and the one that blocks GDPR
    // erasure. The immutability trigger is deliberately UPDATE-only.
    const doomed = await makeOrg("teardown");
    const seeded = await svc().from("ai_invocations").insert(invocation(doomed));
    expect(seeded.error, seeded.error?.message).toBeNull();

    const before = await svc().from("ai_invocations").select("id").eq("org_id", doomed);
    expect((before.data ?? []).length).toBe(1);

    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();

    const after = await svc().from("ai_invocations").select("id").eq("org_id", doomed);
    expect((after.data ?? []).length).toBe(0);

    // And the neighbours are untouched.
    const survivors = await svc().from("ai_invocations").select("id").eq("org_id", orgA);
    expect((survivors.data ?? []).length).toBe(3);
  });

  it("deleting the USER who triggered an invocation preserves the org's spend history", async () => {
    // `on delete set null`: a departed employee's deletion must not erase what
    // the organisation spent.
    const leaver = await makeUser("leaver");
    await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: leaver.id, role: "admin" });
    const seeded = await svc()
      .from("ai_invocations")
      .insert(invocation(orgA, { user_id: leaver.id, estimated_cost_pence: 42 }))
      .select("id")
      .single();
    expect(seeded.error, seeded.error?.message).toBeNull();
    const rowId = String(seeded.data?.id);

    // Remove the membership first — the leaver's other links to the org are
    // not what this test is about, and leaving them would test the FK graph
    // rather than the ledger's own `on delete set null`.
    await svc().from("memberships").delete().eq("user_id", leaver.id);
    const removed = await svc().from("users").delete().eq("id", leaver.id);
    expect(removed.error, removed.error?.message).toBeNull();
    const stillThere = await svc().from("users").select("id").eq("id", leaver.id);
    expect((stillThere.data ?? []).length, "the leaver was not actually deleted").toBe(0);
    await serviceClient().auth.admin.deleteUser(leaver.id).catch(() => undefined);

    const after = await svc()
      .from("ai_invocations")
      .select("id, user_id, estimated_cost_pence")
      .eq("id", rowId);
    expect((after.data ?? []).length, "spend history was erased with the user").toBe(1);
    expect((after.data ?? [])[0]?.user_id).toBeNull();
    expect(Number((after.data ?? [])[0]?.estimated_cost_pence)).toBe(42);

    await svc().from("ai_invocations").delete().eq("id", rowId);
  });

  it("the anonymisation hole is NARROW — a cost change smuggled alongside it is refused", async () => {
    // The immutability guard permits `user_id → null` because that is the FK's
    // own erasure action. It must not become a general-purpose edit door.
    const { data } = await svc().from("ai_invocations").select("id").eq("org_id", orgA);
    const id = String((data ?? [])[0]?.id);
    const { error } = await svc()
      .from("ai_invocations")
      .update({ user_id: null, estimated_cost_pence: 0 })
      .eq("id", id);
    expect(error, "a cost was rewritten under cover of anonymisation").not.toBeNull();
    expect(error?.message ?? "").toMatch(/immutable/i);
  });

  it("setting user_id to a DIFFERENT user is refused — only nulling is an erasure", async () => {
    const { data } = await svc()
      .from("ai_invocations")
      .select("id")
      .eq("org_id", orgA);
    const id = String((data ?? [])[0]?.id);
    const { error } = await svc()
      .from("ai_invocations")
      .update({ user_id: adminB.id })
      .eq("id", id);
    expect(error, "an invocation was reattributed to another user").not.toBeNull();
  });
});
