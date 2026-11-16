/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * D-17 — a plain STAFF member performs the ordinary construction duties through the real
 * browser (production build, real Postgres). Seeds into the harness org with the service role,
 * then drives the UI as e2e/.auth/staff.json and asserts the DB row (attributed to the staff
 * member) and persistence after reload. The data-layer allow/deny pairs live in
 * __tests__/integration/adversarial/staff-field-operations.test.ts; this proves the journeys.
 */
const SLUG = "e2e-harness-org";
const STAFF_EMAIL = "e2e-staff@crewflow.test";
const TAG = `F${Date.now().toString(36)}`;

function svc() {
  return createClient(assertLocalE2eTarget("staff-field-operations.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as { from: (t: string) => any; rpc: (f: string, a: object) => Promise<any> };
}

test.describe.configure({ mode: "serial" });
test.describe("D-17 staff field operations (browser)", () => {
  test.use({ storageState: "e2e/.auth/staff.json" });
  const db = svc();
  let vanSiteId = "", jobId = "", org = "", staffId = "", siteId = "", itemId = "", poId = "", assetId = "", vehicleId = "", sessionId = "";

  test.beforeAll(async () => {
    org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!org) throw new Error("harness org not found — did globalSetup run?");
    staffId = (await db.from("users").select("id").eq("email", STAFF_EMAIL).maybeSingle()).data?.id;
    if (!staffId) throw new Error("e2e staff user not found");
    siteId = (await db.from("sites").insert({ org_id: org, name: `Depot ${TAG}`, kind: "depot" }).select("id").single()).data.id;
    itemId = (await db.from("stock_items").insert({ org_id: org, name: `Blocks ${TAG}`, unit: "ea" }).select("id").single()).data.id;
    const adj = await db.rpc("record_stock_adjustment", { p_org_id: org, p_item_id: itemId, p_site_id: siteId, p_delta: 40, p_reason: "opening count" });
    if (adj.error) throw new Error(`seed stock: ${adj.error.message}`);
    poId = (await db.from("purchase_orders").insert({ org_id: org, number: `PO-${TAG}`, status: "sent", subtotal: 500, vat_total: 100 }).select("id").single()).data.id;
    await db.from("purchase_order_line_items").insert({ org_id: org, purchase_order_id: poId, description: `Dense blocks ${TAG}`, qty: 100, unit: "ea", unit_price: 5, vat_rate: 20, line_total: 500, sort_order: 0 });
    assetId = (await db.from("assets").insert({ org_id: org, name: `Breaker ${TAG}` }).select("id").single()).data.id;
    vehicleId = (await db.from("assets").insert({ org_id: org, name: `Van ${TAG}` }).select("id").single()).data.id;
    await db.from("fleet_vehicles").insert({ org_id: org, asset_id: vehicleId });
    const customer = (await db.from("customers").insert({ org_id: org, name: `Cust ${TAG}` }).select("id").single()).data.id;
    jobId = (await db.from("jobs").insert({ org_id: org, customer_id: customer, assigned_to: staffId, status: "new" }).select("id").single()).data.id;
    await db.from("job_assignments").insert({ org_id: org, job_id: jobId, user_id: staffId });
    vanSiteId = (await db.from("sites").insert({ org_id: org, name: `Van stock ${TAG}`, kind: "vehicle", vehicle_asset_id: vehicleId }).select("id").single()).data.id;
    sessionId = (await db.from("stocktake_sessions").insert({ org_id: org, site_id: siteId, reference: `ST-${TAG}`, status: "counting", opened_by: staffId }).select("id").single()).data.id;
    await db.from("stocktake_lines").insert({ org_id: org, session_id: sessionId, stock_item_id: itemId, expected_qty: 40 });
  });

  test("STOCK · staff issue stock from an item page; the ledger names them", async ({ page }) => {
    await page.goto(`/stock/items/${itemId}`);
    await page.getByRole("tab", { name: /issue out/i }).click();
    await expect(page.getByLabel("Out of")).toHaveValue(/.+/);
    await page.getByLabel(/How many/).fill("5");
    await page.getByRole("button", { name: /issue 5/i }).click();
    await expect.poll(async () => (await db.from("stock_movements").select("actor_id, movement_type").eq("org_id", org).eq("stock_item_id", itemId).eq("movement_type", "issue")).data?.[0]?.actor_id, { timeout: 15_000 }).toBe(staffId);
  });

  test("GOODS RECEIVED · staff record a delivery against a purchase order", async ({ page }) => {
    await page.goto(`/purchase-orders/${poId}`);
    const deliveries = page.getByRole("region", { name: "Deliveries" });
    await deliveries.getByRole("button", { name: /^receive delivery$/i }).click();
    await page.getByRole("button", { name: /^all arrived$/i }).click();
    await page.getByLabel(/delivery note no/i).fill(`DN-${TAG}`);
    await page.getByRole("button", { name: /confirm delivery/i }).click();
    await expect.poll(async () => (await db.from("goods_received_notes").select("created_by, status").eq("org_id", org).eq("purchase_order_id", poId)).data?.[0]?.status, { timeout: 15_000 }).toBe("posted");
    const grn = (await db.from("goods_received_notes").select("created_by").eq("purchase_order_id", poId).limit(1)).data?.[0];
    expect(grn?.created_by).toBe(staffId);
  });

  test("FUEL · staff log a fill on a vehicle", async ({ page }) => {
    await page.goto(`/fleet/vehicles/${vehicleId}`);
    await page.locator("#fuel_odometer").fill("12000");
    await page.locator("#litres").fill("42");
    await page.locator("#cost").fill("63.50");
    await page.getByRole("button", { name: /log fill|add fill|save/i }).first().click();
    await expect.poll(async () => (await db.from("asset_fuel_logs").select("created_by").eq("asset_id", vehicleId)).data?.[0]?.created_by, { timeout: 15_000 }).toBe(staffId);
  });

  test("DEFECT · staff report a fault on an asset", async ({ page }) => {
    await page.goto(`/assets/${assetId}`);
    await page.getByText(/Report fault/).click();
    await page.locator("details", { hasText: "Report fault" }).getByLabel(/What's wrong/).fill(`Cracked guard ${TAG}`);
    const submit = page.locator("details", { hasText: "Report fault" }).getByRole("button");
    await waitForHydrated(submit);
    await submit.click();
    await expect.poll(async () => (await db.from("asset_maintenance_cases").select("reported_by").eq("asset_id", assetId)).data?.[0]?.reported_by, { timeout: 15_000 }).toBe(staffId);
  });

  test("STOCK COUNT · staff record a count on a session that is counting", async ({ page }) => {
    await page.goto(`/stock/stocktake/${sessionId}`);
    await page.getByRole("spinbutton").first().fill("38");
    await page.getByRole("button", { name: /save|record|count/i }).first().click();
    await expect.poll(async () => (await db.from("stocktake_lines").select("counted_qty, counted_by").eq("session_id", sessionId)).data?.[0]?.counted_by, { timeout: 15_000 }).toBe(staffId);
  });

  test("CUSTODY · staff take an asset into their OWN custody", async ({ page }) => {
    await page.goto(`/assets/${assetId}`);
    const form = page.locator("form", { has: page.locator('select[aria-label="Where to"]') });
    await form.locator('select[aria-label="Where to"]').selectOption("issued_to_staff");
    await form.locator('select[aria-label="Staff"]').selectOption(staffId);
    const submit = form.getByRole("button");
    await waitForHydrated(submit);
    await submit.click();
    await expect.poll(async () => (await db.from("asset_assignments").select("assignee_id, assigned_by, status").eq("asset_id", assetId)).data?.[0]?.assignee_id, { timeout: 15_000 }).toBe(staffId);
    expect((await db.from("asset_assignments").select("assigned_by").eq("asset_id", assetId).limit(1)).data?.[0]?.assigned_by).toBe(staffId);
  });

  test("INSPECTION · staff start an inspection on an asset and complete it themselves", async ({ page }) => {
    await page.goto(`/assets/${assetId}`);
    const create = page.locator("form", { has: page.locator('input[name="title"][placeholder*="LOLER"]') });
    await create.locator('input[name="title"]').fill(`Pre-use check ${TAG}`);
    const start = create.getByRole("button");
    await waitForHydrated(start);
    await start.click();
    await expect.poll(async () => (await db.from("asset_inspections").select("status, created_by").eq("asset_id", assetId).eq("title", `Pre-use check ${TAG}`)).data?.[0]?.created_by, { timeout: 15_000 }).toBe(staffId);
    expect((await db.from("asset_inspections").select("status").eq("asset_id", assetId).eq("title", `Pre-use check ${TAG}`).limit(1)).data?.[0]?.status).toBe("draft");
    // The action row lands BEFORE the client receives the action result; StateForm then starts a
    // full-document `window.location.assign(redirectTo)`. Let that navigation settle (URL + document
    // load) before the next goto, or the goto aborts it / is aborted by it (net::ERR_ABORTED).
    await expect(page).toHaveURL(/\/assets\/[^/?]+\?saved=inspection/);
    await page.waitForLoadState("load");
    // …and completes (issues) their OWN draft with an outcome.
    await page.goto(`/assets/${assetId}`);
    const issue = page.locator("form", { has: page.locator('select[name="outcome"]') }).first();
    await issue.locator('select[name="outcome"]').selectOption({ index: 1 });
    const issueBtn = issue.getByRole("button");
    await waitForHydrated(issueBtn);
    await issueBtn.click();
    await expect.poll(async () => (await db.from("asset_inspections").select("status").eq("asset_id", assetId).eq("title", `Pre-use check ${TAG}`)).data?.[0]?.status, { timeout: 15_000 }).toBe("issued");
  });

  test("VAN STOCK · staff load stock from the depot onto a van; a conserving transfer in their name", async ({ page }) => {
    await page.goto("/stock/vans");
    await page.getByRole("tab", { name: /load onto van/i }).click();
    await page.locator("#vehicle_site_id").selectOption(vanSiteId);
    await page.locator("#depot_site_id").selectOption(siteId);
    await page.locator("#stock_item_id").selectOption(itemId);
    await page.locator("#qty").fill("4");
    const load = page.getByRole("button", { name: /^load 4/i });
    await waitForHydrated(load);
    await load.click();
    await expect.poll(async () => ((await db.from("stock_movements").select("movement_type, actor_id, site_id, qty").eq("org_id", org).eq("stock_item_id", itemId).in("movement_type", ["transfer_out", "transfer_in"])).data ?? []).length, { timeout: 15_000 }).toBe(2);
    const legs = (await db.from("stock_movements").select("movement_type, actor_id, site_id, qty").eq("stock_item_id", itemId).in("movement_type", ["transfer_out", "transfer_in"])).data as any[];
    expect(legs.every((l) => l.actor_id === staffId && Number(l.qty) === 4)).toBe(true);
    expect(legs.find((l) => l.movement_type === "transfer_in")?.site_id).toBe(vanSiteId);
    expect(legs.find((l) => l.movement_type === "transfer_out")?.site_id).toBe(siteId);
  });

  test("PENDING COST · staff upload a receipt; a PENDING entry + the file are stored and they see a confirmation", async ({ page }) => {
    const before = ((await db.from("expense_drafts").select("id").eq("org_id", org)).data ?? []).length;
    await page.goto("/expenses/new");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await page.locator('input[type="file"][name="file"]').setInputFiles({ name: `receipt-${TAG}.png`, mimeType: "image/png", buffer: png });
    await page.getByRole("button", { name: /upload/i }).click();
    // a field submitter is NOT bounced to "forbidden": they land on a confirmation
    await expect(page).toHaveURL(/\/expenses\/new\?saved=submitted/, { timeout: 30_000 });
    await expect(page.getByRole("status")).toContainText(/submitted/i);
    const rows = ((await db.from("expense_drafts").select("id, status, approved_by, upload_id").eq("org_id", org).order("created_at", { ascending: false })).data ?? []) as any[];
    expect(rows.length).toBe(before + 1);
    expect(rows[0].status).toBe("extracted");   // pending — never approved by the submitter
    expect(rows[0].approved_by).toBeNull();
    const files = await (db as any).storage.from("receipts").list(`${org}/drafts`, { search: rows[0].upload_id });
    expect((files.data ?? []).length).toBe(1);
    // and the management review screen stays closed to them
    await page.goto(`/expenses/${rows[0].id}`);
    await expect(page).not.toHaveURL(new RegExp(`/expenses/${rows[0].id}`));
  });

  test("SITE SAFETY · staff draft a risk assessment (a DRAFT — publishing is refused)", async ({ page }) => {
    await page.goto("/health-safety/new");
    const gen = page.locator("form", { has: page.locator('select[name="templateKey"]') });
    await gen.locator('select[name="templateKey"]').selectOption({ index: 1 });
    await gen.locator('select[name="jobId"]').selectOption(jobId);
    const submit = gen.getByRole("button");
    await waitForHydrated(submit);
    await submit.click();
    await expect.poll(async () => (await db.from("risk_assessments").select("status, created_by").eq("org_id", org).eq("job_id", jobId)).data?.[0]?.created_by, { timeout: 20_000 }).toBe(staffId);
    expect((await db.from("risk_assessments").select("status").eq("job_id", jobId).limit(1)).data?.[0]?.status).toBe("draft");
  });

});
