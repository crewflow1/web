import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * /sites accessibility + mobile regression — the coverage this route never had.
 *
 * It is the adoption surface for components/ui/table.tsx, so the scan has a
 * specific job beyond "no violations": the table primitive's header band is
 * `text-slate-500` on `bg-slate-50`, which is 4.53:1 — AA, but with 0.03 to
 * spare, and the header is uppercase `text-xs` so the large-text exemption does
 * not apply. Arithmetic proves the pair; only a real browser proves it survives
 * composition, so `color-contrast` is asserted here rather than assumed.
 *
 * axe runs only after `settleForAxe`. A scan fired straight after `goto()` audits
 * the Suspense skeleton and reports zero violations for content it never saw
 * (see e2e/_settle.ts).
 *
 * GET-navigation only; /sites is a read-only register, so there is no write path
 * to prove here. Seeding is idempotent against the PERSISTENT local database:
 * every row has a fixed sentinel name, is looked up first, and is created only if
 * absent — no per-run stamped rows to accumulate.
 */

const SLUG = "e2e-harness-org";
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** Fixed sentinel identities — see the idempotency note above. */
const YARD = "A11y sites yard E2E";
const LOCK_UP = "A11y sites lock-up E2E";
const RETIRED = "A11y sites retired depot E2E";

/**
 * A sentinel street too, not a plausible one. The persistent local database
 * already holds sites seeded by other specs, and the register is org-wide: an
 * address any of them might also use turns every `getByRole("cell")` below into a
 * strict-mode violation the first time two rows happen to agree.
 */
const STREET = "A11y Table Row Road";

function svc() {
  return createClient(
    assertLocalE2eTarget("sites-a11y.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe("sites — accessibility + mobile", () => {
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

    /**
     * Both the "In use" and the "Retired" table must render, and the address
     * column (hidden below md) must have something in it, or the mobile
     * assertions below would pass against an empty page.
     */
    const rows = [
      {
        name: YARD,
        kind: "yard",
        address_line1: `12 ${STREET}`,
        city: "Wakefield",
        postcode: "WF1 5AA",
        active: true,
      },
      {
        name: LOCK_UP,
        kind: "lock_up",
        address_line1: "Unit 4 Kirkstall Industrial Estate",
        city: "Leeds",
        postcode: "LS4 2AZ",
        active: true,
      },
      {
        name: RETIRED,
        kind: "depot",
        address_line1: "1 Sheffield Road",
        city: "Barnsley",
        postcode: "S70 1AA",
        active: false,
      },
    ];
    for (const row of rows) {
      const found = await t("sites")
        .select("id")
        .match({ org_id: orgId, name: row.name })
        .maybeSingle();
      if (found.error) throw new Error(`sites a11y seed: find ${row.name} — ${found.error.message}`);
      if (found.data?.id) continue;
      const made = await t("sites").insert({ org_id: orgId, ...row }).select("id").single();
      if (made.error) throw new Error(`sites a11y seed: insert ${row.name} — ${made.error.message}`);
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  test("has no axe violations at desktop width", async ({ page }) => {
    await page.goto("/sites");
    await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);
  });

  test("the table primitive actually rendered both registers", async ({ page }) => {
    await page.goto("/sites");
    await settleForAxe(page);

    // Two <Table>s: "In use" and "Retired". An empty register proves nothing.
    await expect(page.getByRole("table")).toHaveCount(2);

    // The header band is the primitive's, and `scope="col"` comes from <TH>.
    const inUse = page.getByRole("table").first();
    await expect(inUse.getByRole("columnheader")).toHaveText([
      "Name",
      "Kind",
      "Where",
      "In use by",
    ]);

    // Rows are links, so the register is keyboard-navigable.
    await expect(page.getByRole("link", { name: YARD })).toBeVisible();
    await expect(page.getByRole("link", { name: RETIRED })).toBeVisible();

    // The address column is populated, so hiding it at 375px hides real content.
    await expect(inUse.getByRole("cell", { name: new RegExp(STREET) })).toBeVisible();
  });

  test("has no axe violations and no horizontal overflow at 375px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/sites");
    await expect(page.getByRole("heading", { name: "Sites", level: 1 })).toBeVisible();
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);

    // The register is read on a phone in a yard. A table is the one element that
    // reliably pushes a page sideways, which is why <Table> owns the scroll
    // wrapper: the overflow must happen INSIDE the card, never on <html>.
    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);

    // `hideBelow="md"` must hide the column on BOTH the header and the cells —
    // a half-hidden column silently misaligns every row.
    const inUse = page.getByRole("table").first();
    await expect(inUse.getByRole("columnheader", { name: "Where" })).toBeHidden();
    await expect(inUse.getByRole("cell", { name: new RegExp(STREET) })).toBeHidden();
  });
});
