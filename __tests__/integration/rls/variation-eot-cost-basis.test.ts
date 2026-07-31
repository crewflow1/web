import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Variation completeness — extension of time + priced cost basis (20261073),
 * against real Postgres.
 *
 * The defect this migration closes was SEMANTIC: the variation form's completion
 * date was written into `quotes.valid_until`, the quote-expiry column. Because
 * the accept gate acts on `valid_until` (it force-writes status='expired'), a
 * variation asking "please let us finish by 30 Sept" quietly became
 * un-acceptable on 1 Oct. The fix gives the extension of time its own columns
 * and leaves `valid_until` meaning only "this offer lapses on".
 *
 * Everything asserted here is a DATABASE invariant rather than an app
 * convention, so the whole suite drives the SERVICE-ROLE client — the most
 * privileged, RLS-bypassing writer there is. If it holds against that, it holds
 * for every app path. The exceptions are the tenant-isolation and dual-org
 * blocks, which need real user JWTs to be meaningful at all.
 *
 * The suite is also a REGRESSION harness for accepted-quote immutability
 * (20261004 / 20261007): this migration edits `tg_quotes_freeze_accepted`, so
 * the money freeze and the accepted_at freeze are re-proved here rather than
 * assumed intact.
 */

type Err = { message: string; code?: string } | null;
type Res<T> = { data: T | null; error: Err };
type Row = Record<string, unknown>;

interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  single(): PromiseLike<Res<Row>>;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
  select(columns?: string): Upd;
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

const T = `it-veot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCEPTED_AT = "2026-01-01T00:00:00.000Z";

describeIntegration("variations · extension of time + cost basis (20261073)", () => {
  const svc = () => db(serviceClient());

  let orgA = "";
  let orgB = "";
  let custA = "";
  let custB = "";
  let jobA = "";
  let jobB = "";
  /** Member of BOTH orgs — the dual-org user the active-org programme exists for. */
  let dual = { id: "", token: "" };
  let n = 0;

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
      .insert({ id, email, full_name: `EoT ${suffix}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    const token = signedIn.data.session?.access_token ?? "";
    if (!id || !token) throw new Error(`failed to mint user ${suffix}`);
    return { id, token };
  }

  async function makeOrg(label: string): Promise<{ org: string; cust: string; job: string }> {
    const o = await svc()
      .from("organizations")
      .insert({ name: `EoT ${label}`, slug: `${T}-${label}` })
      .select("id")
      .single();
    expect(o.error, o.error?.message).toBeNull();
    const org = String(o.data?.id ?? "");

    const c = await svc()
      .from("customers")
      .insert({ org_id: org, name: `Customer ${label}` })
      .select("id")
      .single();
    expect(c.error, c.error?.message).toBeNull();
    const cust = String(c.data?.id ?? "");

    const j = await svc()
      .from("jobs")
      .insert({ org_id: org, customer_id: cust, status: "new" })
      .select("id")
      .single();
    expect(j.error, j.error?.message).toBeNull();
    return { org, cust, job: String(j.data?.id ?? "") };
  }

  /**
   * A variation: a quote row carrying a per-job variation_number. `over` lets a
   * test set the columns under examination without repeating the scaffold.
   */
  async function mkVariation(
    org: string,
    cust: string,
    job: string,
    over: Row = {},
  ): Promise<string> {
    n += 1;
    const q = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: cust,
        job_id: job,
        number: `${T}-V-${n}`,
        variation_number: n,
        status: "draft",
        subtotal: 1000,
        vat_total: 200,
        total: 1200,
        ...over,
      })
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    return String(q.data?.id ?? "");
  }

  /** A plain (non-variation) quote in org A. */
  async function mkQuote(over: Row = {}): Promise<Res<Row>> {
    n += 1;
    return svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: custA,
        number: `${T}-Q-${n}`,
        status: "draft",
        subtotal: 100,
        vat_total: 20,
        total: 120,
        ...over,
      })
      .select("id")
      .single();
  }

  const readVariation = async (id: string): Promise<Row> => {
    const r = await svc()
      .from("quotes")
      .select(
        "id, valid_until, eot_requested_completion_date, eot_agreed_completion_date, eot_agreed_at, eot_agreed_by, cost_labour, cost_materials, cost_subcontractors, cost_misc, cost_total, subtotal, total",
      )
      .eq("id", id)
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return r.data ?? {};
  };

  beforeAll(async () => {
    const a = await makeOrg("a");
    const b = await makeOrg("b");
    orgA = a.org;
    custA = a.cust;
    jobA = a.job;
    orgB = b.org;
    custB = b.cust;
    jobB = b.job;

    dual = await makeUser("dual");
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dual.id, role: "owner" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (dual.id) {
      await svc().from("users").delete().eq("id", dual.id);
      await serviceClient().auth.admin.deleteUser(dual.id).catch(() => undefined);
    }
  });

  // ── The EoT columns mean what they say ─────────────────────────────────────
  it("stores a requested completion date WITHOUT touching valid_until", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      eot_requested_completion_date: "2026-09-30",
    });
    const row = await readVariation(v);
    expect(row.eot_requested_completion_date).toBe("2026-09-30");
    // The defect, as an invariant: a completion date is not an expiry.
    expect(row.valid_until).toBeNull();
  });

  it("REJECTS an extension of time on a plain quote (nothing to extend)", async () => {
    const bad = await mkQuote({ eot_requested_completion_date: "2026-09-30" });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/quotes_eot_variation_only|violates check/i);
  });

  it("REJECTS an agreed date with no record of when it was agreed", async () => {
    const v = await mkVariation(orgA, custA, jobA);
    const bad = await svc()
      .from("quotes")
      .update({ eot_agreed_completion_date: "2026-10-15" })
      .eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/quotes_eot_agreed_audited|violates check/i);
  });

  it("ACCEPTS an agreed date carrying its audit stamp", async () => {
    const v = await mkVariation(orgA, custA, jobA);
    const ok = await svc()
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-10-15",
        eot_agreed_at: new Date().toISOString(),
        eot_agreed_by: dual.id,
      })
      .eq("id", v);
    expect(ok.error, ok.error?.message).toBeNull();
    const row = await readVariation(v);
    expect(row.eot_agreed_completion_date).toBe("2026-10-15");
    expect(row.eot_agreed_by).toBe(dual.id);
  });

  it("keeps requested and agreed as SEPARATE facts (agreeing a different date does not rewrite the request)", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      eot_requested_completion_date: "2026-09-30",
    });
    await svc()
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-10-20",
        eot_agreed_at: new Date().toISOString(),
      })
      .eq("id", v);
    const row = await readVariation(v);
    // What you asked for and what you got are both evidence. A single column
    // could not hold both, which is how the original defect started.
    expect(row.eot_requested_completion_date).toBe("2026-09-30");
    expect(row.eot_agreed_completion_date).toBe("2026-10-20");
  });

  // ── The cost basis is a single, non-divergent number ───────────────────────
  it("cost_total is NULL while no basis is recorded (not 0 — a different fact)", async () => {
    const v = await mkVariation(orgA, custA, jobA);
    const row = await readVariation(v);
    expect(row.cost_total).toBeNull();
  });

  it("cost_total is GENERATED from the four parts, so they cannot disagree", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      cost_labour: 400,
      cost_materials: 300,
      cost_subcontractors: 200,
      cost_misc: 100,
    });
    const row = await readVariation(v);
    expect(Number(row.cost_total)).toBe(1000);

    // And it tracks any later change to a part.
    await svc().from("quotes").update({ cost_misc: 150 }).eq("id", v);
    expect(Number((await readVariation(v)).cost_total)).toBe(1050);
  });

  it("REFUSES a direct write to cost_total (no second source of truth)", async () => {
    const v = await mkVariation(orgA, custA, jobA, { cost_labour: 100 });
    const bad = await svc().from("quotes").update({ cost_total: 9999 }).eq("id", v);
    expect(bad.error).not.toBeNull();
    // Postgres' generated-column refusal, as PostgREST relays it.
    expect(bad.error?.message ?? "").toMatch(
      /cost_total.*can only be updated to DEFAULT|generated column/i,
    );
  });

  it("REJECTS a negative cost", async () => {
    const v = await mkVariation(orgA, custA, jobA);
    const bad = await svc().from("quotes").update({ cost_labour: -1 }).eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/quotes_cost_basis_non_negative|violates check/i);
  });

  it("records a zero cost basis distinctly from an absent one", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      cost_labour: 0,
      cost_materials: 0,
      cost_subcontractors: 0,
      cost_misc: 0,
    });
    const row = await readVariation(v);
    expect(Number(row.cost_total)).toBe(0);
    expect(row.cost_total).not.toBeNull();
  });

  // ── REGRESSION: accepted-quote immutability (20261004 / 20261007) ──────────
  it("REGRESSION · an accepted variation's amounts are still frozen", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
    });
    const bad = await svc().from("quotes").update({ total: 5000 }).eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("REGRESSION · accepted_at still cannot be cleared to re-open the record", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
    });
    const bad = await svc().from("quotes").update({ accepted_at: null }).eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("REGRESSION · a DRAFT variation stays fully editable (the freeze is still narrow)", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      eot_requested_completion_date: "2026-09-30",
      cost_labour: 100,
    });
    const ok = await svc()
      .from("quotes")
      .update({
        total: 999,
        subtotal: 800,
        vat_total: 199,
        eot_requested_completion_date: "2026-11-30",
        cost_labour: 250,
      })
      .eq("id", v);
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("REGRESSION · the revised-contract-value inputs are unchanged by this migration", async () => {
    // /jobs/[id] sums ACCEPTED variations' `total` into the revised contract
    // value. Prove the three money columns still round-trip untouched through an
    // accept, because that sum is what an owner reads as "what's this worth now".
    const v = await mkVariation(orgA, custA, jobA, {
      status: "sent",
      subtotal: 1333.33,
      vat_total: 266.67,
      total: 1600,
      cost_labour: 1000,
      eot_requested_completion_date: "2026-09-30",
    });
    const accept = await svc()
      .from("quotes")
      .update({ status: "accepted", accepted_at: ACCEPTED_AT })
      .eq("id", v);
    expect(accept.error, accept.error?.message).toBeNull();
    const row = await readVariation(v);
    expect(Number(row.subtotal)).toBe(1333.33);
    expect(Number(row.total)).toBe(1600);
    // Margin is derived, and derivable: 1600-inc revenue on 1000 cost.
    expect(Number(row.cost_total)).toBe(1000);
    expect(Math.round(((1333.33 - 1000) / 1333.33) * 100)).toBe(25);
  });

  // ── The freeze extension: write-once, not immovable ───────────────────────
  it("REJECTS rewriting a recorded requested completion date after acceptance", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      eot_requested_completion_date: "2026-08-01",
    });
    const bad = await svc()
      .from("quotes")
      .update({ eot_requested_completion_date: "2026-12-01" })
      .eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("REJECTS rewriting a recorded cost basis after acceptance", async () => {
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      cost_labour: 400,
    });
    const bad = await svc().from("quotes").update({ cost_labour: 1 }).eq("id", v);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("ALLOWS recording the AGREED extension after acceptance — that is the whole point", async () => {
    // An EoT is determined after the money is agreed. If the freeze covered
    // these columns the feature could never be used on a real variation.
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      eot_requested_completion_date: "2026-08-01",
    });
    const ok = await svc()
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-09-15",
        eot_agreed_at: new Date().toISOString(),
        eot_agreed_by: dual.id,
      })
      .eq("id", v);
    expect(ok.error, ok.error?.message).toBeNull();
    expect((await readVariation(v)).eot_agreed_completion_date).toBe("2026-09-15");
  });

  it("ALLOWS completing an UNRECORDED cost part once after acceptance, then freezes it", async () => {
    // Every variation raised before this migration has NULL here. A NULL→value
    // write is a data completion; value→value is a rewrite of an agreed margin.
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      cost_labour: 400,
    });
    const fill = await svc().from("quotes").update({ cost_materials: 50 }).eq("id", v);
    expect(fill.error, fill.error?.message).toBeNull();
    expect(Number((await readVariation(v)).cost_total)).toBe(450);

    const rewrite = await svc().from("quotes").update({ cost_materials: 60 }).eq("id", v);
    expect(rewrite.error).not.toBeNull();
    expect(rewrite.error?.message ?? "").toMatch(/frozen/i);
  });

  // ── Legacy-row remediation ────────────────────────────────────────────────
  it("an ACCEPTED legacy variation can have its misfiled date reclassified", async () => {
    // The exact write reclassifyVariationValidUntilAsEot performs. It has to
    // work on accepted rows: those are the ones the defect trapped, because a
    // past valid_until makes them permanently un-acceptable.
    const v = await mkVariation(orgA, custA, jobA, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      valid_until: "2026-08-01",
    });
    const ok = await svc()
      .from("quotes")
      .update({ eot_requested_completion_date: "2026-08-01", valid_until: null })
      .eq("id", v);
    expect(ok.error, ok.error?.message).toBeNull();
    const row = await readVariation(v);
    expect(row.eot_requested_completion_date).toBe("2026-08-01");
    expect(row.valid_until).toBeNull();

    // ...and once reclassified it is write-once like any other recorded request.
    const bad = await svc()
      .from("quotes")
      .update({ eot_requested_completion_date: "2027-01-01" })
      .eq("id", v);
    expect(bad.error).not.toBeNull();
  });

  // ── Tenant isolation + the dual-org (active-org) proof ─────────────────────
  it("a signed-in member cannot read another org's variation EoT at all", async () => {
    const vB = await mkVariation(orgB, custB, jobB, {
      eot_requested_completion_date: "2026-09-30",
    });
    // The dual-org user IS a member of B, so use a fresh single-org user to
    // prove the outer boundary still holds.
    const outsider = await makeUser("outsider");
    const outsiderOrg = await makeOrg("outsider-org");
    await svc()
      .from("memberships")
      .insert({ org_id: outsiderOrg.org, user_id: outsider.id, role: "owner" });

    const read = await db(userClient(outsider.token))
      .from("quotes")
      .select("id, eot_requested_completion_date")
      .eq("id", vB);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data ?? []).toHaveLength(0);

    await svc().from("organizations").delete().eq("id", outsiderOrg.org);
    await svc().from("users").delete().eq("id", outsider.id);
    await serviceClient().auth.admin.deleteUser(outsider.id).catch(() => undefined);
  });

  it("DUAL-ORG · RLS alone does NOT scope the write — the active-org predicate does", async () => {
    // The active-org defect class in one test. `current_org_ids()` returns EVERY
    // org the viewer belongs to, so for a member of both A and B, RLS happily
    // permits an EoT write against B's variation while the user works in A.
    const vB = await mkVariation(orgB, custB, jobB);
    const tenant = db(userClient(dual.token));

    const rlsOnly = await tenant
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-10-31",
        eot_agreed_at: new Date().toISOString(),
      })
      .eq("id", vB)
      .select("id");
    expect(rlsOnly.error, rlsOnly.error?.message).toBeNull();
    // This is the proof that RLS is the OUTER boundary, not the inner one: the
    // row was written purely on membership.
    expect(rlsOnly.data ?? []).toHaveLength(1);
  });

  it("DUAL-ORG · with org_id pinned to the ACTIVE org, the foreign write matches nothing", async () => {
    // What recordVariationEotAgreement actually issues: .eq("id", …).eq("org_id",
    // ctx.org.id). Active org is A; the variation is in B; zero rows affected —
    // indistinguishable from a row that does not exist, exactly as the load-side
    // chokepoint behaves.
    const vB = await mkVariation(orgB, custB, jobB);
    const tenant = db(userClient(dual.token));

    const scoped = await tenant
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-10-31",
        eot_agreed_at: new Date().toISOString(),
      })
      .eq("id", vB)
      .eq("org_id", orgA)
      .select("id");
    expect(scoped.error, scoped.error?.message).toBeNull();
    expect(scoped.data ?? []).toHaveLength(0);

    const untouched = await readVariation(vB);
    expect(untouched.eot_agreed_completion_date).toBeNull();
  });

  it("DUAL-ORG · the same pin lets the write through in the org that owns the row", async () => {
    const vA = await mkVariation(orgA, custA, jobA);
    const scoped = await db(userClient(dual.token))
      .from("quotes")
      .update({
        eot_agreed_completion_date: "2026-11-30",
        eot_agreed_at: new Date().toISOString(),
        eot_agreed_by: dual.id,
      })
      .eq("id", vA)
      .eq("org_id", orgA)
      .select("id");
    expect(scoped.error, scoped.error?.message).toBeNull();
    expect(scoped.data ?? []).toHaveLength(1);
    expect((await readVariation(vA)).eot_agreed_completion_date).toBe("2026-11-30");
  });

  // ── Org teardown stays possible ───────────────────────────────────────────
  it("org teardown still cascades with EoT + cost data present (no RESTRICT introduced)", async () => {
    const doomed = await makeOrg("doomed");
    await mkVariation(doomed.org, doomed.cust, doomed.job, {
      status: "accepted",
      accepted_at: ACCEPTED_AT,
      eot_requested_completion_date: "2026-09-30",
      eot_agreed_completion_date: "2026-10-15",
      eot_agreed_at: ACCEPTED_AT,
      eot_agreed_by: dual.id,
      cost_labour: 400,
      cost_materials: 300,
    });

    const del = await svc().from("organizations").delete().eq("id", doomed.org);
    expect(del.error, del.error?.message).toBeNull();

    const gone = await svc().from("quotes").select("id").eq("org_id", doomed.org);
    expect(gone.data ?? []).toHaveLength(0);
  });

  it("deleting the user who recorded an agreement nulls the stamp, never blocks the delete", async () => {
    // The 20261052 lesson: a guard that refuses the UPDATE Postgres uses to
    // implement `on delete set null` makes personal data undeletable.
    const agreer = await makeUser("agreer");
    const v = await mkVariation(orgA, custA, jobA, {
      eot_agreed_completion_date: "2026-10-15",
      eot_agreed_at: ACCEPTED_AT,
      eot_agreed_by: agreer.id,
    });

    const del = await svc().from("users").delete().eq("id", agreer.id);
    expect(del.error, del.error?.message).toBeNull();

    const row = await readVariation(v);
    expect(row.eot_agreed_by).toBeNull();
    // The agreed date itself survives — it is a contractual fact, not personal data.
    expect(row.eot_agreed_completion_date).toBe("2026-10-15");
    await serviceClient().auth.admin.deleteUser(agreer.id).catch(() => undefined);
  });
});
