/* eslint-disable @typescript-eslint/no-explicit-any -- service-role seed cast. */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { assertLocalE2eTarget } from "./_guard";
import { settleForAxe } from "./_settle";

/**
 * 7-figure fleet fuel spend at 375px — the fleet money stat tiles must clip.
 *
 * The fleet `Stat` primitive (app/(app)/fleet/_components/ui.tsx) renders real
 * money — `value={formatGbp(…)}` — inside BASE `grid grid-cols-2` mobile grids
 * on three live surfaces:
 *   - /fleet                    — "Fuel logged" (grid-cols-2 base).
 *   - /fleet/fuel               — "Fuel spend" / "Maintenance" / "Total
 *                                 recorded" (grid-cols-2 base).
 *   - /fleet/vehicles/[id]      — "Fuel logged" (grid-cols-2 base).
 *
 * A construction fleet legitimately burns a 7-figure annual fuel bill
 * (£6,234,567.00). A comma-grouped GBP token has NO soft-wrap opportunity, so at
 * `text-xl` bold its min-content width (~150px) exceeds the ~133px inner track
 * of a `grid-cols-2` tile at 375px; before the fix the `Stat` value line carried
 * no `truncate`, so the tile pushed its `min-w-0` grid parent past the viewport
 * and the WHOLE document scrolled sideways — the same mechanism the /cash,
 * /dashboard and jobs/invoices/commercial fixes addressed. The fix is `truncate`
 * on the `Stat` value line (the card already carries `min-w-0`).
 *
 * This spec is the pixel confirmation of the source contract pinned in
 * __tests__/ui/money-tile-overflow-guard.test.ts (which now traces the fleet
 * `Stat`'s money across files). It mirrors e2e/cash-position-mobile.spec.ts and
 * e2e/money-tile-mobile.spec.ts: seed a realistic 7-figure figure, view at
 * 375px, and assert documentElement.scrollWidth never exceeds the viewport.
 *
 * Seeding is idempotent against the PERSISTENT local database: a fixed-id
 * vehicle (an `assets` row + its `fleet_vehicles` extension) and this spec's own
 * fuel log are deleted and reseeded in beforeAll, so a local run does not drift
 * the scanned DOM. Reads only in the browser — the fuel maths is proved in the
 * unit tier (lib/fleet/fuel) and the write paths at the integration tier.
 */

const SLUG = "e2e-harness-org";
// Fixed, namespaced ids so beforeAll is idempotent and never collides with
// another spec's seeds or the globalSetup sentinels.
const VEHICLE_ID = "d4444444-4444-4444-4444-444444444444";
const VEHICLE_NAME = "Fleet Mobile E2E Van";
const FUEL_NOTE = "FLEETMOBILE-E2E-FUEL";
const FUEL_LOG_ID = "d4444444-4444-4444-4444-444444444445";
// A 7-figure fuel spend. `£6,234,567.00` is comma-grouped and non-wrapping —
// exactly the token that overflowed the grid-cols-2 fleet tiles before the fix.
const BIG_SPEND = 6_234_567;
const BIG_TOKEN = "£6,234,567.00";
// A GBP token with >= 2 comma groups, i.e. >= £1,000,000 — the wide, un-soft-
// wrappable case. Used where the tile shows an ORG-WIDE aggregate that other
// specs' rows could blend into, so the exact token is not assertable.
const MILLIONS_GBP = /£\d{1,3}(,\d{3}){2,}\.\d{2}/;

function svc() {
  return createClient(
    assertLocalE2eTarget("fleet-mobile.spec.ts"),
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function pageHasNoHorizontalScroll(
  page: import("@playwright/test").Page,
  where: string,
) {
  // Settle first: reading scrollWidth before web fonts land measures fallback
  // glyph metrics (narrower), which can mask a real overflow.
  await settleForAxe(page);
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
  expect(
    overflow.scrollWidth - overflow.clientWidth,
    `${where} overflows horizontally at 375px (${overflow.scrollWidth} > ${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(1);
}

/** The fleet `Stat` value line: the tabular-nums <p> inside the tile card. */
function statValue(page: import("@playwright/test").Page, label: string | RegExp) {
  // Scope to the Stat CARD's own class pair (`min-w-0 rounded-xl`), never the
  // bare `min-w-0` substring: the app shell's <main> also carries `min-w-0`
  // and contains every tile's text, so the old selector could resolve <main>
  // and read the FIRST tile on the page (the "Vehicles" count — the literal
  // "3" of three CI flakes: 2026-08-29 baseline, PR #852, PR #858; proven
  // from the PR #858 trace snapshot, where the page carried the correct
  // £6,234,567.00 all along). The card class pair is unique to Stat tiles,
  // so `.first()` is now the labelled card's value line and nothing else.
  // `truncate` clips it visually but innerText keeps the full figure.
  return page
    .locator('[class*="min-w-0 rounded-xl"]')
    .filter({ hasText: label })
    .locator("p.tabular-nums")
    .first();
}

test.describe("7-figure fleet fuel tiles at 375px do not scroll the page sideways", () => {
  test.use({ storageState: "e2e/.auth/owner.json", viewport: { width: 375, height: 812 } });

  test.beforeAll(async () => {
    const db = svc() as unknown as { from: (t: string) => any };
    const orgId = (
      await db.from("organizations").select("id").eq("slug", SLUG).maybeSingle()
    ).data?.id;
    if (!orgId) throw new Error("seeded org not found — did globalSetup run?");

    const ownerId = (
      await db
        .from("memberships")
        .select("user_id")
        .eq("org_id", orgId)
        .eq("role", "owner")
        .limit(1)
        .maybeSingle()
    ).data?.user_id;

    // ── Seed this spec's own rows — UPSERTS on fixed ids, so the seed is
    // idempotent AND concurrency-safe (a --repeat-each run executes this
    // beforeAll in parallel workers; the old delete+insert raced itself into
    // assets_pkey duplicates). Order matters for the FKs: asset → extension.
    // registration/category live on `assets` (the RPC writes them there); the
    // fleet_vehicles extension carries only the vehicle-specific fields.
    const asset = await db.from("assets").upsert(
      {
        id: VEHICLE_ID,
        org_id: orgId,
        name: VEHICLE_NAME,
        category: "Vehicle",
        registration: "FM24E2E",
        status: "active",
        created_by: ownerId ?? null,
      },
      { onConflict: "id" },
    );
    if (asset.error) throw new Error(`fleet-mobile seed (asset): ${asset.error.message}`);

    const ext = await db.from("fleet_vehicles").upsert(
      {
        asset_id: VEHICLE_ID,
        org_id: orgId,
        vehicle_class: "van",
        operational_status: "in_service",
        created_by: ownerId ?? null,
      },
      { onConflict: "asset_id" },
    );
    if (ext.error) throw new Error(`fleet-mobile seed (fleet_vehicles): ${ext.error.message}`);

    // EXACTLY ONE 7-figure fuel log: a FIXED-ID UPSERT, the same shape as the
    // asset — any number of concurrent workers converge on one identical row
    // (no probe-then-insert window), and the vehicle-scoped exact-token
    // assertion can never see a doubled sum. Any stray rows from older seed
    // shapes are cleared first. `cost` is stored in pounds (lib/fleet/fuel
    // sums it straight); a past `filled_on` clears the no-future-date guard.
    await db
      .from("asset_fuel_logs")
      .delete()
      .eq("org_id", orgId)
      .eq("asset_id", VEHICLE_ID)
      .neq("id", FUEL_LOG_ID);
    const fuel = await db.from("asset_fuel_logs").upsert(
      {
        id: FUEL_LOG_ID,
        org_id: orgId,
        asset_id: VEHICLE_ID,
        filled_on: "2020-06-15",
        odometer_miles: 48_250,
        litres: 620.5,
        cost: BIG_SPEND,
        is_full_fill: true,
        notes: FUEL_NOTE,
        created_by: ownerId ?? null,
      },
      { onConflict: "id" },
    );
    if (fuel.error) throw new Error(`fleet-mobile seed (fuel): ${fuel.error.message}`);
  });

  test("fleet overview — the Fuel logged tile clips the 7-figure figure", async ({ page }) => {
    await page.goto("/fleet");

    // The org-wide "Fuel logged" tile aggregates every fuel log, so other specs'
    // fills could blend in — assert a millions-GBP figure rather than the exact
    // token, which is the wide, un-soft-wrappable case that overflowed.
    const value = await statValue(page, /Fuel logged/i).innerText();
    expect(value.trim(), `Fuel logged tile should render a 7-figure GBP, got "${value}"`).toMatch(
      MILLIONS_GBP,
    );

    await pageHasNoHorizontalScroll(page, "/fleet");
  });

  test("fleet fuel page — the spend tiles clip the 7-figure figure", async ({ page }) => {
    await page.goto("/fleet/fuel");

    // "Fuel spend" and "Total recorded" are org-wide aggregates → millions-GBP.
    const spend = await statValue(page, /Fuel spend/i).innerText();
    expect(spend.trim(), `Fuel spend tile should render a 7-figure GBP, got "${spend}"`).toMatch(
      MILLIONS_GBP,
    );
    const total = await statValue(page, /Total recorded/i).innerText();
    expect(
      total.trim(),
      `Total recorded tile should render a 7-figure GBP, got "${total}"`,
    ).toMatch(MILLIONS_GBP);

    await pageHasNoHorizontalScroll(page, "/fleet/fuel");
  });

  test("vehicle detail — the Fuel logged tile clips the 7-figure figure", async ({ page }) => {
    await page.goto(`/fleet/vehicles/${VEHICLE_ID}`);

    // This tile is VEHICLE-scoped (only this fresh van's single fuel log), so
    // the exact token appears — no aggregate to blend into.
    const value = await statValue(page, /Fuel logged/i).innerText();
    expect(value.trim(), `vehicle Fuel logged tile should be ${BIG_TOKEN}, got "${value}"`).toContain(
      BIG_TOKEN,
    );

    await pageHasNoHorizontalScroll(page, "/fleet/vehicles/[id]");
  });
});
