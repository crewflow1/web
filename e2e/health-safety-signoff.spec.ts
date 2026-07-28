/* eslint-disable @typescript-eslint/no-explicit-any -- seed scaffolding: the
   generated Database types don't cover the H&S tables, so the service-role seed
   goes through a loose cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Operative sign-off (H&S M3) — authenticated journey, no mocks. Seeds an ISSUED
 * RAMS + an acknowledgement by the signed-in owner via service-role, then the
 * OWNER opens the RAMS detail and sees the sign-off register with their own
 * version-anchored acknowledgement. The write path (recording an acknowledgement)
 * is proven at the integration tier; the browser write-POST hits the documented
 * local-harness getUser issue (not CI).
 */

const SLUG = "e2e-harness-org";

function svc() {
  return createClient(assertLocalE2eTarget("health-safety-signoff.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("operative sign-off — authenticated register", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let raId = "";
  const TITLE = `Signable RAMS ${Date.now()}`;
  const REF = `RA-E2E-${Date.now()}`;

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");
    const owner = (await db.from("memberships").select("user_id").eq("org_id", orgId).limit(1).maybeSingle()).data?.user_id;
    const ra = await db.from("risk_assessments").insert({ org_id: orgId, title: TITLE, activity: "x" }).select("id").single();
    raId = String(ra.data?.id);
    await db.from("risk_assessments").update({ status: "issued", reference: REF, issued_at: new Date().toISOString() }).eq("id", raId);
    // the owner has already signed this issued version
    await db.from("safety_acknowledgements").insert({
      org_id: orgId, subject_type: "risk_assessment", subject_id: raId, subject_version: REF,
      user_id: owner, statement: `I confirm I have read and understood risk assessment ${REF}.`,
      statement_version: "v1", signed_name: "E2E Owner",
    });
  });

  test("the issued RAMS shows the operative sign-off register + the owner's own acknowledgement", async ({ page }) => {
    await page.goto(`/health-safety/${raId}`);
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(page.getByRole("heading", { name: /operative sign-off/i })).toBeVisible();
    // the current user is shown as having acknowledged (not the sign form)
    await expect(page.getByText(/You acknowledged this on/i)).toBeVisible();
    // the register lists the typed-name attestation
    await expect(page.getByText(/E2E Owner/).first()).toBeVisible();
  });
});
