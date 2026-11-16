/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * A field worker signs an issued RAMS on a phone.
 *
 * The sign-off WRITE had no browser proof at all (the existing spec seeds the acknowledgement and
 * only reads the register, as the owner). This drives the real form as the e2e STAFF user at a
 * phone viewport and asserts the acknowledgement row — attributed to that worker, anchored to the
 * issued version — and that it is still shown after a reload. Production build, real Postgres.
 */
const SLUG = "e2e-harness-org";
const STAFF_EMAIL = "e2e-staff@crewflow.test";
const TAG = `R${Date.now().toString(36)}`;
const TITLE = `Roof access RAMS ${TAG}`;
const REF = `RA-${TAG}`;

function svc() {
  return createClient(assertLocalE2eTarget("staff-rams-signoff.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as { from: (t: string) => any };
}

test.describe("staff sign an issued RAMS on a phone (browser)", () => {
  test.use({ storageState: "e2e/.auth/staff.json", viewport: { width: 390, height: 844 } });
  const db = svc();
  let org = "", staffId = "", raId = "";

  test.beforeAll(async () => {
    org = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!org) throw new Error("harness org not found — did globalSetup run?");
    staffId = (await db.from("users").select("id").eq("email", STAFF_EMAIL).maybeSingle()).data?.id;
    if (!staffId) throw new Error("e2e staff user not found");
    // Staff may read a RAMS only when it belongs to a job they are assigned to (RLS) — so this
    // is an ASSIGNED RAMS: a job, the worker on its crew, the RAMS linked to that job.
    const customer = (await db.from("customers").insert({ org_id: org, name: `Cust ${TAG}` }).select("id").single()).data.id;
    const job = await db.from("jobs").insert({ org_id: org, customer_id: customer, assigned_to: staffId, status: "new" }).select("id").single();
    if (job.error) throw new Error(`job: ${job.error.message}`);
    await db.from("job_assignments").insert({ org_id: org, job_id: job.data.id, user_id: staffId });
    const ra = await db.from("risk_assessments").insert({ org_id: org, title: TITLE, activity: "Working at height", job_id: job.data.id }).select("id").single();
    if (ra.error) throw new Error(`risk assessment: ${ra.error.message}`);
    raId = ra.data.id;
    const issued = await db.from("risk_assessments").update({ status: "issued", reference: REF, issued_at: new Date().toISOString() }).eq("id", raId);
    if (issued.error) throw new Error(`issue: ${issued.error.message}`);
  });

  test("a RAMS for a job the worker is NOT assigned to stays invisible (404, nothing signable)", async ({ page }) => {
    const other = await db.from("risk_assessments").insert({ org_id: org, title: `Other crew RAMS ${TAG}`, activity: "Excavation" }).select("id").single();
    if (other.error) throw new Error(`other: ${other.error.message}`);
    await db.from("risk_assessments").update({ status: "issued", reference: `${REF}-X`, issued_at: new Date().toISOString() }).eq("id", other.data.id);
    await page.goto(`/health-safety/${other.data.id}`);
    await expect(page.getByRole("heading", { name: "That page doesn't exist" })).toBeVisible();
    await expect(page.getByRole("button", { name: "I have read and understood — sign" })).toHaveCount(0);
  });

  const acks = async () =>
    ((await db.from("safety_acknowledgements").select("user_id, subject_version, signed_name").eq("subject_id", raId)).data ?? []) as any[];

  test("the worker reads the RAMS, signs with their name, and the acknowledgement persists", async ({ page }) => {
    await page.goto(`/health-safety/${raId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    expect(await acks(), "nothing signed yet").toHaveLength(0);

    const sign = page.getByRole("button", { name: "I have read and understood — sign" });
    await waitForHydrated(sign);
    await page.locator('input[name="signedName"]').fill("Sam Siteworker");
    await sign.click();

    // The confirmation must arrive within the default 5 s. Before the form moved to <StateForm>
    // the write took ~0.1 s but the page stalled for exactly 10 s before confirming (D-12).
    await expect(page.getByText(/You acknowledged this on/i)).toBeVisible();
    const rows = await acks();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: staffId, subject_version: REF, signed_name: "Sam Siteworker" });

    // still signed after a reload; the form is gone (a second signature cannot be added)
    await page.reload();
    await expect(page.getByText(/You acknowledged this on/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "I have read and understood — sign" })).toHaveCount(0);
    expect(await acks()).toHaveLength(1);

    // usable on a phone: no sideways scroll
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no horizontal overflow at 390px").toBeLessThanOrEqual(1);
  });
});
