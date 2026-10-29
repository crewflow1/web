import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Operator Migration OS regression guard. Drives the real super-admin browser
 * flow: read → remap → commit → verify inserted business records → rollback →
 * verify reversal, plus a non-super-admin 404 denial. Seeds its own `detected`
 * import via service-role in beforeAll (independent of globalSetup).
 *
 * The service-role client resolves its URL through `assertLocalE2eTarget`, which
 * refuses unless NEXT_PUBLIC_SUPABASE_URL names a LOCAL database — so this
 * destructive (commit/rollback) spec can never touch a non-local target. Enforced
 * by __tests__/security/destructive-target-guard-wiring.test.ts.
 */

const svc = createClient(
  assertLocalE2eTarget("operator-imports.spec.ts"),
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let orgId = "";
let importId = "";

// Authenticate the main test as the dedicated HQ super-admin (minted by globalSetup).
test.use({ storageState: "e2e/.auth/hq.json" });

async function importStatus(): Promise<string> {
  const { data } = await svc.from("imports").select("status").eq("id", importId).single();
  return (data as { status: string } | null)?.status ?? "?";
}

async function customerCount(): Promise<number> {
  const { count } = await svc
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("name", ["Op Acme Ltd", "Op Beta LLC"]);
  return count ?? -1;
}

test.beforeAll(async () => {
  const { data: m, error: mErr } = await svc
    .from("memberships")
    .select("org_id, user_id")
    .eq("role", "owner")
    .limit(1)
    .single();
  if (mErr || !m) throw new Error(`no owner membership found: ${mErr?.message ?? "null"}`);
  orgId = (m as { org_id: string }).org_id;
  const ownerId = (m as { user_id: string }).user_id;

  await svc.from("imports").delete().eq("org_id", orgId).eq("name", "Operator E2E Verify");
  const { data: imp } = await svc
    .from("imports")
    .insert({ org_id: orgId, name: "Operator E2E Verify", status: "detected", created_by: ownerId })
    .select("id")
    .single();
  importId = (imp as { id: string }).id;
  const { data: file } = await svc
    .from("import_files")
    .insert({ org_id: orgId, import_id: importId, filename: "op.csv", storage_path: `${orgId}/${importId}/op.csv` })
    .select("id")
    .single();
  const fileId = (file as { id: string }).id;
  await svc.from("import_rows").insert([
    { import_id: importId, org_id: orgId, file_id: fileId, source_row_number: 1, entity_type: "customer", raw: { Company: "Op Acme Ltd", Email: "acme@op.test" }, mapped: { name: "Op Acme Ltd", email: "acme@op.test" }, confidence: 100, status: "pending" },
    { import_id: importId, org_id: orgId, file_id: fileId, source_row_number: 2, entity_type: "customer", raw: { Company: "Op Beta LLC", Email: "beta@op.test" }, mapped: { name: "Op Beta LLC", email: "beta@op.test" }, confidence: 100, status: "pending" },
  ]);
  // Clean any leftover customers from a prior run.
  await svc.from("customers").delete().eq("org_id", orgId).in("name", ["Op Acme Ltd", "Op Beta LLC"]);
});

test("operator read → remap → commit → verify → rollback", async ({ page }) => {
  page.on("dialog", (d) => d.accept()); // commit/rollback window.confirm

  // READ (super-admin): the operator surface + the seeded import.
  await page.goto(`/admin/imports?org=${orgId}`);
  await expect(page.getByRole("heading", { name: "Migration OS — operator" })).toBeVisible();
  await page.getByRole("link", { name: "Operator E2E Verify" }).click();
  // The link is a client navigation to /admin/imports/<id>. Wait for the swap to
  // LAND before asserting — asserting mid-navigation is the historical flake
  // ("element(s) not found" on the detail heading).
  await page.waitForURL(/\/admin\/imports\/[^/?]+/);
  await expect(page.getByRole("heading", { name: "Operator E2E Verify" })).toBeVisible();

  // REMAP: rebind customer.name → the "Company" source column, submit.
  await page.locator('select[name="map.name"]').first().selectOption("Company");
  await page.getByRole("button", { name: /Re-map customer/i }).click();
  // Each action server-action REDIRECTS to ...&saved=remapped; wait for the
  // redirect to land so the banner assertion never races the navigation (the
  // flake at this line).
  await page.waitForURL(/saved=remapped/);
  await expect(page.getByText(/Re-mapped \d+ row/)).toBeVisible();

  expect(await customerCount()).toBe(0); // nothing committed yet

  // COMMIT: inserts the two customers into the target org's live table.
  await page.getByRole("button", { name: "Commit import" }).click();
  await page.waitForURL(/saved=committed/);
  await expect(page.getByText(/Committed \d+ row/)).toBeVisible();
  await expect.poll(importStatus, { timeout: 10000 }).toBe("committed");
  await expect.poll(customerCount, { timeout: 10000 }).toBe(2);
  const { count: audit } = await svc.from("import_audit").select("*", { count: "exact", head: true }).eq("import_id", importId);
  expect(audit).toBe(2); // commit wrote the audit trail (what rollback keys off)

  // ROLLBACK: deletes exactly the import-created records.
  await page.getByRole("button", { name: "Roll back import" }).click();
  await page.waitForURL(/saved=rolled_back/);
  await expect(page.getByText(/Rolled back — every record/)).toBeVisible();
  await expect.poll(importStatus, { timeout: 10000 }).toBe("rolled_back");
  await expect.poll(customerCount, { timeout: 10000 }).toBe(0);
});

test("denial: a non-super-admin cannot reach the operator surface (404)", async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: "e2e/.auth/owner.json" });
  const p = await ctx.newPage();
  const resp = await p.goto(`/admin/imports?org=${orgId}`);
  expect(resp?.status()).toBe(404);
  await ctx.close();
});
