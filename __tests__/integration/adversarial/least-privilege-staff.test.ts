/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, svc, type World } from "./_fixture";

/**
 * LEAST PRIVILEGE — the founder's rules, one named test per rule, at the DATA layer.
 *
 *   "staff can access their own information, assigned jobs and required operational
 *    functions; staff must NOT access company financial reports, payroll, privileged
 *    logs or administrative functions unless explicitly authorised; hidden menu items
 *    must also be blocked by server-side permissions."
 *
 * Every case talks to PostgREST with a real `staff` JWT — no route gate, no capability
 * check, no UI. Each DENY case is paired with a control proving the same operation still
 * works for an owner/admin (or, where the rule is "staff keep X", that staff still can).
 *
 * Migrations under test: 20261340 (operations modules — owner/admin writes),
 * 20261344 (audit columns, drawing status, warranty publication).
 * The column ACLs (20261341–43) are proved in ../rls/private-column-acl.test.ts.
 * Decision table: docs/programme/security-least-privilege/STAFF-ACCESS-DECISIONS.md.
 */
describeIntegration("LEAST PRIVILEGE · staff vs the operations modules and audit columns", () => {
  let w: World | null = null;
  let supplierId = "";
  let stockItemId = "";
  let siteId = "";
  let jobId = "";
  let assetId = "";

  const one = async <T = any>(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T> => {
    const r = await q;
    if (r.error || !r.data) throw new Error(`least-privilege fixture: ${what}: ${r.error?.message ?? "no row"}`);
    return r.data as T;
  };
  const denied = (r: { error: { code?: string; message: string } | null; data?: unknown; status?: number }) =>
    r.error !== null || (Array.isArray(r.data) && r.data.length === 0);

  beforeAll(async () => {
    w = await createWorld("seclp-ops");
    const A = w.A.id;
    supplierId = (await one<{ id: string }>(svc().from("suppliers").insert({ org_id: A, name: `LP supplier ${w.tag}`, payment_terms_days: 30 }).select("id").single(), "supplier")).id;
    stockItemId = (await one<{ id: string }>(svc().from("stock_items").insert({ org_id: A, name: `LP item ${w.tag}`, unit: "ea" }).select("id").single(), "stock item")).id;
    siteId = (await one<{ id: string }>(svc().from("sites").insert({ org_id: A, name: `LP depot ${w.tag}`, kind: "depot" }).select("id").single(), "site")).id;
    assetId = (await one<{ id: string }>(svc().from("assets").insert({ org_id: A, name: `LP asset ${w.tag}`, purchase_price: 12345.67 }).select("id").single(), "asset")).id;
    const customer = await one<{ id: string }>(svc().from("customers").insert({ org_id: A, name: `LP customer ${w.tag}` }).select("id").single(), "customer");
    jobId = (await one<{ id: string }>(svc().from("jobs").insert({ org_id: A, customer_id: customer.id, assigned_to: w.A.staff.id }).select("id").single(), "job")).id;
    await svc().from("job_assignments").insert({ org_id: A, job_id: jobId, user_id: w.A.staff.id });
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  // ── purchase orders ────────────────────────────────────────────────────────────
  it("LP-PO · staff cannot raise a purchase order or add a line; an admin can", async () => {
    const world = w!;
    const po = { org_id: world.A.id, supplier_id: supplierId, number: `LP-${world.tag}`, status: "draft" };
    const staff = await as(world.A.staff.token).from("purchase_orders").insert(po);
    expect(staff.error, "staff INSERT purchase_orders must be refused").not.toBeNull();
    expect((await svc().from("purchase_orders").select("id").eq("org_id", world.A.id)).data ?? []).toHaveLength(0);

    const admin = await as(world.A.admin.token).from("purchase_orders").insert(po).select("id").single();
    expect(admin.error, JSON.stringify(admin.error)).toBeNull();
    const poId = (admin.data as { id: string }).id;
    const line = await as(world.A.staff.token).from("purchase_order_line_items").insert({ org_id: world.A.id, purchase_order_id: poId, description: "x", quantity: 1, unit_price: 1 });
    expect(line.error, "staff INSERT purchase_order_line_items must be refused").not.toBeNull();
  });

  // ── suppliers ──────────────────────────────────────────────────────────────────
  it("LP-SUPPLIER · staff cannot create, edit or delete a supplier; an admin can; staff still read the name (kept for the cost-entry form)", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    expect((await staff.from("suppliers").insert({ org_id: world.A.id, name: "staff-made supplier" })).error).not.toBeNull();
    const upd = await staff.from("suppliers").update({ name: "renamed by staff", payment_terms_days: 1 }).eq("id", supplierId).select("id");
    expect(denied(upd), "staff UPDATE suppliers").toBe(true);
    const del = await staff.from("suppliers").delete().eq("id", supplierId).select("id");
    expect(denied(del), "staff DELETE suppliers").toBe(true);
    const truth = await one<{ name: string; payment_terms_days: number }>(svc().from("suppliers").select("name, payment_terms_days").eq("id", supplierId).single(), "truth");
    expect(truth.name).toBe(`LP supplier ${world.tag}`);
    expect(truth.payment_terms_days).toBe(30);

    // kept: read
    const read = await staff.from("suppliers").select("id, name").eq("id", supplierId);
    expect(read.data ?? []).toHaveLength(1);
    // control: admin edits
    const adminUpd = await as(world.A.admin.token).from("suppliers").update({ payment_terms_days: 45 }).eq("id", supplierId).select("id");
    expect(adminUpd.error).toBeNull();
    expect(adminUpd.data ?? []).toHaveLength(1);
  });

  // ── stock ──────────────────────────────────────────────────────────────────────
  it("LP-STOCK · staff cannot edit the stock catalogue or adjust stock, but (D-17) may issue stock as themselves through the RPC; an owner can adjust", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    expect((await staff.from("stock_items").insert({ org_id: world.A.id, name: "staff item", unit: "ea" })).error).not.toBeNull();
    expect(denied(await staff.from("stock_items").update({ reorder_level: 999 }).eq("id", stockItemId).select("id"))).toBe(true);

    // The owner books 10 in (control — the ledger write path works for management).
    const inn = await as(world.A.owner.token).rpc("record_stock_adjustment", {
      p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_delta: 10, p_reason: "opening count",
    });
    expect(inn.error, JSON.stringify(inn.error)).toBeNull();

    // D-17 REVERSAL (20261346): issuing stock is an ordinary site duty — a staff member may
    // issue as THEMSELVES through the definer RPC. The ledger row must name them.
    const out = await staff.rpc("record_stock_issue", {
      p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_qty: 1, p_job_id: null, p_material_request_line_id: null, p_notes: "staff issue",
    });
    expect(out.error, JSON.stringify(out.error)).toBeNull();
    // Adjustments (and corrections) are NOT a field duty: still refused at the ledger.
    const adj = await staff.rpc("record_stock_adjustment", {
      p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_delta: 5, p_reason: "staff adjustment",
    });
    expect(adj.error, "staff stock adjustment must be refused").not.toBeNull();
    const moves = await svc().from("stock_movements").select("id, movement_type, actor_id").eq("org_id", world.A.id);
    expect((moves.data ?? []).map((m: any) => m.movement_type).sort()).toEqual(["adjustment_in", "issue"]);
    expect((moves.data ?? []).find((m: any) => m.movement_type === "issue")?.actor_id).toBe(world.A.staff.id);
  });

  // ── assets ─────────────────────────────────────────────────────────────────────
  it("LP-ASSET · staff cannot create or edit an asset (incl. its price / value) nor take custody of one; an admin can edit", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    expect((await staff.from("assets").insert({ org_id: world.A.id, name: "staff asset" })).error).not.toBeNull();
    await staff.from("assets").update({ purchase_price: 1, current_value: 1, name: "renamed by staff" }).eq("id", assetId);
    const truth = await one<{ name: string; purchase_price: number | string }>(svc().from("assets").select("name, purchase_price").eq("id", assetId).single(), "truth");
    expect(truth.name).toBe(`LP asset ${world.tag}`);
    expect(Number(truth.purchase_price)).toBe(12345.67);
    const custody = await staff.from("asset_assignments").insert({ org_id: world.A.id, asset_id: assetId, assignment_type: "person", assignee_id: world.A.staff.id });
    expect(custody.error, "staff INSERT asset_assignments must be refused").not.toBeNull();

    const adminUpd = await as(world.A.admin.token).from("assets").update({ notes: "serviced" }).eq("id", assetId).select("id");
    expect(adminUpd.error).toBeNull();
    expect(adminUpd.data ?? []).toHaveLength(1);
  });

  // ── warranties (customer-facing publication) ───────────────────────────────────
  it("LP-WARRANTY · assigned staff cannot create, publish to the portal or void a warranty; an admin can publish", async () => {
    const world = w!;
    const row = await one<{ id: string }>(
      svc().from("job_warranties").insert({ org_id: world.A.id, job_id: jobId, title: "Roof", cover: "Workmanship", period_months: 12 }).select("id").single(),
      "warranty",
    );
    const staff = as(world.A.staff.token);
    expect((await staff.from("job_warranties").insert({ org_id: world.A.id, job_id: jobId, title: "Staff-made", cover: "x", period_months: 12 })).error).not.toBeNull();
    await staff.from("job_warranties").update({ portal_published_at: new Date().toISOString(), portal_published_by: world.A.staff.id }).eq("id", row.id);
    await staff.from("job_warranties").update({ status: "void", voided_at: new Date().toISOString(), void_reason: "staff" }).eq("id", row.id);
    const truth = await one<any>(svc().from("job_warranties").select("status, portal_published_at, voided_at").eq("id", row.id).single(), "truth");
    expect(truth).toEqual({ status: "active", portal_published_at: null, voided_at: null });

    const pub = await as(world.A.admin.token).from("job_warranties").update({ portal_published_at: new Date().toISOString(), portal_published_by: world.A.admin.id }).eq("id", row.id).select("id");
    expect(pub.error).toBeNull();
    expect(pub.data ?? []).toHaveLength(1);
  });

  // ── drawings ───────────────────────────────────────────────────────────────────
  it("LP-DRAWING-STATUS · assigned staff keep editing a drawing's title but cannot change its status; an admin can", async () => {
    const world = w!;
    const bp = await one<{ id: string; status: string }>(
      svc().from("blueprints").insert({ org_id: world.A.id, job_id: jobId, drawing_number: `LP-${world.tag}`, title: "GA plan" }).select("id, status").single(),
      "blueprint",
    );
    const staff = as(world.A.staff.token);
    const st = await staff.from("blueprints").update({ status: "superseded" }).eq("id", bp.id).select("id");
    expect(st.error?.code, JSON.stringify(st.error)).toBe("42501");
    // kept: assigned staff maintain the register entry.
    const title = await staff.from("blueprints").update({ title: "GA plan rev B" }).eq("id", bp.id).select("id");
    expect(title.error, JSON.stringify(title.error)).toBeNull();
    expect(title.data ?? []).toHaveLength(1);
    const truth = await one<{ status: string; title: string }>(svc().from("blueprints").select("status, title").eq("id", bp.id).single(), "truth");
    expect(truth).toEqual({ status: bp.status, title: "GA plan rev B" });

    const admin = await as(world.A.admin.token).from("blueprints").update({ status: "superseded" }).eq("id", bp.id).select("id");
    expect(admin.error, JSON.stringify(admin.error)).toBeNull();
    expect(admin.data ?? []).toHaveLength(1);
  });

  // ── audit columns ──────────────────────────────────────────────────────────────
  it("LP-AUDIT · staff cannot attribute a record to a colleague or back-date it; their own honest write still lands", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const backdated = "2020-01-01T00:00:00+00:00";

    // INSERT naming the OWNER as the actor → refused outright.
    const forged = await staff.from("job_progress_observations").insert({ org_id: world.A.id, job_id: jobId, percent: 10, recorded_by: world.A.owner.id });
    expect(forged.error?.code, JSON.stringify(forged.error)).toBe("42501");

    // Honest INSERT that also tries to back-date → lands, stamped with the server clock.
    const honest = await staff.from("job_progress_observations").insert({ org_id: world.A.id, job_id: jobId, percent: 20, recorded_by: world.A.staff.id, created_at: backdated }).select("id").single();
    expect(honest.error, JSON.stringify(honest.error)).toBeNull();
    const obsId = (honest.data as { id: string }).id;
    let truth = await one<any>(svc().from("job_progress_observations").select("recorded_by, created_at, percent").eq("id", obsId).single(), "truth");
    expect(truth.recorded_by).toBe(world.A.staff.id);
    expect(new Date(truth.created_at).getUTCFullYear()).toBeGreaterThanOrEqual(2026);

    // UPDATE: re-attribute → refused; back-date → silently frozen; a real edit → lands.
    const reattr = await staff.from("job_progress_observations").update({ recorded_by: world.A.owner.id }).eq("id", obsId).select("id");
    expect(reattr.error?.code, JSON.stringify(reattr.error)).toBe("42501");
    const createdBefore = truth.created_at;
    const edit = await staff.from("job_progress_observations").update({ percent: 30, created_at: backdated }).eq("id", obsId).select("id");
    expect(edit.error, JSON.stringify(edit.error)).toBeNull();
    truth = await one<any>(svc().from("job_progress_observations").select("recorded_by, created_at, percent").eq("id", obsId).single(), "truth");
    expect(truth).toEqual({ recorded_by: world.A.staff.id, created_at: createdBefore, percent: 30 });

    // Site visitors (a staff-allowed surface): sign a visitor in as yourself — fine;
    // as a colleague — refused.
    const visitor = await staff.from("site_visitors").insert({ org_id: world.A.id, site_id: siteId, visitor_name: "A. Visitor", signed_in_by: world.A.staff.id }).select("id").single();
    expect(visitor.error, JSON.stringify(visitor.error)).toBeNull();
    const asColleague = await staff.from("site_visitors").insert({ org_id: world.A.id, site_id: siteId, visitor_name: "B. Visitor", signed_in_by: world.A.owner.id });
    expect(asColleague.error?.code, JSON.stringify(asColleague.error)).toBe("42501");
  });

  it("LP-AUDIT control · an owner is not subject to the staff audit guard (office corrections keep working)", async () => {
    const world = w!;
    // One observation per job per day exists (the staff member's, above): the owner
    // corrects who recorded it — the office correction the guard must not block.
    const r = await as(world.A.owner.token).from("job_progress_observations").update({ recorded_by: world.A.admin.id }).eq("job_id", jobId).select("id, recorded_by");
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect((r.data ?? []).map((x: any) => x.recorded_by)).toEqual([world.A.admin.id]);
  });
});
