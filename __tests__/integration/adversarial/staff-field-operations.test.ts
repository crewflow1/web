/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, svc, type World } from "./_fixture";

/**
 * D-17 — what a plain `staff` member MAY do, proved at the data layer with real GoTrue
 * sessions (migration 20261346). Each ALLOW is paired with the nearest DENY: the same
 * operation as someone else, in the wrong lifecycle state, in another company, or in a
 * held (suspended / cancelled) company.
 */
describeIntegration("D-17 · staff field operations (data layer)", () => {
  let w: World | null = null;
  let assetId = "";
  let stockItemId = "";
  let siteId = "";
  let poId = "";
  let jobId = "";

  const ok = (r: { error: { message: string; code?: string } | null }, what: string) =>
    expect(r.error, `${what}: ${JSON.stringify(r.error)}`).toBeNull();
  const refused = (r: { error: { message: string } | null; data?: unknown }, what: string) =>
    expect(r.error !== null || (Array.isArray(r.data) && r.data.length === 0), `${what} must be refused`).toBe(true);
  const setStatus = async (org: string, status: string) => {
    const r = await svc().from("organizations").update({ status }).eq("id", org);
    if (r.error) throw new Error(`org status: ${r.error.message}`);
  };

  beforeAll(async () => {
    w = await createWorld("d17-field");
    const A = w.A.id;
    const one = async (q: PromiseLike<{ data: any; error: any }>, what: string) => {
      const r = await q;
      if (r.error || !r.data) throw new Error(`d17 fixture ${what}: ${r.error?.message}`);
      return r.data.id as string;
    };
    assetId = await one(svc().from("assets").insert({ org_id: A, name: `d17 asset ${w.tag}` }).select("id").single(), "asset");
    stockItemId = await one(svc().from("stock_items").insert({ org_id: A, name: `d17 item ${w.tag}`, unit: "ea" }).select("id").single(), "item");
    siteId = await one(svc().from("sites").insert({ org_id: A, name: `d17 depot ${w.tag}`, kind: "depot" }).select("id").single(), "site");
    const supplier = await one(svc().from("suppliers").insert({ org_id: A, name: `d17 supplier ${w.tag}` }).select("id").single(), "supplier");
    const customer = await one(svc().from("customers").insert({ org_id: A, name: `d17 customer ${w.tag}` }).select("id").single(), "customer");
    jobId = await one(svc().from("jobs").insert({ org_id: A, customer_id: customer, assigned_to: w.A.staff.id }).select("id").single(), "job");
    await svc().from("job_assignments").insert({ org_id: A, job_id: jobId, user_id: w.A.staff.id });
    poId = await one(svc().from("purchase_orders").insert({ org_id: A, supplier_id: supplier, number: `D17-${w.tag}`, status: "sent" }).select("id").single(), "po");
  }, 120_000);

  afterAll(async () => {
    await destroyWorld(w);
  }, 120_000);

  it("FUEL · staff log a fill as themselves; not as someone else, not another company, and never edit or delete one", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const row = (by: string) => ({ org_id: world.A.id, asset_id: assetId, filled_on: "2026-11-01", litres: 40, cost: 55, created_by: by });
    const mine = await staff.from("asset_fuel_logs").insert(row(world.A.staff.id)).select("id").single();
    ok(mine, "staff fuel log as self");
    refused(await staff.from("asset_fuel_logs").insert(row(world.A.admin.id)), "fuel log attributed to someone else");
    refused(await as(world.B.staff.token).from("asset_fuel_logs").insert(row(world.B.staff.id)), "other company's staff logging into company A");
    refused(await staff.from("asset_fuel_logs").update({ litres: 1 }).eq("id", (mine.data as any).id).select("id"), "staff editing a fuel log");
    refused(await staff.from("asset_fuel_logs").delete().eq("id", (mine.data as any).id).select("id"), "staff deleting a fuel log");
  });

  it("INSPECTION + DEFECT · staff start their own draft inspection and report a defect; no pre-issued or attributed-to-others rows; no triage", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const insp = (over: object = {}) => ({
      org_id: world.A.id, asset_id: assetId, title: "Pre-use check", kind: "pre_use", created_by: world.A.staff.id, status: "draft", ...over,
    });
    ok(await staff.from("asset_inspections").insert(insp()), "staff draft inspection");
    refused(await staff.from("asset_inspections").insert(insp({ status: "issued" })), "staff inserting an already-issued inspection");
    refused(await staff.from("asset_inspections").insert(insp({ created_by: world.A.admin.id })), "inspection attributed to the admin");

    const defect = (over: object = {}) => ({
      org_id: world.A.id, asset_id: assetId, case_type: "breakdown", title: "Cracked guard", reported_by: world.A.staff.id, status: "reported", ...over,
    });
    ok(await staff.from("asset_maintenance_cases").insert(defect()), "staff defect report");
    refused(await staff.from("asset_maintenance_cases").insert(defect({ status: "triaged" })), "staff triaging their own report");
    refused(await staff.from("asset_maintenance_cases").insert(defect({ reported_by: world.A.admin.id })), "defect attributed to the admin");
  });

  it("CUSTODY · staff take an asset into their OWN custody and return it; they cannot assign it to a colleague", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const mine = (over: object = {}) => ({
      org_id: world.A.id, asset_id: assetId, assignment_type: "issued_to_staff", assignee_id: world.A.staff.id, assigned_by: world.A.staff.id, status: "open", ...over,
    });
    const made = await staff.from("asset_assignments").insert(mine()).select("id").single();
    ok(made, "staff custody of an asset");
    refused(await staff.from("asset_assignments").insert(mine({ assignee_id: world.A.admin.id })), "staff assigning an asset to the admin");
    ok(await staff.from("asset_assignments").update({ status: "closed", returned_by: world.A.staff.id, actual_return_at: new Date().toISOString() }).eq("id", (made.data as any).id), "staff returning their own custody");
  });

  it("GOODS RECEIVED · staff record a delivery as themselves (draft); they cannot void or backdate a post as someone else", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const grn = (over: object = {}) => ({
      org_id: world.A.id, purchase_order_id: poId, number: `GRN-${Math.random().toString(36).slice(2, 8)}`, status: "draft", created_by: world.A.staff.id, received_by: world.A.staff.id, ...over,
    });
    const made = await staff.from("goods_received_notes").insert(grn()).select("id").single();
    ok(made, "staff goods-received note");
    refused(await staff.from("goods_received_notes").insert(grn({ created_by: world.A.admin.id })), "GRN attributed to the admin");
    refused(await staff.from("goods_received_notes").insert(grn({ status: "void", void_reason: "x" })), "staff inserting a void GRN");
    refused(await staff.from("goods_received_notes").update({ status: "void", void_reason: "staff void", voided_by: world.A.staff.id, voided_at: new Date().toISOString() }).eq("id", (made.data as any).id).select("id"), "staff voiding a GRN");
  });

  it("STOCK · staff issue / transfer as themselves; adjustments and corrections stay management-only", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    ok(await as(world.A.owner.token).rpc("record_stock_adjustment", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_delta: 20, p_reason: "opening" }), "owner opening stock");
    ok(await staff.rpc("record_stock_issue", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_qty: 2, p_job_id: null, p_material_request_line_id: null, p_notes: "field issue" }), "staff issue");
    refused(await staff.rpc("record_stock_adjustment", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_delta: 5, p_reason: "fudge" }), "staff adjustment");
    refused(await as(world.B.staff.token).rpc("record_stock_issue", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_qty: 1, p_job_id: null, p_material_request_line_id: null, p_notes: "x" }), "company B staff issuing company A stock");
  });

  it("STOCKTAKE · staff record a count on a session that is counting; not on an open one; they cannot post variances", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const session = (await svc().from("stocktake_sessions").insert({ org_id: world.A.id, site_id: siteId, reference: `ST-${world.tag}`, status: "counting", opened_by: world.A.admin.id }).select("id").single()).data as any;
    const line = (await svc().from("stocktake_lines").insert({ org_id: world.A.id, session_id: session.id, stock_item_id: stockItemId, expected_qty: 18 }).select("id").single()).data as any;
    ok(await staff.from("stocktake_lines").update({ counted_qty: 17, counted_by: world.A.staff.id, counted_at: new Date().toISOString() }).eq("id", line.id), "staff count");
    refused(await staff.from("stocktake_lines").update({ counted_qty: 99, counted_by: world.A.admin.id }).eq("id", line.id).select("id"), "count attributed to someone else");
    refused(await staff.from("stocktake_lines").update({ posted_variance: 5 }).eq("id", line.id).select("id"), "staff writing a posted variance");
    const idle = (await svc().from("stocktake_sessions").insert({ org_id: world.A.id, site_id: siteId, reference: `ST2-${world.tag}`, status: "open", opened_by: world.A.admin.id }).select("id").single()).data as any;
    const idleLine = (await svc().from("stocktake_lines").insert({ org_id: world.A.id, session_id: idle.id, stock_item_id: stockItemId, expected_qty: 18 }).select("id").single()).data as any;
    refused(await staff.from("stocktake_lines").update({ counted_qty: 1, counted_by: world.A.staff.id }).eq("id", idleLine.id).select("id"), "count on a session that is not counting");
  });

  it("PURCHASE REQUEST · staff raise a request but can never decide it; an admin can", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const req = (over: object = {}) => ({ org_id: world.A.id, number: `MR-${Math.random().toString(36).slice(2, 8)}`, status: "draft", job_id: jobId, ...over });
    const made = await staff.from("material_requests").insert(req()).select("id").single();
    ok(made, "staff material request");
    refused(await staff.from("material_requests").insert(req({ status: "approved", decided_by: world.A.staff.id, decided_at: new Date().toISOString() })), "staff inserting an approved request");
    refused(await staff.from("material_requests").update({ status: "approved", decided_by: world.A.staff.id, decided_at: new Date().toISOString() }).eq("id", (made.data as any).id).select("id"), "staff approving their own request");
    ok(await as(world.A.admin.token).from("material_requests").update({ notes: "admin note" }).eq("id", (made.data as any).id), "admin editing the request");
  });

  it("JOB COST · staff submit a PENDING cost entry; approval is management-only", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const draft = (over: object = {}) => ({ org_id: world.A.id, supplier_name: "Travis Perkins", total: 42, amount: 35, status: "extracted", ...over });
    ok(await staff.from("expense_drafts").insert(draft()), "staff pending cost entry");
    refused(await staff.from("expense_drafts").insert(draft({ status: "approved", approved_by: world.A.staff.id, approved_at: new Date().toISOString() })), "staff inserting an approved cost");
  });

  it("SITE SAFETY · staff draft a risk assessment and a permit; publishing / issuing needs site_safety:approve (owner, or an admin with the grant)", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const ra = (over: object = {}) => ({ org_id: world.A.id, title: "Working at height", activity: "Roof access", status: "draft", ...over });
    const draft = await staff.from("risk_assessments").insert(ra({ job_id: jobId })).select("id").single();
    ok(draft, "staff drafting a risk assessment");
    refused(await staff.from("risk_assessments").insert(ra({ status: "issued", issued_at: new Date().toISOString(), reference: "RA-X", job_id: jobId })), "staff inserting an issued risk assessment");
    refused(await staff.from("risk_assessments").update({ status: "issued", issued_at: new Date().toISOString(), issued_by: world.A.staff.id, reference: "RA-X" }).eq("id", (draft.data as any).id).select("id"), "staff issuing their own draft");
    const permit = (over: object = {}) => ({ org_id: world.A.id, permit_type: "hot_works", title: "Welding", scope: "Bay 3", status: "draft", job_id: jobId, ...over });
    ok(await staff.from("permits_to_work").insert(permit()), "staff drafting a permit");
    refused(await staff.from("permits_to_work").insert(permit({ status: "active" })), "staff inserting an active permit");
    // An admin WITHOUT the approve grant is held to the same line as staff; the owner is not.
    refused(await as(world.A.admin.token).from("risk_assessments").update({ status: "issued", issued_at: new Date().toISOString(), issued_by: world.A.admin.id, reference: "RA-Y" }).eq("id", (draft.data as any).id).select("id"), "admin without site_safety:approve issuing");
    // The owner passes the policy: whatever the domain rules then say (here: "needs a named
    // assessor"), it is NOT a row-level-security refusal.
    const own = await as(world.A.owner.token).from("risk_assessments").update({ status: "issued", issued_at: new Date().toISOString(), issued_by: world.A.owner.id, reference: "RA-Z" }).eq("id", (draft.data as any).id);
    expect(own.error?.code, "owner issuing must not be an RLS refusal").not.toBe("42501");
  });

  it("HELD COMPANY · a suspended or cancelled company's crew cannot write; reads and the owner's recovery path remain", async () => {
    const world = w!;
    const staff = as(world.A.staff.token);
    const fuel = { org_id: world.A.id, asset_id: assetId, filled_on: "2026-11-02", litres: 10, cost: 14, created_by: world.A.staff.id };
    try {
      for (const status of ["suspended", "cancelled"]) {
        await setStatus(world.A.id, status);
        refused(await staff.from("asset_fuel_logs").insert(fuel), `fuel log while ${status}`);
        refused(await as(world.A.owner.token).from("sites").insert({ org_id: world.A.id, name: `held ${status}`, kind: "depot" }), `owner writing a site while ${status}`);
        const readBack = await as(world.A.owner.token).from("sites").select("id").eq("org_id", world.A.id);
        expect((readBack.data ?? []).length, `owner can still READ while ${status}`).toBeGreaterThan(0);
        // SECURITY DEFINER RPCs skip RLS: the write-guard TRIGGER must stop an OWNER / ADMIN too.
        for (const who of ["owner", "admin"] as const) {
          refused(await as(world[who === "owner" ? "A" : "A"][who].token).rpc("record_stock_adjustment", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_delta: 1, p_reason: "held" }), `${who} stock adjustment RPC while ${status}`);
          refused(await as(world.A[who].token).rpc("add_job_worker", { p_org_id: world.A.id, p_job_id: jobId, p_user_id: world.A.owner.id }), `${who} add_job_worker RPC while ${status}`);
        }
        refused(await staff.rpc("record_stock_issue", { p_org_id: world.A.id, p_item_id: stockItemId, p_site_id: siteId, p_qty: 1, p_job_id: null, p_material_request_line_id: null, p_notes: "held" }), `stock issue while ${status}`);
      }
    } finally {
      await setStatus(world.A.id, "active");
    }
    ok(await staff.from("asset_fuel_logs").insert(fuel), "fuel log once active again");
  });

  it("has_org_capability · baseline for field modules, admin grants for the rest, staff never, false for non-members", async () => {
    const world = w!;
    const cap = async (token: string, m: string, a: string) =>
      (await as(token).rpc("has_org_capability", { p_org: world.A.id, p_module: m, p_action: a })).data;
    expect(await cap(world.A.staff.token, "stock_field", "create")).toBe(true);
    expect(await cap(world.A.staff.token, "stock_field", "approve")).toBe(false);
    expect(await cap(world.A.staff.token, "payroll", "view")).toBe(false);
    expect(await cap(world.B.staff.token, "stock_field", "create")).toBe(false);
    // A stray grant row on a STAFF membership is ignored (staff hold the baseline only)…
    const smem = (await svc().from("memberships").select("id").eq("org_id", world.A.id).eq("user_id", world.A.staff.id).single()).data as any;
    await svc().from("membership_permissions").insert({ org_id: world.A.id, membership_id: smem.id, module: "stock", action: "approve" });
    expect(await cap(world.A.staff.token, "stock_field", "approve")).toBe(false);
    expect(await cap(world.A.staff.token, "stock", "approve")).toBe(false);
    // …while an ADMIN's grant on the parent module confers the privileged action, and only that.
    const amem = (await svc().from("memberships").select("id").eq("org_id", world.A.id).eq("user_id", world.A.admin.id).single()).data as any;
    expect(await cap(world.A.admin.token, "stock_field", "approve")).toBe(false);
    await svc().from("membership_permissions").insert({ org_id: world.A.id, membership_id: amem.id, module: "stock", action: "approve" });
    expect(await cap(world.A.admin.token, "stock_field", "approve")).toBe(true);
    expect(await cap(world.A.admin.token, "stock", "approve")).toBe(true);
    expect(await cap(world.A.admin.token, "stock", "delete")).toBe(false);
  });
});
