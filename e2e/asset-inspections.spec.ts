import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";

/**
 * Asset inspections/templates E2E — gate 6 for the M4 platform (templates →
 * scheduling → overrides).
 *
 * Runs against the REAL production build (`next start`) on the REAL Supabase
 * local stack. Like every spec in this tier it proves the one identity an
 * unauthenticated E2E can assert deterministically — the anonymous visitor —
 * which for M4 is the request boundary of the compliance surfaces: **the
 * template library/editor, the org-wide inspections overview and the
 * inspection run page never paint for a caller without a session.** A printed
 * checklist or a due-work URL leaking into an unauthenticated context is
 * exactly the risk this closes.
 *
 * The full M4 lifecycle (template v1 → publish → run keeps v1 → safety fail →
 * block → override denied/recorded → linked re-inspection clears exactly one
 * block) is proven DETERMINISTICALLY one tier down against real Postgres:
 *   - asset-inspection-templates.test.ts (11) — versioning + immutability
 *   - asset-inspection-generator.test.ts (7)  — idempotent + concurrent claims
 *   - asset-inspection-overrides.test.ts (13) — overrides/lineage/hardening/pre-use
 * The authenticated journey below (template → section → item → publish →
 * start → save progress → complete) exists to pin NAVIGATION, not the M4
 * rules: these actions used to redirect() from the Server Action, and at
 * /assets/templates/[id] the same-page save NEVER moved the browser (measured
 * 100% silent loss under next start — the row was written, the URL froze; the
 * Next 15.5 stranded-commit race, vercel/next.js#83386). The actions now
 * return FormState and <StateForm> document-navigates; every page.url()
 * assertion after a click pins the exact behaviour that was broken. The run
 * page save/complete sit at the deepest route swap in the app
 * (/assets/[id]/inspections/[inspectionId] — depth 6).
 */

// Well-formed-but-nonexistent UUIDs: the wall must fire BEFORE any resolution.
const FAKE_ASSET = "00000000-0000-0000-0000-00000000aaaa";
const FAKE_INSPECTION = "00000000-0000-0000-0000-00000000bbbb";

const M4_PAGES: ReadonlyArray<readonly [string, string, RegExp]> = [
  ["/assets/templates", "%2Fassets%2Ftemplates", /Inspection templates/],
  ["/assets/templates/new", "%2Fassets%2Ftemplates%2Fnew", /New inspection template/],
  ["/assets/inspections", "%2Fassets%2Finspections", /Blocked assets|Overdue/],
];

test.describe("asset inspections — the M4 surfaces sit behind the auth wall", () => {
  for (const [path, next, marker] of M4_PAGES) {
    test(`a logged-out visitor to ${path} is sent to /login, nothing painted`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${next}`));
      await expect(page.getByText(marker)).toHaveCount(0);
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
    });
  }

  test("a logged-out visit to an inspection run URL is sent to /login, checklist never paints", async ({
    page,
  }) => {
    await page.goto(`/assets/${FAKE_ASSET}/inspections/${FAKE_INSPECTION}`);
    await expect(page).toHaveURL(/\/login\?next=/);
    await expect(page.getByRole("button", { name: /complete inspection/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  });
});

/** React has attached a fiber to a form — the client dispatch is live. A
 *  pre-hydration click would fall back to a native document POST and prove
 *  nothing about the client-dispatch navigation under test. */
async function waitForHydratedForm(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
}

test.describe("asset inspections — authenticated M4 journey lands every navigation", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("template → section → item → publish → start → save progress → complete", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now();
    const tplName = `E2E daily check ${stamp}`;

    // Seed an asset to inspect (service-role, same idiom as global-setup).
    const svc = createClient(
      assertLocalE2eTarget("asset-inspections.spec.ts"),
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ) as unknown as { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const orgId = (
      await svc.from("organizations").select("id").eq("slug", "e2e-harness-org").maybeSingle()
    ).data?.id;
    expect(orgId).toBeTruthy();
    const owner = (
      await svc.from("memberships").select("user_id").eq("org_id", orgId).limit(1).maybeSingle()
    ).data?.user_id;
    const asset = (
      await svc
        .from("assets")
        .insert({ org_id: orgId, name: `E2E insp rig ${stamp}`, status: "active", created_by: owner })
        .select("id")
        .single()
    ).data;
    expect(asset?.id).toBeTruthy();

    // CREATE the template through the real form.
    await page.goto("/assets/templates/new");
    await waitForHydratedForm(page);
    await page.locator('input[name="name"]').fill(tplName);
    await page.getByRole("button", { name: /create/i }).click();
    await expect(page).toHaveURL(/\/assets\/templates\/[0-9a-f-]{36}\?saved=created/, {
      timeout: 20_000,
    });
    const templateId = new URL(page.url()).pathname.split("/").pop()!;

    // ADD SECTION — the same-page save that silently stranded 100% of clicks
    // before the FormState conversion.
    await waitForHydratedForm(page);
    await page.locator('input[name="title"]').fill("Walkaround");
    await page.getByRole("button", { name: /^add$|add section/i }).click();
    await expect(page).toHaveURL(new RegExp(`/assets/templates/${templateId}\\?saved=section`), {
      timeout: 20_000,
    });

    // ADD ITEM to the new section (the form sits inside a collapsed <details>).
    await waitForHydratedForm(page);
    await page.getByText("+ Add item").first().click();
    await page.locator('input[name="prompt"]').first().fill("Tyres OK");
    await page.getByRole("button", { name: /^add item$/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/assets/templates/${templateId}\\?saved=item`), {
      timeout: 20_000,
    });

    // PUBLISH — freezes v1 and makes it startable.
    await waitForHydratedForm(page);
    await page.getByRole("button", { name: /publish/i }).first().click();
    await expect(page).toHaveURL(new RegExp(`/assets/templates/${templateId}\\?saved=published`), {
      timeout: 20_000,
    });

    // ASSET STATUS FLIP — the worst measured flow (10/10 silent losses on
    // main): the same-route ?saved= swap on the heavy asset [id] page.
    await page.goto(`/assets/${asset.id}`);
    await waitForHydratedForm(page);
    await page
      .locator("form", { has: page.locator('input[name="status"][value="retired"]') })
      .getByRole("button")
      .click();
    await expect(page).toHaveURL(new RegExp(`/assets/${asset.id}\\?saved=status`), {
      timeout: 20_000,
    });
    await waitForHydratedForm(page);
    await page
      .locator("form", { has: page.locator('input[name="status"][value="active"]') })
      .getByRole("button")
      .click();
    await expect(page).toHaveURL(new RegExp(`/assets/${asset.id}\\?saved=status`), {
      timeout: 20_000,
    });

    // START an inspection from the asset page (mounts the deep subtree). Two
    // template selects exist (start-inspection + schedule creation) — scope to
    // the form that owns the Start button.
    await waitForHydratedForm(page);
    const startForm = page.locator("form", {
      has: page.getByRole("button", { name: /start inspection/i }),
    });
    await startForm.locator('select[name="template_id"]').selectOption(templateId);
    await startForm.getByRole("button", { name: /start inspection/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/assets/${asset.id}/inspections/[0-9a-f-]{36}$`),
      { timeout: 20_000 },
    );
    const runUrl = new URL(page.url()).pathname;

    // SAVE PROGRESS — the deepest same-route swap in the app (depth 6).
    await waitForHydratedForm(page);
    await page.getByText("Pass", { exact: true }).first().click();
    await page.getByRole("button", { name: /save progress/i }).click();
    await expect(page).toHaveURL(new RegExp(`${runUrl}\\?saved=progress`), { timeout: 20_000 });
    await expect(page.getByText(/Progress saved/i)).toBeVisible();

    // COMPLETE — derives the outcome and locks the record.
    await waitForHydratedForm(page);
    await page.getByRole("button", { name: /complete inspection/i }).click();
    await expect(page).toHaveURL(new RegExp(`${runUrl}\\?saved=issued`), { timeout: 20_000 });
    await expect(page.getByText(/Passed|No defects recorded/i).first()).toBeVisible();
  });
});
