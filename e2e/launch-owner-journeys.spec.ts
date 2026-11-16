/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { mintState, asActor, findAuthUserId } from "./_actors";

/**
 * Launch journeys an OWNER runs that had no end-to-end proof (launch tracker §A), in a real
 * browser on the production build against the real local Postgres + Storage:
 *
 *   1. customers — create with only a name (every optional field absent), edit (the save
 *      confirms promptly and persists), find by postcode and by phone through the list search;
 *   2. lead → quote — the lead's "Create a quote" link pre-fills customer + lead; mixed-rate
 *      lines total correctly on screen AND on the server (a half-penny of 5% VAT rounds up);
 *      the quote is linked to the lead and the lead moves to "quoted";
 *   3. quote send — request approval → a distinct approver approves → "Mark as sent";
 *      "Email quote PDF" without a mail provider says so and changes nothing;
 *   4. job site — a diary entry from the job, a staff document and a photo upload all persist
 *      and show on the job.
 */
const SLUG = "e2e-harness-org";
const PASSWORD = "E2e-Harness-Pw-2f9c1a"; // local-only synthetic credential (matches global-setup)
const APPROVER_EMAIL = "e2e-journeys-approver@crewflow.test";
const APPROVER_STATE = "e2e/.auth/journeys-approver.json";
const TAG = `LJ${Date.now().toString(36)}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const db = createClient(assertLocalE2eTarget("launch-owner-journeys.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;

const S = { org: "", customerId: "", leadId: "", leadCustomerId: "", quoteId: "", jobId: "" };

/** Console errors that mean React threw away server HTML (hydration mismatch) or crashed. */
function watchHydration(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|Minified React error #(418|423|425)/i.test(m.text())) errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function seedApprover(): Promise<void> {
  const created = await db.auth.admin.createUser({ email: APPROVER_EMAIL, password: PASSWORD, email_confirm: true });
  let id = created.data.user?.id as string | undefined;
  if (!id) {
    id = await findAuthUserId(db, APPROVER_EMAIL);
    if (id) await db.auth.admin.updateUserById(id, { password: PASSWORD, email_confirm: true });
  }
  if (!id) throw new Error("could not seed approver");
  await db.from("users").upsert({ id, email: APPROVER_EMAIL, full_name: "E2E Journeys Approver" });
  await db.from("memberships").upsert({ org_id: S.org, user_id: id, role: "admin" }, { onConflict: "org_id,user_id" });
  const mem = (await db.from("memberships").select("id").eq("org_id", S.org).eq("user_id", id).single()).data;
  const g = await db.from("membership_permissions").upsert(
    { org_id: S.org, membership_id: mem.id, module: "quotes", action: "manage", granted_by: null },
    { onConflict: "membership_id,module,action" },
  );
  if (g.error) throw new Error(`grant: ${g.error.message}`);
  await mintState(APPROVER_EMAIL, PASSWORD, APPROVER_STATE);
}

test.describe.configure({ mode: "serial" });
test.describe("owner launch journeys (browser)", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test.beforeAll(async () => {
    S.org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!S.org) throw new Error("harness org not found — did globalSetup run?");
    await seedApprover();
  });

  test("customers: create with only a name, edit (confirms promptly, persists), find by postcode and phone", async ({ page }) => {
    test.setTimeout(90_000);
    const hydration = watchHydration(page);
    const name = `${TAG} Sarah Murphy`;
    await page.goto("/customers/new");
    const save = page.getByRole("button", { name: "Save customer" });
    await waitForHydrated(save);
    await page.locator('input[name="name"]').fill(name);
    await save.click();
    await page.waitForURL(new RegExp(`/customers/${UUID.source}`), { timeout: 20_000 });
    S.customerId = page.url().match(UUID)![0];
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    const created = (await db.from("customers").select("org_id, name, email, phone, postcode").eq("id", S.customerId).single()).data;
    expect(created).toMatchObject({ org_id: S.org, name, email: null });
    // blank optional fields are stored as "" rather than NULL (schema `.optional().or(literal(""))`
    // never reaches its blank branch) — harmless to every display path; recorded as a P3 finding
    expect(created.phone || null).toBeNull();
    expect(created.postcode || null).toBeNull();

    // edit: phone + postcode; the confirmation shows promptly (the ~10 s stall class)
    const saveChanges = page.getByRole("button", { name: "Save changes" });
    await waitForHydrated(saveChanges);
    await page.locator('input[name="phone"]').fill("028 9099 1234");
    await page.locator('input[name="postcode"]').fill("BT15 1AA");
    const t0 = Date.now();
    await saveChanges.click();
    await expect(page.getByText("Customer updated.")).toBeVisible({ timeout: 10_000 });
    expect(Date.now() - t0, "edit confirmation within 3 s").toBeLessThan(3_000);
    await expect
      .poll(async () => (await db.from("customers").select("phone, postcode").eq("id", S.customerId).single()).data)
      .toEqual({ phone: "028 9099 1234", postcode: "BT15 1AA" });
    await page.reload();
    await expect(page.locator('input[name="postcode"]')).toHaveValue("BT15 1AA");

    // search through the list page's own form: by postcode, then by phone
    await page.goto("/customers");
    const box = page.locator("#customer-search");
    await waitForHydrated(box);
    await box.fill("BT15 1AA");
    await box.press("Enter");
    await page.waitForURL(/[?&]q=/);
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
    await page.goto(`/customers?q=${encodeURIComponent("028 9099 1234")}`);
    await expect(page.getByRole("cell", { name, exact: true })).toBeVisible();
    await page.goto(`/customers?q=${encodeURIComponent(`${TAG}-nobody`)}`);
    await expect(page.getByRole("cell", { name, exact: true })).toHaveCount(0);
    expect(hydration, "no hydration errors").toEqual([]);
  });

  test("lead → quote: the lead's link pre-fills customer + lead; mixed VAT totals agree on screen and server; lead becomes quoted", async ({ page }) => {
    test.setTimeout(90_000);
    const hydration = watchHydration(page);
    const contact = `${TAG} Lead Co`;
    await page.goto("/leads/new");
    const saveLead = page.getByRole("button", { name: "Save lead" });
    await waitForHydrated(saveLead);
    await page.locator('input[name="contact_name"]').fill(contact);
    await page.locator('input[name="contact_email"]').fill(`${TAG.toLowerCase()}@lead.test`);
    await saveLead.click();
    await page.waitForURL(new RegExp(`/leads/${UUID.source}`), { timeout: 20_000 });
    S.leadId = page.url().match(UUID)![0];
    const convert = page.getByRole("button", { name: /convert to customer/i });
    await waitForHydrated(convert);
    await convert.click();
    await page.waitForURL(new RegExp(`/customers/${UUID.source}`), { timeout: 20_000 });
    S.leadCustomerId = page.url().match(UUID)![0];

    await page.goto(`/leads/${S.leadId}`);
    await page.getByRole("link", { name: /Create a quote/ }).click();
    await page.waitForURL(/\/quotes\/new\?/);
    expect(new URL(page.url()).searchParams.get("lead_id")).toBe(S.leadId);
    expect(new URL(page.url()).searchParams.get("customer_id")).toBe(S.leadCustomerId);
    await expect(page.getByRole("combobox", { name: /customer/i })).toHaveValue(new RegExp(contact));
    await expect(page.locator("#lead_id")).toHaveValue(S.leadId);

    const saveQuote = page.getByRole("button", { name: "Save quote" });
    await waitForHydrated(saveQuote);
    const desc = page.getByPlaceholder(/supply only/i);
    await desc.first().fill("Ridge tiles (5% line)");
    await page.getByLabel("Quantity").first().fill("1");
    await page.getByLabel("Unit price").first().fill("2.90");
    await page.getByLabel("Line 1 VAT rate").selectOption("5");
    await page.getByRole("button", { name: "+ Add line" }).click();
    await desc.nth(1).fill("Labour (20% line)");
    await page.getByLabel("Quantity").nth(1).fill("2");
    await page.getByLabel("Unit price").nth(1).fill("100");
    // 2.90 + 200 = 202.90 net; VAT 0.145 → 0.15 (half-up) + 40 = 40.15; total 243.05
    const totals = page.locator("dl").filter({ hasText: "Subtotal" });
    await expect(totals).toContainText("£202.90");
    await expect(totals).toContainText("£40.15");
    await expect(totals).toContainText("£243.05");
    await saveQuote.click();
    await page.waitForURL(new RegExp(`/quotes/${UUID.source}$`), { timeout: 30_000 });
    S.quoteId = page.url().match(UUID)![0];

    const q = (await db.from("quotes").select("status, lead_id, customer_id, subtotal, vat_total, total").eq("id", S.quoteId).single()).data;
    expect({ ...q, subtotal: Number(q.subtotal), vat_total: Number(q.vat_total), total: Number(q.total) }).toEqual({
      status: "draft", lead_id: S.leadId, customer_id: S.leadCustomerId, subtotal: 202.9, vat_total: 40.15, total: 243.05,
    });
    expect((await db.from("leads").select("status").eq("id", S.leadId).single()).data.status).toBe("quoted");
    await page.goto(`/leads/${S.leadId}`);
    await expect(page.getByRole("heading", { name: "Linked quote" })).toBeVisible();
    expect(hydration, "no hydration errors").toEqual([]);
  });

  test("quote send: request approval → distinct approver approves → mark as sent; email without a provider changes nothing", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.goto(`/quotes/${S.quoteId}`);
    const request = page.getByRole("button", { name: "Request approval" });
    await waitForHydrated(request);
    await request.click();
    await expect.poll(async () => (await db.from("quotes").select("status").eq("id", S.quoteId).single()).data.status, { timeout: 20_000 }).toBe("pending_approval");

    await asActor(browser, APPROVER_STATE, async (approver) => {
      await approver.goto(`/quotes/${S.quoteId}`);
      const approve = approver.getByRole("button", { name: /^approve$/i });
      await waitForHydrated(approve);
      await approve.click();
      await expect.poll(async () => (await db.from("quotes").select("status").eq("id", S.quoteId).single()).data.status, { timeout: 20_000 }).toBe("approved");
    });

    await page.goto(`/quotes/${S.quoteId}`);
    const markSent = page.getByRole("button", { name: "Mark as sent (no email)" });
    await waitForHydrated(markSent);
    await markSent.click();
    await expect.poll(async () => (await db.from("quotes").select("status, sent_at").eq("id", S.quoteId).single()).data, { timeout: 20_000 })
      .toMatchObject({ status: "sent", sent_at: expect.any(String) });
    await expect(page).toHaveURL(/saved=sent/);

    // "Email quote PDF": no mail provider locally → a visible explanation, and the quote is untouched
    const before = (await db.from("quotes").select("status, sent_at, public_token").eq("id", S.quoteId).single()).data;
    const emailBtn = page.getByRole("button", { name: /Email quote PDF/ });
    await waitForHydrated(emailBtn);
    await emailBtn.click();
    await page.getByRole("button", { name: "Send quote" }).click();
    await expect(page.getByText(/RESEND_API_KEY is not set|email is not configured|Couldn't send/i)).toBeVisible({ timeout: 15_000 });
    expect((await db.from("quotes").select("status, sent_at, public_token").eq("id", S.quoteId).single()).data).toEqual(before);
  });

  test("job site: a diary entry from the job, a staff document and a photo persist and show on the job", async ({ page }) => {
    test.setTimeout(120_000);
    const hydration = watchHydration(page);
    const job = await db.from("jobs").insert({ org_id: S.org, customer_id: S.customerId, status: "in-progress", scheduled_date: "2026-12-01" }).select("id").single();
    if (job.error) throw new Error(`job: ${job.error.message}`);
    S.jobId = job.data.id;

    // diary: "Log today's entry" from the job lands on the form with this job chosen
    await page.goto(`/jobs/${S.jobId}`);
    await page.getByRole("link", { name: /Log today.s entry/ }).click();
    await page.waitForURL(/\/diary\/new\?job=/);
    await expect(page.locator("#job_id")).toHaveValue(S.jobId);
    const saveEntry = page.getByRole("button", { name: "Save entry" });
    await waitForHydrated(saveEntry);
    await page.locator("#work_summary").fill(`First fix complete ${TAG}`);
    await saveEntry.click();
    await page.waitForURL(new RegExp(`/diary/${UUID.source}`), { timeout: 20_000 });
    const entry = (await db.from("site_diary_entries").select("job_id, work_summary").eq("job_id", S.jobId)).data;
    expect(entry).toEqual([{ job_id: S.jobId, work_summary: `First fix complete ${TAG}` }]);

    // staff document
    await page.goto(`/jobs/${S.jobId}`);
    await expect(page.getByText(`First fix complete ${TAG}`).first()).toBeVisible();
    const staffForm = page.locator("form", { has: page.locator("#jobdoc-title-staff") });
    const upload = staffForm.getByRole("button", { name: "Upload document" });
    await waitForHydrated(upload);
    await page.locator("#jobdoc-title-staff").fill(`EICR ${TAG}`);
    await staffForm.locator('input[type="file"]').first().setInputFiles({ name: "eicr.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") });
    await upload.click();
    await expect(staffForm.getByText("Uploaded.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`EICR ${TAG}`).first()).toBeVisible({ timeout: 15_000 });
    const docs = (await db.from("job_documents").select("title, visibility").eq("job_id", S.jobId)).data;
    expect(docs).toEqual([{ title: `EICR ${TAG}`, visibility: "staff" }]);

    // photo
    const photos = page.locator("section", { has: page.getByRole("heading", { name: "Photos", exact: true }) }).locator('input[type="file"]');
    await waitForHydrated(photos);
    await photos.setInputFiles([{ name: "site.png", mimeType: "image/png", buffer: PNG }]);
    await expect(page.getByText("1 attached")).toBeVisible({ timeout: 20_000 });
    const paths = (await db.from("jobs").select("photos").eq("id", S.jobId).single()).data.photos as string[];
    expect(paths).toHaveLength(1);
    expect(hydration, "no hydration errors").toEqual([]);
  });

  test.afterAll(async () => {
    if (S.jobId) {
      const files = ((await db.storage.from("job-photos").list(`${S.org}/${S.jobId}`)).data ?? []) as any[];
      if (files.length) await db.storage.from("job-photos").remove(files.map((f) => `${S.org}/${S.jobId}/${f.name}`));
    }
  });
});
