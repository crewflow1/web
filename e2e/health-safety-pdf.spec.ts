/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * H&S evidence PDF (M4) — authenticated download, real bytes. Seeds an ISSUED RAMS,
 * then the authenticated owner GETs the PDF route and receives a well-formed
 * application/pdf. A draft RAMS yields 409 (no evidence to produce). This is a GET
 * route (not a server-action POST), so it exercises the real authenticated path.
 */
const SLUG = "e2e-harness-org";
function svc() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
}

test.describe("health & safety PDF — authenticated evidence download", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });
  let issuedId = "", draftId = "";
  const REF = `RA-PDF-${Date.now()}`;

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()).data?.id;
    if (!orgId) throw new Error("seeded org not found");
    const issued = await db.from("risk_assessments").insert({ org_id: orgId, title: "PDF RAMS", activity: "x" }).select("id").single();
    issuedId = String(issued.data?.id);
    await db.from("risk_assessment_hazards").insert({ org_id: orgId, risk_assessment_id: issuedId, hazard: "Fall", likelihood: 4, severity: 5, control_measures: "harness" });
    await db.from("risk_assessments").update({ status: "issued", reference: REF, issued_at: new Date().toISOString() }).eq("id", issuedId);
    draftId = String((await db.from("risk_assessments").insert({ org_id: orgId, title: "Draft RAMS", activity: "x" }).select("id").single()).data?.id);
  });

  test("an issued RAMS renders a well-formed application/pdf", async ({ page }) => {
    const res = await page.request.get(`/api/health-safety/${issuedId}/pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    const body = await res.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  });

  test("a draft RAMS has no evidence PDF (409)", async ({ page }) => {
    const res = await page.request.get(`/api/health-safety/${draftId}/pdf`);
    expect(res.status()).toBe(409);
  });
});
