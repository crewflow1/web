import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * O3 OPERATIONAL STOCK against real Postgres
 * (migrations 20261063000000 + 20261064000000 + 20261065000000).
 *
 * The headline proofs in this file:
 *
 *   · THE ACCOUNTING BOUNDARY — a full receive → issue → transfer → adjust
 *     cycle writes NOT ONE `finances` row. This is the invariant that let the
 *     milestone ship while CEO decision D1 (stock valuation) is undecided:
 *     materials are already expensed by the supplier bill, so a second posting
 *     would double-count the same spend against the same job;
 *   · the DUAL-ORG pair — a user who belongs to org A AND org B passes RLS for
 *     both, so an RLS-only read blends two companies' yards into one balance.
 *     Every RPC refuses the other company's item, site and movement even with a
 *     crafted id, and the pin is proven LOAD-BEARING by stripping it;
 *   · NEGATIVE STOCK is refused, and the check is serialised — two simultaneous
 *     issues of the last 10 units produce exactly one movement;
 *   · GRN → stock is IDEMPOTENT (two retries → one movement) and refuses a
 *     delivery that has not been posted;
 *   · a GRN with stock against it CANNOT be voided until the stock receipt has
 *     been corrected — the rule 20261065000000's header sets out;
 *   · TRANSFER CONSERVATION — the company total is identical before and after;
 *   · APPEND-ONLY — no update, no delete, for any role including service_role;
 *   · ADJUSTMENT is admin-only;
 *   · ORG TEARDOWN still works with a full ledger present (the deferred-FK
 *     decision in 20261064000000's header).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
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

const TOKEN = `it-stock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("operational stock · boundary, isolation, concurrency, immutability", () => {
  let orgA = "";
  let orgB = "";
  let itemA = "";
  let itemB = "";
  let depotA = "";
  let yardA = "";
  let siteB = "";
  let jobA = "";
  let jobB = "";
  let poA = "";
  let poLineA = "";
  let grnLineA = "";
  let dualUserId = "";
  let dualToken = "";
  let memberUserId = "";
  let memberToken = "";
  let outsiderId = "";
  let outsiderToken = "";

  const svc = () => db(serviceClient());

  const balance = async (org: string, item: string, site: string): Promise<number> => {
    const r = await rpc(serviceClient()).rpc("stock_balance", {
      p_org_id: org,
      p_item_id: item,
      p_site_id: site,
    });
    return Number(r.data ?? 0);
  };

  const companyTotal = async (org: string): Promise<number> => {
    const r = await svc().from("stock_movements").select("effect").eq("org_id", org);
    return (r.data ?? []).reduce((acc, m) => acc + Number(m.effect ?? 0), 0);
  };

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
      .insert({ id, email, full_name: `Stock ${suffix}` })
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
    const org = await svc().from("organizations").insert({ name, slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    return String(org.data?.id ?? "");
  }

  async function makeSite(org: string, name: string): Promise<string> {
    const r = await svc()
      .from("sites")
      .insert({ org_id: org, name, kind: "depot" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeItem(org: string, name: string): Promise<string> {
    const r = await svc()
      .from("stock_items")
      .insert({ org_id: org, name, unit: "ea", reorder_level: 20 })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function makeJob(org: string): Promise<string> {
    const r = await svc().from("jobs").insert({ org_id: org, status: "new" }).select("id").single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = await makeOrg("Stock Probe A", `${TOKEN}-a`);
    orgB = await makeOrg("Stock Probe B", `${TOKEN}-b`);

    // DELIBERATELY IDENTICAL names in both orgs — a leak has to be a real
    // confusion, not something a human would spot instantly.
    depotA = await makeSite(orgA, "Main yard");
    yardA = await makeSite(orgA, "Lock-up");
    siteB = await makeSite(orgB, "Main yard");
    itemA = await makeItem(orgA, "Blocks 100mm");
    itemB = await makeItem(orgB, "Blocks 100mm");
    jobA = await makeJob(orgA);
    jobB = await makeJob(orgB);

    const dual = await makeUser("dual");
    dualUserId = dual.id;
    dualToken = dual.token;
    const member = await makeUser("member");
    memberUserId = member.id;
    memberToken = member.token;
    const outsider = await makeUser("outsider");
    outsiderId = outsider.id;
    outsiderToken = outsider.token;

    // THE dual-org membership: this user legitimately belongs to A and B, as an
    // ADMIN of both — the strongest tenant role, so nothing below passes merely
    // because the user was under-privileged.
    for (const org of [orgA, orgB]) {
      const m = await svc()
        .from("memberships")
        .insert({ org_id: org, user_id: dualUserId, role: "admin" })
        .select("user_id")
        .single();
      expect(m.error, m.error?.message).toBeNull();
    }
    // A plain member of org A — for the admin-only adjustment gate.
    const mm = await svc()
      .from("memberships")
      .insert({ org_id: orgA, user_id: memberUserId, role: "staff" })
      .select("user_id")
      .single();
    expect(mm.error, mm.error?.message).toBeNull();

    // A SENT purchase order in org A with one 100-unit line, received 40.
    const po = await svc()
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `${TOKEN}-PO`, status: "sent", subtotal: 100, vat_total: 20 })
      .select("id")
      .single();
    expect(po.error, po.error?.message).toBeNull();
    poA = String(po.data?.id ?? "");
    const li = await svc()
      .from("purchase_order_line_items")
      .insert({
        org_id: orgA,
        purchase_order_id: poA,
        description: "Blocks 100mm x100",
        qty: 100,
        unit: "ea",
        unit_price: 1,
        vat_rate: 20,
        line_total: 100,
        sort_order: 0,
      })
      .select("id")
      .single();
    expect(li.error, li.error?.message).toBeNull();
    poLineA = String(li.data?.id ?? "");

    const posted = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: poA,
      p_delivery_date: "2026-07-28",
      p_delivery_note_reference: "DN-STOCK-1",
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: poLineA, qty_received: 40 }],
    });
    expect(posted.error, posted.error?.message).toBeNull();

    const line = await svc()
      .from("goods_received_lines")
      .select("id")
      .eq("purchase_order_line_item_id", poLineA)
      .maybeSingle();
    grnLineA = String(line.data?.id ?? "");
    expect(grnLineA).not.toBe("");
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
    for (const id of [dualUserId, memberUserId, outsiderId]) {
      if (id) await serviceClient().auth.admin.deleteUser(id);
    }
  });

  // ── baseline RLS ──────────────────────────────────────────────────────────
  it("anon is denied both stock tables and the balances view", async () => {
    for (const t of ["stock_items", "stock_movements", "stock_balances"]) {
      const { data, error } = await db(anonClient()).from(t).select("*");
      expect(error ? true : (data ?? []).length === 0, `${t} leaked to anon`).toBe(true);
    }
  });

  it("an authenticated NON-member cannot see or move org A's stock", async () => {
    const seen = await db(userClient(outsiderToken)).from("stock_items").select("id").eq("org_id", orgA);
    expect(seen.data ?? []).toHaveLength(0);

    const { error } = await rpc(userClient(outsiderToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: 1,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not found/i);
  });

  // ── the GRN → stock bridge ────────────────────────────────────────────────
  it("takes a POSTED delivery line into stock at the quantity the evidence says", async () => {
    const { data, error } = await rpc(userClient(dualToken)).rpc("record_stock_receipt_from_grn", {
      p_org_id: orgA, // ACTIVE-ORG PIN
      p_grn_line_id: grnLineA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_notes: null,
    });
    expect(error, error?.message).toBeNull();
    expect(typeof data).toBe("string");
    expect(await balance(orgA, itemA, depotA)).toBe(40);
  });

  it("is IDEMPOTENT — two retries produce ONE movement and the SAME id", async () => {
    // The double tap in a yard with one bar of signal. The partial unique index
    // is the real guard; the RPC turns the second attempt into a success.
    const first = await rpc(userClient(dualToken)).rpc("record_stock_receipt_from_grn", {
      p_org_id: orgA,
      p_grn_line_id: grnLineA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_notes: null,
    });
    const second = await rpc(userClient(dualToken)).rpc("record_stock_receipt_from_grn", {
      p_org_id: orgA,
      // even naming a DIFFERENT site: the line is already in stock, and the
      // answer is the movement that exists, not a second one.
      p_grn_line_id: grnLineA,
      p_item_id: itemA,
      p_site_id: yardA,
      p_notes: null,
    });
    expect(first.error, first.error?.message).toBeNull();
    expect(second.error, second.error?.message).toBeNull();
    expect(second.data).toBe(first.data);

    const receipts = await svc()
      .from("stock_movements")
      .select("id")
      .eq("org_id", orgA)
      .eq("movement_type", "receipt");
    expect(receipts.data ?? []).toHaveLength(1);
    expect(await balance(orgA, itemA, depotA)).toBe(40);
    expect(await balance(orgA, itemA, yardA)).toBe(0);
  });

  it("REFUSES a delivery line from ANOTHER company even with a crafted id", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("record_stock_receipt_from_grn", {
      p_org_id: orgB, // the caller IS an admin of B, so RLS alone would allow this
      p_grn_line_id: grnLineA, // …but the line belongs to A
      p_item_id: itemB,
      p_site_id: siteB,
      p_notes: null,
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not found/i);
  });

  it("REFUSES to take another company's ITEM or SITE into this company's stock", async () => {
    for (const [item, site] of [
      [itemB, depotA],
      [itemA, siteB],
    ] as const) {
      const { error } = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
        p_org_id: orgA,
        p_item_id: item,
        p_site_id: site,
        p_qty: 1,
        p_job_id: null,
        p_material_request_line_id: null,
        p_notes: null,
      });
      expect(error, `item ${item} / site ${site} was accepted`).not.toBeNull();
      expect(error?.message ?? "").toMatch(/not found/i);
    }
  });

  // ── DEPOT-ONLY: a job-tagged PO cannot enter stock (COGS double-count fix) ──
  it("REFUSES to take a JOB-TAGGED purchase order's delivery into stock", async () => {
    // The S1 the COGS wiring's adversarial review found: a job-tagged PO gets
    // billed to its job (recordSupplierBill copies po.job_id) AND, if stocked and
    // issued back to the job, allocates the SAME spend again as COGS — ~2x
    // materials. Migration 20261212 refuses the stock receipt for a job-tagged PO,
    // so the two paths are disjoint by construction. Prove the refusal live.
    const po = await svc()
      .from("purchase_orders")
      .insert({
        org_id: orgA,
        number: `${TOKEN}-PO-JOB`,
        status: "sent",
        subtotal: 50,
        vat_total: 10,
        job_id: jobA, // ← tagged to a job: this must NOT be stockable
      })
      .select("id")
      .single();
    expect(po.error, po.error?.message).toBeNull();
    const jobPoId = String(po.data?.id ?? "");

    const li = await svc()
      .from("purchase_order_line_items")
      .insert({
        org_id: orgA,
        purchase_order_id: jobPoId,
        description: "Job-direct blocks",
        qty: 20,
        unit: "ea",
        unit_price: 2.5,
        vat_rate: 20,
        line_total: 50,
        sort_order: 0,
      })
      .select("id")
      .single();
    expect(li.error, li.error?.message).toBeNull();
    const jobPoLineId = String(li.data?.id ?? "");

    const posted = await rpc(userClient(dualToken)).rpc("post_goods_received_note", {
      p_org_id: orgA,
      p_purchase_order_id: jobPoId,
      p_delivery_date: "2026-07-29",
      p_delivery_note_reference: "DN-JOB-1",
      p_delivery_location: null,
      p_notes: null,
      p_received_by: dualUserId,
      p_lines: [{ line_item_id: jobPoLineId, qty_received: 20 }],
    });
    expect(posted.error, posted.error?.message).toBeNull();

    const grn = await svc()
      .from("goods_received_lines")
      .select("id")
      .eq("purchase_order_line_item_id", jobPoLineId)
      .maybeSingle();
    const jobGrnLineId = String(grn.data?.id ?? "");
    expect(jobGrnLineId).not.toBe("");

    // The receipt into stock is REFUSED because the PO carries a job_id.
    const { data, error } = await rpc(userClient(dualToken)).rpc(
      "record_stock_receipt_from_grn",
      {
        p_org_id: orgA,
        p_grn_line_id: jobGrnLineId,
        p_item_id: itemA,
        p_site_id: depotA,
        p_notes: null,
      },
    );
    expect(error, "a job-tagged PO was allowed into stock — double-count reachable").not.toBeNull();
    expect(error?.message ?? "").toMatch(/for a specific job/i);
    expect(data ?? null).toBeNull();

    // Belt to braces: NO receipt movement exists for that GRN line — nothing was
    // written before the refusal, so the depot pool never held this job's goods.
    const moved = await svc()
      .from("stock_movements")
      .select("id")
      .eq("org_id", orgA)
      .eq("grn_line_id", jobGrnLineId);
    expect((moved.data ?? []).length, "a movement leaked past the depot-only guard").toBe(0);
  });

  // ── THE ACCOUNTING BOUNDARY ───────────────────────────────────────────────
  it("a FULL cycle writes NOT ONE `finances` row", async () => {
    const before = await svc().from("finances").select("id").eq("org_id", orgA);
    const beforeCount = (before.data ?? []).length;

    // issue → to a job → transfer → adjust: every write path this milestone has
    const issued = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: 10,
      p_job_id: jobA,
      p_material_request_line_id: null,
      p_notes: "first fix",
    });
    expect(issued.error, issued.error?.message).toBeNull();

    const moved = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: yardA,
      p_qty: 5,
      p_notes: null,
    });
    expect(moved.error, moved.error?.message).toBeNull();

    const adjusted = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_delta: -2,
      p_reason: "two broken in the racking",
    });
    expect(adjusted.error, adjusted.error?.message).toBeNull();

    const after = await svc().from("finances").select("id").eq("org_id", orgA);
    expect(
      (after.data ?? []).length,
      "a stock movement posted a cost — materials would be counted twice",
    ).toBe(beforeCount);

    // 40 received − 10 issued − 5 transferred out − 2 written off = 23 at depot
    expect(await balance(orgA, itemA, depotA)).toBe(23);
    expect(await balance(orgA, itemA, yardA)).toBe(5);
  });

  it("the ISSUE carries its job as PROVENANCE, and the job's cost is untouched", async () => {
    const issue = await svc()
      .from("stock_movements")
      .select("job_id, effect, material_request_line_id")
      .eq("org_id", orgA)
      .eq("movement_type", "issue")
      .maybeSingle();
    expect(issue.data?.job_id).toBe(jobA);
    expect(Number(issue.data?.effect)).toBe(-10);
    // the FROZEN CONTRACT column exists and is null until the M4 lane sets it
    expect(issue.data?.material_request_line_id).toBeNull();

    const costs = await svc().from("finances").select("id").eq("job_id", jobA);
    expect((costs.data ?? []).length, "issuing to a job must post no cost").toBe(0);
  });

  it("REFUSES a job from another company as provenance", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: 1,
      p_job_id: jobB, // org B's job
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/is not in org/i);
  });

  // ── transfer conservation ─────────────────────────────────────────────────
  it("a transfer CONSERVES the company total and links the pair", async () => {
    const before = await companyTotal(orgA);
    const { data, error } = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: yardA,
      p_qty: 3,
      p_notes: null,
    });
    expect(error, error?.message).toBeNull();
    expect(await companyTotal(orgA)).toBe(before); // nothing created, nothing lost

    const pair = await svc()
      .from("stock_movements")
      .select("movement_type, effect, site_id")
      .eq("transfer_group_id", String(data));
    expect(pair.data ?? []).toHaveLength(2);
    expect((pair.data ?? []).reduce((a, r) => a + Number(r.effect ?? 0), 0)).toBe(0);
  });

  it("REFUSES a transfer to the same place, and to another company's place", async () => {
    const same = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: depotA,
      p_qty: 1,
      p_notes: null,
    });
    expect(same.error?.message ?? "").toMatch(/two different sites/i);

    const cross = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_from_site_id: depotA,
      p_to_site_id: siteB, // org B's yard
      p_qty: 1,
      p_notes: null,
    });
    expect(cross.error?.message ?? "").toMatch(/not found/i);
  });

  // ── negative stock + the race ─────────────────────────────────────────────
  it("REFUSES to issue more than is there", async () => {
    const have = await balance(orgA, itemA, depotA);
    const { error } = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: have + 0.01,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/not enough/i);
    expect(await balance(orgA, itemA, depotA)).toBe(have);
  });

  it("TWO SIMULTANEOUS issues of the last units: exactly ONE succeeds", async () => {
    // The double-submitted form, or two operators at two doors. Without the
    // per-(item, site) advisory lock both read the same balance, both pass the
    // check and both commit — the site ends negative. With it, the loser reads
    // the post-commit balance and is refused. (The deterministic two-session
    // psql proof, plus the lock-removed counterfactual that lands at -10, is in
    // docs/operational-stock.md; this is the same race through the real API.)
    const race = await svc()
      .from("stock_items")
      .insert({ org_id: orgA, name: `${TOKEN} Race item`, unit: "ea" })
      .select("id")
      .single();
    const raceItem = String(race.data?.id ?? "");

    const seed = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: raceItem,
      p_site_id: depotA,
      p_delta: 10,
      p_reason: "opening count",
    });
    expect(seed.error, seed.error?.message).toBeNull();

    const attempt = () =>
      rpc(userClient(dualToken)).rpc("record_stock_issue", {
        p_org_id: orgA,
        p_item_id: raceItem,
        p_site_id: depotA,
        p_qty: 10,
        p_job_id: null,
        p_material_request_line_id: null,
        p_notes: null,
      });

    const [one, two] = await Promise.all([attempt(), attempt()]);
    const succeeded = [one, two].filter((r) => r.error === null);
    const refused = [one, two].filter((r) => r.error !== null);

    expect(succeeded, "both issues of the last 10 units succeeded").toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error?.message ?? "").toMatch(/not enough/i);
    expect(await balance(orgA, raceItem, depotA)).toBe(0);

    const issues = await svc()
      .from("stock_movements")
      .select("id")
      .eq("stock_item_id", raceItem)
      .eq("movement_type", "issue");
    expect(issues.data ?? []).toHaveLength(1);
  });

  // ── adjustments are admin-only ────────────────────────────────────────────
  it("a plain MEMBER cannot adjust stock; an admin can", async () => {
    const denied = await rpc(userClient(memberToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_delta: 1000,
      p_reason: "found a pallet",
    });
    expect(denied.error).not.toBeNull();
    expect(denied.error?.message ?? "").toMatch(/owner or admin/i);

    const allowed = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_delta: 1,
      p_reason: "one back off the van",
    });
    expect(allowed.error, allowed.error?.message).toBeNull();
  });

  it("an adjustment with NO reason is refused, and a zero one changes nothing", async () => {
    for (const args of [
      { p_delta: 5, p_reason: "   " },
      { p_delta: 0, p_reason: "nothing to say" },
    ]) {
      const { error } = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
        p_org_id: orgA,
        p_item_id: itemA,
        p_site_id: depotA,
        ...args,
      });
      expect(error, `${JSON.stringify(args)} was accepted`).not.toBeNull();
    }
  });

  it("a member CAN still issue and transfer — only adjusting is gated", async () => {
    const { error } = await rpc(userClient(memberToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: 1,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(error, error?.message).toBeNull();
  });

  // ── append-only ───────────────────────────────────────────────────────────
  it("a movement is IMMUTABLE and UNDELETABLE — even for service_role", async () => {
    const mv = await svc()
      .from("stock_movements")
      .select("id")
      .eq("org_id", orgA)
      .eq("movement_type", "receipt")
      .maybeSingle();
    const id = String(mv.data?.id ?? "");
    expect(id).not.toBe("");

    // service_role bypasses RLS entirely — if the trigger holds here it holds
    // everywhere.
    const upd = await svc().from("stock_movements").update({ qty: 999 }).eq("id", id);
    expect(upd.error).not.toBeNull();
    expect(upd.error?.message ?? "").toMatch(/immutable/i);

    const del = await svc().from("stock_movements").delete().eq("id", id);
    expect(del.error).not.toBeNull();
    expect(del.error?.message ?? "").toMatch(/append-only/i);

    const still = await svc().from("stock_movements").select("qty").eq("id", id).maybeSingle();
    expect(Number(still.data?.qty)).toBe(40);
  });

  it("the SIGN cannot be forged — the trigger overwrites whatever is supplied", async () => {
    const forged = await svc()
      .from("stock_movements")
      .insert({
        org_id: orgA,
        stock_item_id: itemA,
        site_id: depotA,
        movement_type: "issue",
        qty: 1,
        effect: 999, // an issue that ADDS 999 — if this stuck, stock is fiction
      })
      .select("effect")
      .single();
    expect(forged.error, forged.error?.message).toBeNull();
    expect(Number(forged.data?.effect)).toBe(-1);
  });

  it("a CROSS-TENANT movement is unwritable for EVERY role (composite FK)", async () => {
    // org B's item, claimed as org A's.
    const { error } = await svc()
      .from("stock_movements")
      .insert({
        org_id: orgA,
        stock_item_id: itemB,
        site_id: depotA,
        movement_type: "receipt",
        qty: 1,
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503"); // foreign_key_violation
  });

  // ── corrections ───────────────────────────────────────────────────────────
  it("a CORRECTION reverses the whole movement, keeps both rows, and cannot repeat", async () => {
    const issue = await rpc(userClient(dualToken)).rpc("record_stock_issue", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_qty: 4,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: "wrong item picked",
    });
    expect(issue.error, issue.error?.message).toBeNull();
    const issueId = String(issue.data);
    const after = await balance(orgA, itemA, depotA);

    const corrected = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issueId,
      p_reason: "picked the wrong pallet",
    });
    expect(corrected.error, corrected.error?.message).toBeNull();
    expect(await balance(orgA, itemA, depotA)).toBe(after + 4);

    // BOTH rows survive — the original is not rewritten
    const both = await svc()
      .from("stock_movements")
      .select("id, movement_type, effect, corrects_movement_id")
      .eq("org_id", orgA)
      .eq("stock_item_id", itemA);
    const original = (both.data ?? []).find((r) => r.id === issueId);
    const reversal = (both.data ?? []).find((r) => r.corrects_movement_id === issueId);
    expect(Number(original?.effect)).toBe(-4);
    expect(Number(reversal?.effect)).toBe(4);
    expect(reversal?.movement_type).toBe("correction");

    // and it can only happen once
    const again = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: issueId,
      p_reason: "again",
    });
    expect(again.error).not.toBeNull();

    // a correction of a correction is refused outright
    const meta = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: String(reversal?.id ?? ""),
      p_reason: "no",
    });
    expect(meta.error).not.toBeNull();
    expect(meta.error?.message ?? "").toMatch(/cannot be corrected/i);
  });

  it("a correction needs a reason, and refuses another company's movement", async () => {
    // There are several transfer_in rows by now, so take the first rather than
    // maybeSingle() (which errors on more than one and would test nothing).
    const rows = await svc()
      .from("stock_movements")
      .select("id")
      .eq("org_id", orgA)
      .eq("movement_type", "transfer_in");
    const movementId = String((rows.data ?? [])[0]?.id ?? "");
    expect(movementId, "no transfer_in movement to correct").not.toBe("");

    const noReason = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: movementId,
      p_reason: "  ",
    });
    expect(noReason.error?.message ?? "").toMatch(/reason/i);

    // pinned to B, naming A's movement — the caller is an admin of BOTH
    const cross = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgB,
      p_movement_id: movementId,
      p_reason: "cross-tenant attempt",
    });
    expect(cross.error?.message ?? "").toMatch(/not found/i);
  });

  // ── transfer-leg correction manufactures stock (P1-A, 20261069) ────────────
  it("REFUSES to correct a single transfer leg — correcting one leg invents stock", async () => {
    // THE PROVEN REPRO: seed +10 @ source, transfer it, then reverse ONE leg.
    // Before 20261069 the compensating +10 landed at source while dest kept its
    // transfer_in — the company total went 10 → 20, stock from nothing, and by a
    // non-admin under a low-scrutiny "correction". This must now be REFUSED.
    const src = await makeSite(orgA, "TG source");
    const dst = await makeSite(orgA, "TG dest");
    const item = await makeItem(orgA, "TG blocks");
    const seed = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: item,
      p_site_id: src,
      p_delta: 10,
      p_reason: "seed 10 @ source",
    });
    expect(seed.error, seed.error?.message).toBeNull();

    const before = await companyTotal(orgA);
    const moved = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: item,
      p_from_site_id: src,
      p_to_site_id: dst,
      p_qty: 10,
      p_notes: "source -> dest",
    });
    expect(moved.error, moved.error?.message).toBeNull();
    const groupId = String(moved.data);

    const legOut = await svc()
      .from("stock_movements")
      .select("id")
      .eq("transfer_group_id", groupId)
      .eq("movement_type", "transfer_out")
      .maybeSingle();
    const legIn = await svc()
      .from("stock_movements")
      .select("id")
      .eq("transfer_group_id", groupId)
      .eq("movement_type", "transfer_in")
      .maybeSingle();

    // BOTH legs are uncorrectable through the RPC — refused with the message
    // that names the honest instrument (a compensating transfer).
    for (const legId of [String(legOut.data?.id ?? ""), String(legIn.data?.id ?? "")]) {
      const r = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
        p_org_id: orgA,
        p_movement_id: legId,
        p_reason: "reverse this leg",
      });
      expect(r.error, "a transfer leg was correctable").not.toBeNull();
      expect(r.error?.message ?? "").toMatch(/leg of a transfer/i);
    }

    // ...and a DIRECT insert is refused too, at BOTH layers. As a MEMBER the
    // write-path gate (20261071) stops it before any derivation runs; as
    // SERVICE_ROLE — which bypasses RLS and that gate — the structural backstop
    // in tg_stock_movements_derive still refuses it. Proving only the member
    // case would leave the derive-trigger guard untested from 20261071 onward.
    const directMember = await db(userClient(dualToken))
      .from("stock_movements")
      .insert({
        org_id: orgA,
        stock_item_id: item,
        site_id: src,
        movement_type: "correction",
        qty: 10,
        corrects_movement_id: String(legOut.data?.id ?? ""),
        notes: "direct leg correction",
      });
    expect(directMember.error, "a direct-insert leg correction slipped through").not.toBeNull();

    const directService = await svc().from("stock_movements").insert({
      org_id: orgA,
      stock_item_id: item,
      site_id: src,
      movement_type: "correction",
      qty: 10,
      corrects_movement_id: String(legOut.data?.id ?? ""),
      notes: "service-role leg correction",
    });
    expect(
      directService.error,
      "service_role corrected a single transfer leg — the derive-trigger backstop is gone",
    ).not.toBeNull();
    expect(directService.error?.message ?? "").toMatch(/leg of a transfer/i);

    // CONSERVATION HELD: total unchanged, and the pair is intact (0 @ src, 10 @ dst).
    expect(await companyTotal(orgA), "stock was manufactured").toBe(before);
    expect(await balance(orgA, item, src)).toBe(0);
    expect(await balance(orgA, item, dst)).toBe(10);
  });

  it("a wrong transfer is undone by a COMPENSATING transfer, which conserves", async () => {
    // The honest instrument the refusal points at: a transfer the other way is
    // itself a conserving pair, so the goods can always be moved back and nothing
    // else can. This is what the operator does instead of correcting a leg.
    const s1 = await makeSite(orgA, "Comp source");
    const s2 = await makeSite(orgA, "Comp dest");
    const item = await makeItem(orgA, "Comp blocks");
    await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: item,
      p_site_id: s1,
      p_delta: 10,
      p_reason: "seed",
    });
    const total = await companyTotal(orgA);
    await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: item,
      p_from_site_id: s1,
      p_to_site_id: s2,
      p_qty: 10,
      p_notes: "wrong way",
    });
    const back = await rpc(userClient(dualToken)).rpc("record_stock_transfer", {
      p_org_id: orgA,
      p_item_id: item,
      p_from_site_id: s2,
      p_to_site_id: s1,
      p_qty: 10,
      p_notes: "put it back",
    });
    expect(back.error, back.error?.message).toBeNull();
    expect(await balance(orgA, item, s1)).toBe(10);
    expect(await balance(orgA, item, s2)).toBe(0);
    expect(await companyTotal(orgA), "the compensating transfer conserves").toBe(total);
  });

  // ── the GRN void rule ─────────────────────────────────────────────────────
  it("REFUSES to void a delivery whose stock receipt still stands", async () => {
    const grn = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("org_id", orgA)
      .maybeSingle();
    const grnId = String(grn.data?.id ?? "");

    const { error } = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: grnId,
      p_org_id: orgA,
      p_reason: "booked against the wrong order",
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/correct the stock receipt first/i);

    // still posted, and the stock is still there
    const after = await svc().from("goods_received_notes").select("status").eq("id", grnId).maybeSingle();
    expect(after.data?.status).toBe("posted");
  });

  it("…and ALLOWS the void once the stock receipt has been corrected", async () => {
    const receipt = await svc()
      .from("stock_movements")
      .select("id")
      .eq("org_id", orgA)
      .eq("movement_type", "receipt")
      .maybeSingle();

    // Some of the 40 has been issued, so a full reversal would go negative —
    // the floor holds even here, and the operator is told what to do instead.
    const tooLate = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: String(receipt.data?.id ?? ""),
      p_reason: "goods never arrived",
    });
    expect(tooLate.error?.message ?? "").toMatch(/already been used|not enough/i);

    // Put the stock back first (an honest, reasoned act), then reverse.
    const topUp = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
      p_delta: 40,
      p_reason: "recount before reversing the delivery",
    });
    expect(topUp.error, topUp.error?.message).toBeNull();

    const reversed = await rpc(userClient(dualToken)).rpc("record_stock_correction", {
      p_org_id: orgA,
      p_movement_id: String(receipt.data?.id ?? ""),
      p_reason: "goods never arrived",
    });
    expect(reversed.error, reversed.error?.message).toBeNull();

    const grn = await svc()
      .from("goods_received_notes")
      .select("id")
      .eq("org_id", orgA)
      .maybeSingle();
    const voided = await rpc(userClient(dualToken)).rpc("void_goods_received_note", {
      p_grn_id: String(grn.data?.id ?? ""),
      p_org_id: orgA,
      p_reason: "booked against the wrong order",
    });
    expect(voided.error, voided.error?.message).toBeNull();
  });

  it("REFUSES to take a VOID delivery line into stock", async () => {
    const { error } = await rpc(userClient(dualToken)).rpc("record_stock_receipt_from_grn", {
      p_org_id: orgA,
      p_grn_line_id: grnLineA,
      p_item_id: itemA,
      p_site_id: yardA,
      p_notes: null,
    });
    expect(error).not.toBeNull();
    // idempotency answers first (the line is already in stock, corrected or
    // not) — either refusal is correct; what must never happen is a NEW receipt.
    const receipts = await svc()
      .from("stock_movements")
      .select("id")
      .eq("grn_line_id", grnLineA)
      .eq("movement_type", "receipt");
    expect(receipts.data ?? []).toHaveLength(1);
  });

  // ── the direct-insert residue, closed by 20261071 ─────────────────────────
  /**
   * WHAT A MEMBER COULD DO BY GOING STRAIGHT TO PostgREST, BEFORE 20261071.
   *
   * `stock_movements` granted members a bare INSERT policy because the write
   * RPCs are SECURITY INVOKER and need the caller's own insert right. That was
   * recorded as ONE accepted residue ("can drive a balance negative"). Probed as
   * a plain `staff` member against the live local schema, it was FOUR things,
   * three of which are authority bypasses rather than self-harm:
   *
   *   1. a direct `issue` of 1000 against a site holding 10 → balance −990;
   *   2. a direct `adjustment_out` → the ADMIN-ONLY adjustment gate bypassed,
   *      the one movement with no counterparty, "the write that can conceal a
   *      loss" (20261065000000 §4);
   *   3. a bare `transfer_in` → conservation broken, stock from nothing — the
   *      same class 20261069000000 fixed for transfer-leg corrections;
   *   4. a direct `receipt` off a DRAFT delivery line → the posted-evidence
   *      check bypassed.
   *
   * All four are now refused by the write-path gate. Each assertion below is
   * paired with the RPC route still working, so the gate cannot pass by simply
   * breaking stock writes for everybody.
   */
  describe("a tenant principal can only write through a stock write path", () => {
    let gateItem = "";
    let gateSite = "";

    beforeAll(async () => {
      gateItem = await makeItem(orgA, "Gate blocks");
      gateSite = await makeSite(orgA, "Gate yard");
      const seed = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
        p_org_id: orgA,
        p_item_id: gateItem,
        p_site_id: gateSite,
        p_delta: 10,
        p_reason: "opening count",
      });
      expect(seed.error, seed.error?.message).toBeNull();
    });

    it("1. REFUSES a direct `issue` that would drive the balance negative", async () => {
      const before = await balance(orgA, gateItem, gateSite);
      expect(before).toBe(10);

      const direct = await db(userClient(memberToken)).from("stock_movements").insert({
        org_id: orgA,
        stock_item_id: gateItem,
        site_id: gateSite,
        movement_type: "issue",
        qty: 1000,
      });
      expect(direct.error, "a member drove a balance negative by direct insert").not.toBeNull();
      expect(direct.error?.code).toBe("42501"); // insufficient_privilege
      expect(await balance(orgA, gateItem, gateSite)).toBe(10);

      // ...and the RPC route still works and still floors at the balance.
      const viaRpc = await rpc(userClient(memberToken)).rpc("record_stock_issue", {
        p_org_id: orgA,
        p_item_id: gateItem,
        p_site_id: gateSite,
        p_qty: 4,
        p_job_id: null,
        p_material_request_line_id: null,
        p_notes: null,
      });
      expect(viaRpc.error, viaRpc.error?.message).toBeNull();
      expect(await balance(orgA, gateItem, gateSite)).toBe(6);
    });

    it("2. the ADMIN-ONLY adjustment gate can no longer be walked around", async () => {
      // The gate itself, working, so the bypass below is a real escalation.
      const viaRpc = await rpc(userClient(memberToken)).rpc("record_stock_adjustment", {
        p_org_id: orgA,
        p_item_id: gateItem,
        p_site_id: gateSite,
        p_delta: -5,
        p_reason: "member write-off",
      });
      expect(viaRpc.error?.message ?? "").toMatch(/owner or admin/i);

      const direct = await db(userClient(memberToken)).from("stock_movements").insert({
        org_id: orgA,
        stock_item_id: gateItem,
        site_id: gateSite,
        movement_type: "adjustment_out",
        qty: 5,
        notes: "direct write-off, no admin needed",
      });
      expect(direct.error, "a member wrote off stock with no admin gate").not.toBeNull();
      expect(direct.error?.code).toBe("42501");
      expect(await balance(orgA, gateItem, gateSite)).toBe(6);
    });

    it("3. REFUSES a bare `transfer_in` — conservation cannot be broken by insert", async () => {
      const before = await companyTotal(orgA);
      const direct = await db(userClient(memberToken)).from("stock_movements").insert({
        org_id: orgA,
        stock_item_id: gateItem,
        site_id: gateSite,
        movement_type: "transfer_in",
        qty: 500,
      });
      expect(direct.error, "a member manufactured 500 units from nothing").not.toBeNull();
      expect(direct.error?.code).toBe("42501");
      expect(await companyTotal(orgA), "stock was manufactured").toBe(before);
    });

    it("4. REFUSES a direct `receipt` off an unposted delivery line", async () => {
      const grn = await svc()
        .from("goods_received_notes")
        .insert({
          org_id: orgA,
          purchase_order_id: poA,
          number: `${TOKEN}-GRN-DRAFT`,
          status: "draft",
          delivery_date: "2026-07-30",
        })
        .select("id")
        .single();
      expect(grn.error, grn.error?.message).toBeNull();
      const draftLine = await svc()
        .from("goods_received_lines")
        .insert({
          org_id: orgA,
          goods_received_note_id: String(grn.data?.id ?? ""),
          purchase_order_line_item_id: poLineA,
          qty_received: 10,
        })
        .select("id")
        .single();
      expect(draftLine.error, draftLine.error?.message).toBeNull();

      // The RPC refuses it for the right reason...
      const viaRpc = await rpc(userClient(memberToken)).rpc("record_stock_receipt_from_grn", {
        p_org_id: orgA,
        p_grn_line_id: String(draftLine.data?.id ?? ""),
        p_item_id: gateItem,
        p_site_id: gateSite,
        p_notes: null,
      });
      expect(viaRpc.error?.message ?? "").toMatch(/post it before taking it into stock/i);

      // ...and the direct route no longer exists to go around it.
      const direct = await db(userClient(memberToken)).from("stock_movements").insert({
        org_id: orgA,
        stock_item_id: gateItem,
        site_id: gateSite,
        movement_type: "receipt",
        qty: 10,
        grn_line_id: String(draftLine.data?.id ?? ""),
      });
      expect(direct.error, "unposted delivery evidence landed in stock").not.toBeNull();
      expect(direct.error?.code).toBe("42501");
    });

    it("the write marker does not survive the RPC that set it", async () => {
      // It is transaction-local (`set_config(..., true)`) and cleared inside each
      // write path, so a member cannot ride a previous call's authorisation on a
      // pooled connection. Same client, immediately after a successful RPC.
      const client = userClient(memberToken);
      const ok = await rpc(client).rpc("record_stock_issue", {
        p_org_id: orgA,
        p_item_id: gateItem,
        p_site_id: gateSite,
        p_qty: 1,
        p_job_id: null,
        p_material_request_line_id: null,
        p_notes: null,
      });
      expect(ok.error, ok.error?.message).toBeNull();

      const after = await db(client).from("stock_movements").insert({
        org_id: orgA,
        stock_item_id: gateItem,
        site_id: gateSite,
        movement_type: "adjustment_in",
        qty: 999,
        notes: "riding the previous call's marker",
      });
      expect(after.error, "the write marker leaked past the RPC that set it").not.toBeNull();
      expect(after.error?.code).toBe("42501");
    });

    it("SERVICE_ROLE is still trusted — the documented asymmetry, stated by a test", async () => {
      // Not an oversight: service_role is reachable only from server-side code
      // holding the secret key, and every authority check in this schema is
      // JWT-gated the same way (the adjustment gate, tg_ra_lifecycle,
      // tg_goods_received_note_lifecycle, tg_material_request_transition). The
      // integration harness's own ground-truth fixtures depend on it.
      const direct = await svc()
        .from("stock_movements")
        .insert({
          org_id: orgA,
          stock_item_id: gateItem,
          site_id: gateSite,
          movement_type: "adjustment_in",
          qty: 1,
          notes: "trusted server-side write",
        })
        .select("id")
        .single();
      expect(direct.error, direct.error?.message).toBeNull();
    });
  });

  // ── THE dual-org proof, and the mutation proof ───────────────────────────
  it("RLS ALONE returns BOTH orgs' items to a dual-org member", async () => {
    // Not a bug in RLS — it is what current_org_ids() means, and it is exactly
    // why every query on this surface carries its own org predicate.
    const { data, error } = await db(userClient(dualToken))
      .from("stock_items")
      .select("id")
      .eq("name", "Blocks 100mm");
    expect(error, error?.message).toBeNull();
    const ids = (data ?? []).map((r) => String(r.id));
    expect(ids).toContain(itemA);
    expect(ids).toContain(itemB);
  });

  it("a by-id read PINNED to org A cannot fetch org B's item (→ notFound)", async () => {
    const { data, error } = await db(userClient(dualToken))
      .from("stock_items")
      .select("id")
      .eq("id", itemB)
      .eq("org_id", orgA); // the pin loadStockItem carries
    expect(error, error?.message).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("MUTATION PROOF: strip the pin and org B's item is visible", async () => {
    // If this ever goes green WITH the pin in place, the pin has stopped doing
    // anything and every assertion above is vacuous.
    const { data } = await db(userClient(dualToken)).from("stock_items").select("id").eq("id", itemB);
    expect((data ?? []).map((r) => String(r.id))).toEqual([itemB]);
  });

  it("MUTATION PROOF: the movement read is pinned too — unpinned it blends both yards", async () => {
    // Give org B some stock so the blend is a real, wrong number rather than an
    // empty set that happens to look right.
    const seeded = await rpc(userClient(dualToken)).rpc("record_stock_adjustment", {
      p_org_id: orgB,
      p_item_id: itemB,
      p_site_id: siteB,
      p_delta: 7,
      p_reason: "org B opening count",
    });
    expect(seeded.error, seeded.error?.message).toBeNull();

    const pinned = await db(userClient(dualToken))
      .from("stock_movements")
      .select("org_id")
      .eq("org_id", orgA);
    const unpinned = await db(userClient(dualToken)).from("stock_movements").select("org_id");

    const pinnedOrgs = new Set((pinned.data ?? []).map((r) => String(r.org_id)));
    const unpinnedOrgs = new Set((unpinned.data ?? []).map((r) => String(r.org_id)));
    expect([...pinnedOrgs]).toEqual([orgA]);
    expect(unpinnedOrgs.has(orgA) && unpinnedOrgs.has(orgB), "the pin is load-bearing").toBe(true);
  });

  it("the BALANCE function refuses to answer for an org the caller is not in", async () => {
    const outsider = await rpc(userClient(outsiderToken)).rpc("stock_balance", {
      p_org_id: orgA,
      p_item_id: itemA,
      p_site_id: depotA,
    });
    // SECURITY INVOKER: RLS filters every row away, so the sum is zero rather
    // than another company's real figure.
    expect(Number(outsider.data ?? -1)).toBe(0);
  });

  it("the balances VIEW is security_invoker — an outsider sees no rows", async () => {
    const { data } = await db(userClient(outsiderToken)).from("stock_balances").select("org_id");
    expect(data ?? []).toHaveLength(0);

    const dual = await db(userClient(dualToken)).from("stock_balances").select("org_id").eq("org_id", orgA);
    expect((dual.data ?? []).length).toBeGreaterThan(0);
  });

  // ── activity ──────────────────────────────────────────────────────────────
  it("logs adjustments and corrections to the tenant feed, and nothing else", async () => {
    const rows = await svc().from("activity_log").select("action").eq("org_id", orgA);
    const actions = new Set((rows.data ?? []).map((r) => String(r.action)));
    expect([...actions].some((a) => a.startsWith("stock.adjustment"))).toBe(true);
    expect(actions.has("stock.correction")).toBe(true);
    // receipts / issues / transfers explain themselves; logging them would
    // drown the feed.
    expect(actions.has("stock.receipt")).toBe(false);
    expect(actions.has("stock.issue")).toBe(false);
  });

  // ── uniqueness ────────────────────────────────────────────────────────────
  it("item names are unique per org, case-insensitively — but not ACROSS orgs", async () => {
    const dupe = await svc()
      .from("stock_items")
      .insert({ org_id: orgA, name: "blocks 100MM", unit: "ea" })
      .select("id")
      .single();
    expect(dupe.error?.code).toBe("23505");

    // org B already has its own "Blocks 100mm" and that is correct.
    const bOwn = await svc().from("stock_items").select("id").eq("org_id", orgB).eq("name", "Blocks 100mm");
    expect(bOwn.data ?? []).toHaveLength(1);
  });

  it("a supplier from another company cannot be made an item's preferred supplier", async () => {
    const sup = await svc()
      .from("suppliers")
      .insert({ org_id: orgB, name: `${TOKEN} B merchant` })
      .select("id")
      .single();
    const { error } = await svc()
      .from("stock_items")
      .insert({
        org_id: orgA,
        name: `${TOKEN} cross-tenant supplier`,
        unit: "ea",
        preferred_supplier_id: String(sup.data?.id ?? ""),
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
    expect(error?.message ?? "").toMatch(/is not in org/i);
  });

  // ── teardown ──────────────────────────────────────────────────────────────
  it("a site holding stock cannot be deleted (the deferred FK, checked at COMMIT)", async () => {
    const { error } = await svc().from("sites").delete().eq("id", depotA);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23503");
    const still = await svc().from("sites").select("id").eq("id", depotA);
    expect(still.data ?? []).toHaveLength(1);
  });

  it("ORG TEARDOWN still succeeds with a full stock ledger present", async () => {
    // The reason every composite FK here is `no action deferrable initially
    // deferred` rather than RESTRICT: a RESTRICT can never be deferred, so a
    // cascade that removed one side before the other would abort GDPR erasure.
    const doomed = await makeOrg("Stock Teardown", `${TOKEN}-teardown`);
    const site = await makeSite(doomed, "Yard");
    const item = await makeItem(doomed, "Sand");
    const seeded = await rpc(serviceClient()).rpc("record_stock_adjustment", {
      p_org_id: doomed,
      p_item_id: item,
      p_site_id: site,
      p_delta: 25,
      p_reason: "opening count",
    });
    expect(seeded.error, seeded.error?.message).toBeNull();
    const issued = await rpc(serviceClient()).rpc("record_stock_issue", {
      p_org_id: doomed,
      p_item_id: item,
      p_site_id: site,
      p_qty: 5,
      p_job_id: null,
      p_material_request_line_id: null,
      p_notes: null,
    });
    expect(issued.error, issued.error?.message).toBeNull();

    const del = await svc().from("organizations").delete().eq("id", doomed);
    expect(del.error, del.error?.message).toBeNull();

    for (const t of ["stock_movements", "stock_items", "sites"]) {
      const left = await svc().from(t).select("id").eq("org_id", doomed);
      expect(left.data ?? [], `${t} rows survived teardown`).toHaveLength(0);
    }
  });
});
