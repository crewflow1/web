import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * /operations accessibility + mobile regression.
 *
 * This route had NO e2e coverage of any kind, which is exactly why it shipped two
 * serious axe violations nobody saw: every fact row in "The estate" and "Running
 * costs" rendered a `<dt>`/`<dd>` pair wrapped in an `<a>`, so the enclosing
 * `<dl>` had an anchor child (`definition-list`) and the terms had no `<dl>`
 * parent (`dlitem`, 9 nodes). A definition list cannot express "the whole
 * term/definition pair is one link", so those sections are now lists of facts.
 * This spec is the pin that keeps them valid.
 *
 * It also guards the design-system adoption: the KPI tiles and status pills on
 * this page resolve their colour through components/ui/tokens.ts, whose contrast
 * is proven arithmetically in __tests__/ui/tokens.test.ts. That unit test proves
 * the token map; only a real browser proves the tokens survive composition —
 * that no ancestor's background, opacity or font-size lands the RENDERED pill
 * below AA. Hence `color-contrast` is asserted here rather than assumed.
 *
 * axe runs only after `settleForAxe` — a scan fired straight after `goto()`
 * audits the Suspense skeleton and reports zero violations for content it never
 * saw (see e2e/_settle.ts).
 *
 * GET-navigation only; /operations is strictly read-only, so there is no write
 * path to prove. Seeding is idempotent against the PERSISTENT local database:
 * every row has a fixed sentinel name, is looked up first, and is created only
 * if absent — no per-run stamped rows to accumulate.
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Fixed sentinel identities — see the idempotency note above. */
const EXCAVATOR = "A11y ops excavator E2E";
const TELEHANDLER = "A11y ops telehandler E2E";
const CASE_TITLE = "A11y ops out-of-service E2E";
const OVERDUE_INSPECTION = "A11y ops overdue inspection E2E";
const DUE_INSPECTION = "A11y ops due inspection E2E";
const FAILED_INSPECTION = "A11y ops failed safety inspection E2E";

function svc() {
  return createClient(
    assertLocalE2eTarget("operations-a11y.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

test.describe("operations — accessibility + mobile", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test.beforeAll(async () => {
    const db = svc();
    /* eslint-disable @typescript-eslint/no-explicit-any -- seed: the generated
       Database types don't cover every seeded table, so writes go through a cast. */
    const t = (n: string) => (db as unknown as { from: (n: string) => any }).from(n);
    const orgId = (
      await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()
    ).data?.id as string | undefined;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    /** Find-or-create by sentinel natural key; fails loudly. */
    async function ensure(
      table: string,
      match: Record<string, unknown>,
      insert: Record<string, unknown>,
      what: string,
    ): Promise<string> {
      const found = await t(table)
        .select("id")
        .match({ org_id: orgId, ...match })
        .maybeSingle();
      if (found.error) throw new Error(`ops a11y seed: find ${what} — ${found.error.message}`);
      if (found.data?.id) return found.data.id as string;
      const made = await t(table)
        .insert({ org_id: orgId, ...insert })
        .select("id")
        .single();
      if (made.error) throw new Error(`ops a11y seed: insert ${what} — ${made.error.message}`);
      return made.data.id as string;
    }

    // Two assets, so the populated view renders rather than the new-estate state.
    const excavator = await ensure(
      "assets",
      { name: EXCAVATOR },
      { name: EXCAVATOR, category: "plant", status: "active" },
      "excavator",
    );
    const telehandler = await ensure(
      "assets",
      { name: TELEHANDLER },
      { name: TELEHANDLER, category: "plant", status: "active" },
      "telehandler",
    );

    // Out of action → the red status pill.
    await ensure(
      "asset_maintenance_cases",
      { title: CASE_TITLE },
      {
        asset_id: excavator,
        case_type: "breakdown",
        status: "in_progress",
        title: CASE_TITLE,
        out_of_service: true,
      },
      "maintenance case",
    );

    // Overdue → red pill; merely due → the soft blue pill. Both states styled.
    await ensure(
      "asset_inspections",
      { title: OVERDUE_INSPECTION },
      {
        asset_id: excavator,
        title: OVERDUE_INSPECTION,
        kind: "loler",
        status: "draft",
        due_at: days(-9),
        safety_critical: true,
      },
      "overdue inspection",
    );
    await ensure(
      "asset_inspections",
      { title: DUE_INSPECTION },
      {
        asset_id: telehandler,
        title: DUE_INSPECTION,
        kind: "pat",
        status: "draft",
        due_at: days(11),
      },
      "due inspection",
    );

    // A failed safety-critical inspection → the emphatic solid pill, the highest
    // -contrast-risk variant in the token map (white text on a filled ground).
    await ensure(
      "asset_inspections",
      { title: FAILED_INSPECTION },
      {
        asset_id: telehandler,
        title: FAILED_INSPECTION,
        kind: "safety",
        status: "issued",
        safety_critical: true,
        outcome: "fail",
        inspected_at: days(-3),
      },
      "failed safety inspection",
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  test("has no axe violations at desktop width", async ({ page }) => {
    await page.goto("/operations");
    await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);
  });

  test("the styled states actually rendered (an empty page proves nothing)", async ({ page }) => {
    await page.goto("/operations");
    await settleForAxe(page);

    // The seeds above must have produced the pills the scan is meant to audit.
    await expect(page.getByText("Blocked from issue").first()).toBeVisible();
    await expect(page.getByText("In progress").first()).toBeVisible();
    await expect(page.getByText(/^Was due /).first()).toBeVisible();
    await expect(page.getByText(/^Due /).first()).toBeVisible();

    // And the KPI tiles are real links, so the numbers are keyboard-reachable.
    await expect(page.getByRole("link", { name: /Inspections overdue/ })).toBeVisible();
  });

  test("has no axe violations and no horizontal overflow at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/operations");
    await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);

    // A command centre is read on a phone in a yard. Long asset names, plate
    // chips and date pills must wrap, never push the page sideways.
    const overflow = await page.evaluate(() => {
      const d = document.documentElement;
      return { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth };
    });
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
});
