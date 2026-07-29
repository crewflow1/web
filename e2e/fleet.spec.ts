import { test, expect } from "@playwright/test";

/**
 * Fleet E2E — the anonymous boundary, and the core authenticated journey:
 * a logged-in user adds a vehicle through the real form, lands on its page,
 * edits it, and sees it on the register.
 *
 * WHY THE CREATE IS THE JOURNEY WORTH DRIVING IN A BROWSER: it is the one
 * fleet write that spans TWO tables in one transaction (the `assets` row and
 * its `fleet_vehicles` extension, via the save_fleet_vehicle RPC). Proving it
 * through a real Server Action POST proves the whole extension architecture
 * end to end — form → action → RPC → both rows → the page that composes them.
 *
 * WHY THE FORMS ARE CLIENT-DISPATCHED (`useActionState` + router.push), AND
 * WHY THIS SPEC ASSERTS `page.url()` AFTER THE CLICK: fleet actions used to
 * call `redirect()` and this spec could only assert on the 303 response,
 * because the browser never followed it. That was chased to its root: a
 * Server-Action `redirect()` between two routes under /fleet/vehicles/* loses
 * a race in the Next 15.5 client router — the reducer applies the new state
 * and rejects the action promise with the redirect error, and that rejection
 * can strand React's still-suspended commit, so the URL never changes and no
 * error surfaces anywhere. The race odds worsen with deeper route swaps and
 * more revalidated paths; every fleet flow sat on the losing side (verified
 * with an instrumented router across fleet/assets/health-safety and synthetic
 * shallow/deep routes). Fleet actions therefore return `FormState.redirectTo`
 * and the client navigates with router.push — a plain navigation, outside the
 * racy path — which is also the pattern the customers/suppliers forms use.
 * The URL assertions below pin exactly the behaviour that was broken; if
 * someone converts a fleet action back to `redirect()`, this spec goes red.
 *
 * SCOPE, and where the rest is proven: the compliance and fuel writes on the
 * vehicle detail page are proven against real Postgres at the integration tier
 * (__tests__/integration/rls/fleet-domain.test.ts: the widened CHECKs, the
 * atomic completion RPC and its rollback, fuel guards, odometer sync), and the
 * maths behind them in the unit tier.
 */

/** React has attached a fiber to the form — the client dispatch is live. */
async function waitForHydratedForm(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const el = document.querySelector("form");
    return !!el && Object.keys(el).some((k) => k.startsWith("__reactFiber$"));
  });
}

test.describe("fleet — anonymous boundary", () => {
  const guarded = [
    ["/fleet", "%2Ffleet"],
    ["/fleet/vehicles", "%2Ffleet%2Fvehicles"],
    ["/fleet/compliance", "%2Ffleet%2Fcompliance"],
    ["/fleet/fuel", "%2Ffleet%2Ffuel"],
  ] as const;

  for (const [path, encoded] of guarded) {
    test(`a logged-out visitor to ${path} is sent to /login with nothing painted`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encoded}`));
      await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
      // No fleet data leaks into the login render.
      await expect(page.getByText(/MOT|road tax|Vehicle register/i)).toHaveCount(0);
    });
  }
});

test.describe("fleet — authenticated vehicle create & edit", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("adding a vehicle navigates to its page; editing navigates back with the change", async ({
    page,
  }) => {
    const stamp = Date.now();
    const name = `Transit 350 — E2E ${stamp}`;
    // A plate shaped like a real UK registration, unique per run.
    const plate = `E${String(stamp).slice(-2)} AAA`;

    await page.goto("/fleet/vehicles/new");
    await expect(page.getByRole("heading", { name: /add a vehicle/i })).toBeVisible();
    // Submit only once the client dispatch is live — a pre-hydration click
    // would fall back to a native POST and prove nothing about navigation.
    await waitForHydratedForm(page);

    await page.locator("#name").fill(name);
    await page.locator("#registration").fill(plate);
    await page.locator("#manufacturer").fill("Ford");
    await page.locator("#model").fill("Transit");
    await page.locator("#vehicle_class").selectOption("van");
    await page.locator("#fuel_type").selectOption("diesel");
    await page.locator("#odometer_miles").fill("48250");
    await page.locator("#home_depot").fill("Wakefield yard");

    // THE assertion this spec exists for: the click must MOVE THE BROWSER to
    // the new vehicle's own page. The RPC returning an id (both rows written,
    // one transaction, caller's own JWT) is implied by the id in the URL.
    await page.getByRole("button", { name: /add vehicle/i }).click();
    await expect(page).toHaveURL(/\/fleet\/vehicles\/[0-9a-f-]{36}\?saved=created/, {
      timeout: 20_000,
    });
    const vehicleId = new URL(page.url()).pathname.split("/").pop()!;

    // The vehicle renders, composed from both halves.
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByText(/Vehicle added to the fleet/i)).toBeVisible();

    // The extension half: availability, the normalised plate, mileage.
    await expect(page.getByText("In service").first()).toBeVisible();
    // The registration was normalised on the way in (spaces stripped, uppercased).
    await expect(page.getByText(plate.replace(/\s+/g, ""), { exact: false }).first()).toBeVisible();
    await expect(page.getByText("48,250").first()).toBeVisible();

    // Compliance starts empty and SAYS so, rather than implying all is well.
    await expect(page.getByText(/No renewal dates tracked yet/i)).toBeVisible();

    // Consumption is honestly absent — no fills logged, so no invented mpg.
    await expect(page.getByText(/needs two full fills/i)).toBeVisible();

    // EDIT is the same shape of navigation ([id]/edit → [id]) and was broken
    // by the same race — pin it too.
    const editedName = `${name} (edited)`;
    await page.goto(`/fleet/vehicles/${vehicleId}/edit`);
    await waitForHydratedForm(page);
    await page.locator("#name").fill(editedName);
    await page.getByRole("button", { name: /save changes/i }).click();
    await expect(page).toHaveURL(new RegExp(`/fleet/vehicles/${vehicleId}\\?saved=updated`), {
      timeout: 20_000,
    });
    await expect(page.getByRole("heading", { name: editedName })).toBeVisible();
    await expect(page.getByText(/Vehicle updated/i)).toBeVisible();

    // And it is on the register. Scoped to the table because the register
    // renders BOTH a mobile card list and a desktop table, and at this viewport
    // the card list is the hidden one — an unscoped text match would resolve to
    // it and assert on markup the user cannot see.
    await page.goto("/fleet/vehicles");
    await expect(page.getByRole("table").getByText(editedName)).toBeVisible();

    // Search finds it by a registration typed WITH a space, proving the
    // normalisation is applied to the query as well as to the stored plate.
    await page.goto(`/fleet/vehicles?q=${encodeURIComponent(plate)}`);
    await expect(page.getByRole("table").getByText(editedName)).toBeVisible();
  });
});
