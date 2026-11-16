/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";
import { navForRole, utilityForRole, areaLandingHref } from "../app/(app)/_nav/nav-model";

/**
 * A field worker's launch journeys on a PHONE (390 × 844), as the e2e STAFF user, on the
 * production build against the real local Postgres + Storage:
 *
 *   1. NO DEAD ENDS — every destination the staff navigation offers (each link and each area
 *      header's landing), the D-17 field surfaces, and every job tab shown on an assigned job:
 *      renders (< 400), is not bounced home or to sign-in, is not a "not found" page, does not
 *      scroll sideways, and throws no hydration error;
 *   2. assigned jobs — the worker's list shows their job and not a colleague's, fits a 320 px
 *      phone with long job details, and offers no create/template/import actions they are refused;
 *   3. while a job streams in, its loading skeleton fits the phone;
 *   4. clock in on the assigned job, then clock out — both confirm and persist;
 *   5. progress — a worker records progress on their job;
 *   6. job documents — a worker adds a team document and sends a private one to the office;
 *      the server accepts exactly what the page offers, and the private list stays hidden.
 */
const SLUG = "e2e-harness-org";
const STAFF_EMAIL = "e2e-staff@crewflow.test";
const TAG = `LS${Date.now().toString(36)}`;

const db = createClient(assertLocalE2eTarget("launch-staff-phone.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as any;

const S = {
  org: "", staffId: "", mine: "", notMine: "", long: "",
  mineCustomer: `Mine ${TAG}`, otherCustomer: `Other ${TAG}`,
  // long content a real job list carries: a long customer name, an unbroken site-address token
  // and an unbroken note (a pasted reference) — none may push the list past the screen edge
  longCustomer: `Long ${TAG} Northern Ireland Housing Executive Planned Maintenance Contract Phase Two`,
};

/** D-17 field surfaces staff keep that are reached from pages rather than the menu. */
const FIELD_PAGES = ["/expenses/new", "/assets/scan", "/stock/vans", "/stock/stocktake", "/fleet/fuel", "/site-reports"];

function watchHydration(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /hydrat|Minified React error #(418|423|425)/i.test(m.text())) errors.push(`${page.url()} ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${page.url()} pageerror: ${e.message}`));
  return errors;
}

/** Streamed pages first paint a loading skeleton; measure the page itself, once it has arrived. */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await expect.poll(() => page.locator(".animate-pulse").count(), { timeout: 10_000 }).toBe(0).catch(() => undefined);
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe.configure({ mode: "serial" });
test.describe("staff launch journeys on a phone (browser)", () => {
  test.use({ storageState: "e2e/.auth/staff.json", viewport: { width: 390, height: 844 } });

  test.beforeAll(async () => {
    S.org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!S.org) throw new Error("harness org not found — did globalSetup run?");
    S.staffId = (await db.from("users").select("id").eq("email", STAFF_EMAIL).maybeSingle()).data?.id;
    if (!S.staffId) throw new Error("e2e staff user not found");
    const c1 = (await db.from("customers").insert({ org_id: S.org, name: S.mineCustomer }).select("id").single()).data.id;
    const c2 = (await db.from("customers").insert({ org_id: S.org, name: S.otherCustomer }).select("id").single()).data.id;
    const a = await db.from("jobs").insert({ org_id: S.org, customer_id: c1, assigned_to: S.staffId, status: "in-progress", scheduled_date: "2026-12-01" }).select("id").single();
    if (a.error) throw new Error(`job: ${a.error.message}`);
    S.mine = a.data.id;
    await db.from("job_assignments").insert({ org_id: S.org, job_id: S.mine, user_id: S.staffId });
    const b = await db.from("jobs").insert({ org_id: S.org, customer_id: c2, status: "in-progress", scheduled_date: "2026-12-01" }).select("id").single();
    if (b.error) throw new Error(`other job: ${b.error.message}`);
    S.notMine = b.data.id;
    const c3 = (await db.from("customers").insert({ org_id: S.org, name: S.longCustomer }).select("id").single()).data.id;
    const l = await db.from("jobs").insert({
      org_id: S.org, customer_id: c3, assigned_to: S.staffId, status: "new", scheduled_date: "2026-12-02",
      site_address_line1: "Unit-14B-Northgate-Industrial-Estate-Ballymena-Road-Antrim", site_postcode: "BT41 1AA",
      notes: `Ref:WO-2026-000000000000000000000000000000000000000000000000-${TAG}`,
    }).select("id").single();
    if (l.error) throw new Error(`long job: ${l.error.message}`);
    S.long = l.data.id;
    await db.from("job_assignments").insert({ org_id: S.org, job_id: S.long, user_id: S.staffId });
    // a shift left open by an earlier run of another spec would block clock-in; close it
    await db.from("time_entries").update({ ended_at: new Date().toISOString() }).eq("user_id", S.staffId).is("ended_at", null);
  });

  test("every destination offered to staff renders on a phone: no dead ends, no sideways scroll, no hydration errors", async ({ page }) => {
    test.setTimeout(240_000);
    const hydration = watchHydration(page);
    const areas = [...navForRole("staff"), ...utilityForRole("staff")];
    const hrefs = new Set<string>();
    for (const a of areas) {
      hrefs.add(areaLandingHref(a));
      for (const c of a.children) hrefs.add(c.href);
    }
    for (const p of FIELD_PAGES) hrefs.add(p);
    for (const sub of ["", "/blueprints", "/timeline", "/certificate", "/warranties"]) hrefs.add(`/jobs/${S.mine}${sub}`);

    const problems: string[] = [];
    for (const href of hrefs) {
      const res = await page.goto(href);
      const status = res?.status() ?? 0;
      await settled(page);
      const path = new URL(page.url()).pathname;
      if (status >= 400) problems.push(`${href}: HTTP ${status}`);
      if (path === "/login") problems.push(`${href}: sent to sign-in`);
      else if (path !== href.split("?")[0] && (path === "/me" || path === "/dashboard")) problems.push(`${href}: bounced to ${path} (offered but refused)`);
      if (await page.getByRole("heading", { name: /page not found|not found|404|page doesn.t exist/i }).count()) problems.push(`${href}: not-found page`);
      const ox = await overflowPx(page);
      if (ox > 1) problems.push(`${href}: ${ox}px horizontal overflow at 390px`);
    }
    expect(problems, `staff destinations with problems:\n${problems.join("\n")}`).toEqual([]);
    expect(hydration, "no hydration errors").toEqual([]);
  });

  test("assigned jobs: the worker sees their own job and not a colleague's", async ({ page }) => {
    await page.goto("/jobs");
    await expect(page.getByText(S.mineCustomer).filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(S.otherCustomer)).toHaveCount(0);
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
    // a colleague's job is not reachable by URL: the not-found page, none of its details.
    // (HTTP status is 200, not 404: the job route streams behind its loading boundary, so
    // notFound() arrives after the headers — recorded as a P3 finding.)
    await page.goto(`/jobs/${S.notMine}`);
    await expect(page.getByRole("heading", { name: "That page doesn't exist" })).toBeVisible();
    await expect(page.getByText(S.otherCustomer)).toHaveCount(0);
  });

  test("the jobs list fits a small phone with long job details, and offers staff no dead-end actions", async ({ page }) => {
    // 320 px (smallest common phone) rather than 390: margin for platform font widths, which
    // differ between macOS and the Linux CI runner (the header overflowed 7 px only on CI)
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto("/jobs");
    await settled(page);
    await expect(page.getByText(S.longCustomer).filter({ visible: true }).first()).toBeVisible();
    expect(await overflowPx(page), "/jobs at 320px with long job details").toBeLessThanOrEqual(1);
    // creating a job and job templates are refused to staff (/jobs/new, /jobs/templates send them
    // home), so the list must not offer them
    await expect(page.getByRole("link", { name: /new job/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Templates", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^import/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Calendar", exact: true }).filter({ visible: true })).toHaveCount(1);
  });

  test("while a job streams in, its loading skeleton fits the phone (no sideways scroll)", async ({ page }) => {
    await page.goto("/jobs");
    await settled(page);
    // hold the navigation's page payload (not the loading-boundary prefetch) so the skeleton stays up
    await page.route(`**/jobs/${S.mine}**`, async (route) => {
      const h = route.request().headers();
      if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 4_000));
      await route.continue();
    });
    const link = page.locator(`a[href="/jobs/${S.mine}"]`).filter({ visible: true }).first();
    await waitForHydrated(link);
    await link.click();
    await expect(page.locator(".animate-pulse").first()).toBeVisible();
    expect(await overflowPx(page), "loading skeleton overflow at 390px").toBeLessThanOrEqual(1);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("clock in on the assigned job, then clock out: both confirm and persist", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/me");
    const clockIn = page.getByRole("button", { name: "Clock in" });
    await waitForHydrated(clockIn);
    await page.locator('select[name="job_id"]').selectOption(S.mine);
    await page.locator('input[name="note"]').fill(`Shift ${TAG}`);
    await clockIn.click();
    await expect(page.getByText("Clocked in. Have a good shift.")).toBeVisible({ timeout: 15_000 });
    const open = (await db.from("time_entries").select("id, job_id, note, ended_at").eq("user_id", S.staffId).is("ended_at", null)).data;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ job_id: S.mine, note: `Shift ${TAG}`, ended_at: null });
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);

    const clockOut = page.getByRole("button", { name: "Clock out" });
    await waitForHydrated(clockOut);
    await clockOut.click();
    await expect(page.getByText("Clocked out. Hours saved.")).toBeVisible({ timeout: 15_000 });
    const closed = (await db.from("time_entries").select("ended_at").eq("id", open[0].id).single()).data;
    expect(closed.ended_at).not.toBeNull();
    await expect(page.getByRole("button", { name: "Clock in" })).toBeVisible();
  });

  test("progress: a worker records 40% on their job; it is saved in their name", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`/jobs/${S.mine}`);
    const form = page.locator("form", { has: page.locator("#percent") });
    const record = form.getByRole("button", { name: "Record" });
    await waitForHydrated(record);
    await page.locator("#percent").fill("40");
    await page.locator("#note").fill(`Second fix ${TAG}`);
    await record.click();
    await expect(page).toHaveURL(/saved=progress/, { timeout: 15_000 });
    const rows = (await db.from("job_progress_observations").select("percent, note, recorded_by").eq("job_id", S.mine)).data;
    expect(rows.map((r: any) => ({ ...r, percent: Number(r.percent) }))).toEqual([{ percent: 40, note: `Second fix ${TAG}`, recorded_by: S.staffId }]);
  });

  test("job documents: a team document and a private drop-off both store; the private list stays hidden", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`/jobs/${S.mine}`);
    const teamForm = page.locator("form", { has: page.locator("#jobdoc-title-staff") });
    const upload = teamForm.getByRole("button", { name: "Upload document" });
    await waitForHydrated(upload);
    await page.locator("#jobdoc-title-staff").fill(`Test sheet ${TAG}`);
    await teamForm.locator('input[type="file"]').first().setInputFiles({ name: "sheet.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") });
    await upload.click();
    await expect(teamForm.getByText("Uploaded.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Test sheet ${TAG}`).first()).toBeVisible({ timeout: 15_000 });

    const dropForm = page.locator("form", { has: page.getByRole("button", { name: "Send to office" }) });
    const send = dropForm.getByRole("button", { name: "Send to office" });
    await waitForHydrated(send);
    await dropForm.locator("#jobdoc-title-private").fill(`Private note ${TAG}`);
    await dropForm.locator('input[type="file"]').first().setInputFiles({ name: "private.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") });
    await send.click();
    await expect(dropForm.getByText(/^Sent\. The office can see this/)).toBeVisible({ timeout: 20_000 });

    const docs = (await db.from("job_documents").select("title, visibility").eq("job_id", S.mine).order("title")).data;
    expect(docs).toEqual([
      { title: `Private note ${TAG}`, visibility: "private" },
      { title: `Test sheet ${TAG}`, visibility: "staff" },
    ]);
    await page.reload();
    await expect(page.getByText(`Private note ${TAG}`), "the worker cannot see private documents").toHaveCount(0);
    expect(await overflowPx(page)).toBeLessThanOrEqual(1);
  });
});
