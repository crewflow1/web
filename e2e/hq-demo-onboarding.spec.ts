/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seeding client, loose rows */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { waitForHydrated } from "./_hydration";

/**
 * HQ onboarding from the demo DETAIL PANEL provisions the company.
 *
 * The panel's "Confirm onboarding" button posts confirm=ONBOARD, but the server action never
 * read that field, so the confirmation bounced back and nothing was provisioned (the kanban
 * drag path worked). Real browser (production build), real Postgres, the e2e HQ user. This
 * runs ONLY against the local stack (see ./_guard) — it creates a workspace and an auth user.
 */
const HQ_EMAIL = "e2e-hq@crewflow.test";
const HQ_ALLOWLISTED = (process.env.CREWFLOW_SUPERADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).includes(HQ_EMAIL);
const TAG = `hqo${Date.now().toString(36)}`;
const COMPANY = `Onboard Co ${TAG}`;
const EMAIL = `owner-${TAG}@example.test`;

function svc() {
  return createClient(assertLocalE2eTarget("hq-demo-onboarding.spec.ts"), process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as { from: (t: string) => any; auth: any };
}

test.describe("HQ demo detail panel → onboarding (browser)", () => {
  test.use({ storageState: "e2e/.auth/hq.json" });
  const db = svc();
  let demoId = "";

  test.beforeAll(async () => {
    const d = await db.from("demo_requests").insert({ name: "Olive Owner", company: COMPANY, email: EMAIL, phone: "07700900123", status: "new", source: "e2e" }).select("id").single();
    if (d.error) throw new Error(`demo: ${d.error.message}`);
    demoId = d.data.id;
  });

  test.afterAll(async () => {
    const row = (await db.from("demo_requests").select("linked_org_id").eq("id", demoId).maybeSingle()).data;
    if (row?.linked_org_id) await db.from("organizations").delete().eq("id", row.linked_org_id);
    await db.from("demo_requests").delete().eq("id", demoId);
    const users = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const u = users.data?.users?.find((x: any) => x.email === EMAIL);
    if (u) await db.auth.admin.deleteUser(u.id);
  });

  test("Confirm onboarding provisions the workspace and its owner, exactly once", async ({ page }) => {
    test.skip(!HQ_ALLOWLISTED, `CREWFLOW_SUPERADMIN_EMAILS must include ${HQ_EMAIL}`);
    test.setTimeout(90_000);
    await page.goto(`/admin/demos?demo=${demoId}`);
    // Streamed page: wait until each control is hydrated before driving it (see ./_hydration.ts).
    const arm = page.getByRole("button", { name: "Move to onboarding…" });
    await waitForHydrated(arm);
    await arm.click();
    await expect(page.getByText(/This creates a real workspace for/)).toBeVisible();
    const confirm = page.getByRole("button", { name: "Confirm onboarding" });
    await waitForHydrated(confirm);
    await confirm.click();

    // the demo moves on and is linked to a real company …
    await expect.poll(async () => (await db.from("demo_requests").select("status").eq("id", demoId).single()).data?.status, { timeout: 45_000 }).toBe("active_onboarding");
    const demo = (await db.from("demo_requests").select("status, linked_org_id").eq("id", demoId).single()).data;
    expect(demo.linked_org_id, "the demo is linked to the provisioned company").toBeTruthy();
    const org = (await db.from("organizations").select("id, name").eq("id", demo.linked_org_id).single()).data;
    expect(org.name).toBe(COMPANY);
    // … owned by the person who asked for the demo, and nobody else
    const members = (await db.from("memberships").select("role, user_id").eq("org_id", org.id)).data as any[];
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("owner");
    const owner = (await db.from("users").select("email").eq("id", members[0].user_id).single()).data;
    expect(owner.email).toBe(EMAIL);
    // exactly one company for this demo (no duplicate from the confirm round-trip)
    const orgs = (await db.from("organizations").select("id").eq("name", COMPANY)).data as any[];
    expect(orgs).toHaveLength(1);
  });
});
