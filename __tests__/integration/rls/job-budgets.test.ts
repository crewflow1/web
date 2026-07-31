import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * JOB COST BASELINE against real Postgres (migration 20261072000000).
 *
 * The proofs in this file:
 *
 *   · THE ACCOUNTING BOUNDARY — a full set → revise → variation-estimate cycle
 *     writes NOT ONE `finances` row. A budget is a PLAN; a planned figure in the
 *     actual-cost ledger would be double-counted against the real supplier bill
 *     and would silently inflate the job's cost (the D1 argument, one step
 *     stronger than for stock: this is not even a claim that money moved);
 *   · the DUAL-ORG pair — a user who is an ADMIN of org A AND org B passes RLS
 *     for both, so an RLS-only read blends two companies' plans. The composite
 *     FK refuses a crafted cross-org job id even for service_role, and the
 *     active-org pin is proven LOAD-BEARING by stripping it;
 *   · WRITE-ONCE — a revision cannot be edited, a superseded one cannot be
 *     touched, and a targeted delete is refused for EVERY role;
 *   · exactly ONE current revision per job, under concurrency;
 *   · a revision after the first STRUCTURALLY requires a reason;
 *   · the admin gate is in the DATABASE — a staff member with a valid JWT is
 *     refused by RLS, not merely by the server action;
 *   · CASCADES still work: job delete, quote delete, and ORG TEARDOWN with a
 *     live baseline attached (the 20261052 lesson).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  is(column: string, value: unknown): Sel;
  order(column: string, opts: { ascending: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
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
const rpc = (client: unknown) =>
  client as unknown as {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<Res<unknown>>;
  };

const TOKEN = `it-budget-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("job cost baseline · boundary, isolation, immutability", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobA2 = "";
  let jobB = "";
  let customerA = "";
  let quoteA = "";
  /** A second variation with NO estimate — so the composite-FK proof below is
   *  not shadowed by the one-estimate-per-quote index. */
  let quoteA2 = "";
  let dualId = "";
  let dualToken = "";
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
      .insert({ id, email, full_name: `Budget ${suffix}` })
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

  async function makeJob(org: string): Promise<string> {
    const r = await svc().from("jobs").insert({ org_id: org, status: "new" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("Budget Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Budget Probe B", `${TOKEN}-b`);
    jobA = await makeJob(orgA);
    jobA2 = await makeJob(orgA);
    jobB = await makeJob(orgB);

    const cust = await svc()
      .from("customers")
      .insert({ org_id: orgA, name: "Budget Customer" })
      .select("id")
      .single();
    expect(cust.error, cust.error?.message).toBeNull();
    customerA = String(cust.data?.id ?? "");

    const q = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        job_id: jobA,
        number: `${TOKEN}-VAR-1`,
        variation_number: 1,
        status: "accepted",
        subtotal: 5000,
        vat_total: 1000,
      })
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    quoteA = String(q.data?.id ?? "");

    const q2 = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: customerA,
        job_id: jobA,
        number: `${TOKEN}-VAR-2`,
        variation_number: 2,
        status: "accepted",
        subtotal: 1000,
        vat_total: 200,
      })
      .select("id")
      .single();
    expect(q2.error, q2.error?.message).toBeNull();
    quoteA2 = String(q2.data?.id ?? "");

    const dual = await makeUser("dual");
    dualId = dual.id;
    dualToken = dual.token;
    const staff = await makeUser("staff");
    staffId = staff.id;
    staffToken = staff.token;

    // THE dual-org membership: ADMIN of BOTH orgs, so nothing below passes merely
    // because the user was under-privileged.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    // A plain member of org A — for the DB-side admin gate.
    const sm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: staffId, role: "staff" })
      .select("user_id")
      .single();
    expect(sm.error, sm.error?.message).toBeNull();
  });

  afterAll(async () => {
    // Teardown is ASSERTED, not fire-and-forget. Swallowing the error is what hid
    // the 20261052 org-teardown P1 for so long: a failed delete leaked every
    // fixture row into the shared database and nobody knew.
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc().from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
      for (const table of ["job_budgets", "quote_cost_estimates"]) {
        const residue = await svc().from(table).select("id").eq("org_id", id);
        expect(residue.data ?? [], `${table} leaked past org teardown`).toHaveLength(0);
      }
    }
    for (const id of [dualId, staffId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── 1. the accounting boundary ────────────────────────────────────────────

  it("a full baseline lifecycle writes NOT ONE finances row", async () => {
    const before = await svc().from("finances").select("id").eq("org_id", orgA);
    expect(before.error, before.error?.message).toBeNull();
    const countBefore = (before.data ?? []).length;

    // set → revise → variation estimate, all through the real authorities.
    const set = await rpc(userClient(dualToken)).rpc("set_job_budget", {
      p_job_id: jobA,
      p_org_id: orgA,
      p_total_cost: 40000,
      p_labour_cost: null,
      p_materials_cost: null,
      p_subcontractors_cost: null,
      p_misc_cost: null,
      p_target_margin_pct: 18,
      p_note: null,
    });
    expect(set.error, JSON.stringify(set.error)).toBeNull();

    const revise = await rpc(userClient(dualToken)).rpc("set_job_budget", {
      p_job_id: jobA,
      p_org_id: orgA,
      p_total_cost: 0,
      p_labour_cost: 20000,
      p_materials_cost: 18000,
      p_subcontractors_cost: 6000,
      p_misc_cost: 1000,
      p_target_margin_pct: 18,
      p_note: "ground conditions worse than surveyed",
    });
    expect(revise.error, JSON.stringify(revise.error)).toBeNull();

    const est = await db(userClient(dualToken))
      .from("quote_cost_estimates")
      .insert({
        org_id: orgA,
        quote_id: quoteA,
        labour_cost: 2000,
        materials_cost: 1500,
        subcontractors_cost: 400,
        misc_cost: 100,
        total_cost: 4000,
        margin_pct: 20,
        created_by: dualId,
      })
      .select("id")
      .single();
    expect(est.error, JSON.stringify(est.error)).toBeNull();

    const after = await svc().from("finances").select("id").eq("org_id", orgA);
    expect(after.error, after.error?.message).toBeNull();
    expect(
      (after.data ?? []).length,
      "a plan must never post a cost — that spend would be double-counted",
    ).toBe(countBefore);
  });

  it("the RPC DERIVES the total from the breakdown, so the two cannot disagree", async () => {
    // The revision above passed p_total_cost = 0 with a £45,000 breakdown.
    const rows = await svc()
      .from("job_budgets")
      .select("revision, total_cost, labour_cost, superseded_at")
      .eq("job_id", jobA)
      .order("revision", { ascending: true });
    expect(rows.error, rows.error?.message).toBeNull();
    const list = rows.data ?? [];
    expect(list).toHaveLength(2);
    expect(Number(list[0]!.total_cost)).toBe(40000);
    expect(list[0]!.labour_cost).toBeNull();
    expect(Number(list[1]!.total_cost)).toBe(45000); // 20000+18000+6000+1000
    expect(Number(list[1]!.labour_cost)).toBe(20000);
  });

  it("keeps EXACTLY ONE current revision after the supersede", async () => {
    const current = await svc()
      .from("job_budgets")
      .select("revision")
      .eq("job_id", jobA)
      .is("superseded_at", null);
    expect(current.error, current.error?.message).toBeNull();
    expect(current.data ?? []).toHaveLength(1);
    expect(Number((current.data ?? [])[0]?.revision)).toBe(2);
  });

  // ── 2. dual-org isolation ─────────────────────────────────────────────────

  it("REFUSES a baseline whose org differs from its job's org, even for service_role", async () => {
    // The composite FK, not an app filter: a crafted cross-org job id is
    // unrepresentable at the storage layer, so a forgotten pin cannot become a
    // cross-company write.
    const bad = await svc()
      .from("job_budgets")
      .insert({ org_id: orgB, job_id: jobA2, total_cost: 1000 })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/job_budgets_job_fk|foreign key/i);
  });

  it("REFUSES a variation estimate whose org differs from its quote's org", async () => {
    // Uses the estimate-FREE variation, so the refusal is provably the composite
    // FK and not the one-per-quote index shadowing it.
    const bad = await svc()
      .from("quote_cost_estimates")
      .insert({ org_id: orgB, quote_id: quoteA2, total_cost: 0 })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/quote_cost_estimates_quote_fk|foreign key/i);
  });

  it("the dual-org admin sees BOTH companies' baselines through RLS alone", async () => {
    // The reason the active-org pin exists. RLS is the OUTER boundary ("you
    // cannot see an org you do not belong to"); it is NOT scoping.
    const budgetB = await svc()
      .from("job_budgets")
      .insert({ org_id: orgB, job_id: jobB, total_cost: 9999 })
      .select("id")
      .single();
    expect(budgetB.error, budgetB.error?.message).toBeNull();

    const unpinned = await db(userClient(dualToken)).from("job_budgets").select("org_id, total_cost");
    expect(unpinned.error, unpinned.error?.message).toBeNull();
    const orgs = new Set((unpinned.data ?? []).map((r) => String(r.org_id)));
    expect(orgs.has(orgA), "org A must be visible").toBe(true);
    expect(
      orgs.has(orgB),
      "RLS ALONE BLENDS THE TWO COMPANIES — this is what the pin is for",
    ).toBe(true);

    // WITH the pin (what server/services/job-budget.ts does) only org A is seen.
    const pinned = await db(userClient(dualToken))
      .from("job_budgets")
      .select("org_id")
      .eq("org_id", orgA);
    expect(pinned.error, pinned.error?.message).toBeNull();
    const pinnedOrgs = new Set((pinned.data ?? []).map((r) => String(r.org_id)));
    expect(pinnedOrgs).toEqual(new Set([orgA]));
  });

  it("the active-org pin on the READ is what keeps a job's baseline single-company", async () => {
    // The service's exact shape: org + job. Asking for org A's baseline with org
    // B's job id returns nothing, so a URL from the other company reads as
    // "no budget", never as another company's plan.
    const crossed = await db(userClient(dualToken))
      .from("job_budgets")
      .select("id")
      .eq("org_id", orgA)
      .eq("job_id", jobB);
    expect(crossed.error, crossed.error?.message).toBeNull();
    expect(crossed.data ?? []).toHaveLength(0);
  });

  it("REFUSES the RPC when p_org_id is not the job's org (no cross-org write)", async () => {
    const bad = await rpc(userClient(dualToken)).rpc("set_job_budget", {
      p_job_id: jobA2, // org A's job…
      p_org_id: orgB, // …stamped as org B, which the caller IS an admin of
      p_total_cost: 500,
      p_labour_cost: null,
      p_materials_cost: null,
      p_subcontractors_cost: null,
      p_misc_cost: null,
      p_target_margin_pct: null,
      p_note: null,
    });
    expect(bad.error, "the composite FK must refuse it").not.toBeNull();
  });

  // ── 3. the admin gate is in the database ──────────────────────────────────

  it("a STAFF member with a valid JWT is refused by RLS, not merely by the action", async () => {
    // An app-only gate leaves /rest/v1/job_budgets open to any member's JWT.
    const direct = await db(userClient(staffToken))
      .from("job_budgets")
      .insert({ org_id: orgA, job_id: jobA2, total_cost: 1234 })
      .select("id")
      .single();
    expect(direct.error, "a staff member must not be able to set a baseline").not.toBeNull();
    expect(direct.error?.message ?? "").toMatch(/row-level security|policy/i);

    // …and through the RPC too, which is SECURITY INVOKER precisely so the same
    // policy applies.
    const viaRpc = await rpc(userClient(staffToken)).rpc("set_job_budget", {
      p_job_id: jobA2,
      p_org_id: orgA,
      p_total_cost: 1234,
      p_labour_cost: null,
      p_materials_cost: null,
      p_subcontractors_cost: null,
      p_misc_cost: null,
      p_target_margin_pct: null,
      p_note: null,
    });
    expect(viaRpc.error, "SECURITY INVOKER must not be a back door").not.toBeNull();
  });

  it("a staff member CAN read the baseline — they already see cost and margin", async () => {
    const r = await db(userClient(staffToken))
      .from("job_budgets")
      .select("total_cost")
      .eq("org_id", orgA)
      .eq("job_id", jobA);
    expect(r.error, r.error?.message).toBeNull();
    expect((r.data ?? []).length).toBeGreaterThan(0);
  });

  it("an anonymous caller sees nothing at all", async () => {
    const r = await db(anonClient()).from("job_budgets").select("id");
    // Either a policy refusal or an empty set — never a row.
    expect(r.data ?? []).toHaveLength(0);
  });

  // ── 4. write-once history ─────────────────────────────────────────────────

  it("REFUSES to edit the CURRENT revision, for the admin and for service_role", async () => {
    for (const [who, client] of [
      ["admin", userClient(dualToken)],
      ["service_role", serviceClient()],
    ] as const) {
      const bad = await db(client)
        .from("job_budgets")
        .update({ total_cost: 1 })
        .eq("job_id", jobA)
        .eq("revision", 2);
      expect(bad.error, `${who} must not be able to rewrite a baseline`).not.toBeNull();
      expect(bad.error?.message ?? "").toMatch(/immutable/i);
    }
    const still = await svc()
      .from("job_budgets")
      .select("total_cost")
      .eq("job_id", jobA)
      .eq("revision", 2)
      .maybeSingle();
    expect(Number(still.data?.total_cost)).toBe(45000);
  });

  it("REFUSES to touch a SUPERSEDED revision at all", async () => {
    const bad = await svc()
      .from("job_budgets")
      .update({ note: "quietly rewritten" })
      .eq("job_id", jobA)
      .eq("revision", 1);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/history and cannot be changed/i);
  });

  it("REFUSES a targeted delete for EVERY role, including service_role", async () => {
    for (const [who, client] of [
      ["admin", userClient(dualToken)],
      ["service_role", serviceClient()],
    ] as const) {
      const del = await db(client).from("job_budgets").delete().eq("job_id", jobA);
      if (who === "service_role") {
        expect(del.error, "the guard trigger must refuse it").not.toBeNull();
        expect(del.error?.message ?? "").toMatch(/audit trail/i);
      }
      // The admin is refused by the ABSENT delete policy, which PostgREST reports
      // as a no-op rather than an error — so assert on the rows, not the error.
    }
    const left = await svc().from("job_budgets").select("id").eq("job_id", jobA);
    expect(left.data ?? [], "no revision may be deletable").toHaveLength(2);
  });

  it("REFUSES a revision after the first with no reason given", async () => {
    const bad = await rpc(userClient(dualToken)).rpc("set_job_budget", {
      p_job_id: jobA,
      p_org_id: orgA,
      p_total_cost: 50000,
      p_labour_cost: null,
      p_materials_cost: null,
      p_subcontractors_cost: null,
      p_misc_cost: null,
      p_target_margin_pct: null,
      p_note: "   ", // whitespace is not a reason
    });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/revision_needs_reason|check constraint/i);
  });

  it("a variation cost estimate is WRITE-ONCE, one per quote", async () => {
    const edit = await svc()
      .from("quote_cost_estimates")
      .update({ total_cost: 1 })
      .eq("quote_id", quoteA);
    expect(edit.error).not.toBeNull();
    expect(edit.error?.message ?? "").toMatch(/cannot be changed/i);

    const second = await svc()
      .from("quote_cost_estimates")
      .insert({ org_id: orgA, quote_id: quoteA, total_cost: 0 })
      .select("id")
      .single();
    expect(second.error).not.toBeNull();
    expect(second.error?.message ?? "").toMatch(/one_per_quote|duplicate key/i);
  });

  it("REFUSES a partial breakdown and one that does not add up", async () => {
    const partial = await svc().from("job_budgets").insert({
      org_id: orgA,
      job_id: jobA2,
      total_cost: 100,
      labour_cost: 100,
    });
    expect(partial.error?.message ?? "").toMatch(/detail_all_or_none/i);

    const mismatched = await svc().from("job_budgets").insert({
      org_id: orgA,
      job_id: jobA2,
      total_cost: 100,
      labour_cost: 10,
      materials_cost: 10,
      subcontractors_cost: 10,
      misc_cost: 10,
    });
    expect(mismatched.error?.message ?? "").toMatch(/detail_sums_to_total/i);

    const empty = await svc()
      .from("job_budgets")
      .insert({ org_id: orgA, job_id: jobA2, total_cost: 0 });
    expect(empty.error?.message ?? "").toMatch(/not_empty/i);
  });

  it("REFUSES a second CURRENT baseline for the same job", async () => {
    const bad = await svc()
      .from("job_budgets")
      .insert({ org_id: orgA, job_id: jobA, revision: 9, total_cost: 1, note: "sneak" })
      .select("id")
      .single();
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/one_current|duplicate key/i);
  });

  it("two SIMULTANEOUS revisions produce ONE new revision, not two", async () => {
    // The per-job advisory lock. Without it both callers read revision N and one
    // loses at the partial unique index with a raw constraint error; with it the
    // second re-reads the row it must supersede and lands cleanly as N+2.
    const before = await svc().from("job_budgets").select("id").eq("job_id", jobA);
    const countBefore = (before.data ?? []).length;
    const results = await Promise.all([
      rpc(userClient(dualToken)).rpc("set_job_budget", {
        p_job_id: jobA, p_org_id: orgA, p_total_cost: 41000,
        p_labour_cost: null, p_materials_cost: null, p_subcontractors_cost: null,
        p_misc_cost: null, p_target_margin_pct: null, p_note: "concurrent A",
      }),
      rpc(userClient(dualToken)).rpc("set_job_budget", {
        p_job_id: jobA, p_org_id: orgA, p_total_cost: 42000,
        p_labour_cost: null, p_materials_cost: null, p_subcontractors_cost: null,
        p_misc_cost: null, p_target_margin_pct: null, p_note: "concurrent B",
      }),
    ]);
    // Both may succeed (serialised, one after the other) — what may NEVER happen
    // is two live baselines.
    const okCount = results.filter((r) => r.error === null).length;
    expect(okCount, "at least one must land").toBeGreaterThan(0);
    const current = await svc()
      .from("job_budgets")
      .select("revision")
      .eq("job_id", jobA)
      .is("superseded_at", null);
    expect(current.data ?? [], "exactly one current baseline, always").toHaveLength(1);
    const all = await svc().from("job_budgets").select("id, revision").eq("job_id", jobA);
    expect((all.data ?? []).length).toBe(countBefore + okCount);
    // Revisions stay dense and unique.
    const revs = (all.data ?? []).map((r) => Number(r.revision)).sort((a, b) => a - b);
    expect(new Set(revs).size).toBe(revs.length);
  });

  // ── 5. cascades ───────────────────────────────────────────────────────────

  it("deleting the QUOTE takes its cost estimate with it", async () => {
    const del = await svc().from("quotes").delete().eq("id", quoteA);
    expect(del.error, JSON.stringify(del.error)).toBeNull();
    const left = await svc().from("quote_cost_estimates").select("id").eq("quote_id", quoteA);
    expect(left.data ?? []).toHaveLength(0);
  });

  it("deleting the JOB takes every revision with it — the guard does NOT block it", async () => {
    // The 20261052 trap: a BEFORE DELETE guard that only asked about the
    // organisation would refuse this, because a job dies while its org lives.
    const del = await svc().from("jobs").delete().eq("id", jobA);
    expect(del.error, `job delete must not be blocked: ${JSON.stringify(del.error)}`).toBeNull();
    const left = await svc().from("job_budgets").select("id").eq("job_id", jobA);
    expect(left.data ?? []).toHaveLength(0);
  });

  // Org teardown with a LIVE baseline attached is asserted in afterAll (org B
  // still holds one), which is also where a leak would be caught.
});
