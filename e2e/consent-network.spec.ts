import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  ARMED,
  EMPTY_STATE,
  deviceState,
  nonEssential,
  watchNetwork,
  withoutDevTooling,
  type NetworkWatch,
} from "./_consent-harness";
import { waitForHydrated } from "./_hydration";

/**
 * Tracking-consent network proof (PECR reg. 6 / UK GDPR).
 *
 * What this proves, by intercepting the browser's real network traffic and
 * reading the device's real cookie jar / storage — not by inspecting flags:
 *
 *   1. Before any interaction, no page (marketing home, a deep marketing page,
 *      login, the signed-in app) makes a consent-required request or writes a
 *      non-essential cookie / storage key.
 *   2. "Reject all" keeps it that way, and the choice survives a reload.
 *   3. "Accept all" is the moment — and the only moment — the consent-gated
 *      requests start.
 *   4. Withdrawing through the persistent "Cookie settings" entry point stops
 *      them again and removes the tracker's cookies / storage from the device.
 *   5. "Customise" is honoured per category: each category runs if and only if
 *      its own switch is on.
 *
 * TWO MODES. Trackers only load when their env IDs are set:
 *   - UNARMED (default E2E tier / CI build, no tracker IDs): only the baseline
 *     can be asserted — nothing third-party loads, the banner stays dormant,
 *     the settings entry point still works.
 *   - ARMED (`npx playwright test --config playwright.consent.config.ts`): the
 *     app runs with dummy tracker IDs on `.invalid` hosts, so a missing gate
 *     WOULD fire a request, and tests 2–5 run. Every third-party request is
 *     intercepted and answered locally; nothing leaves the machine. The Accept
 *     test doubles as the positive control: it proves the dummy trackers are
 *     live and that this harness sees them.
 *
 * Proving an absence needs an observation window: after the page settles each
 * "nothing was sent" assertion waits a fixed grace period (QUIET_MS) so a
 * deferred beacon would be caught. That is the measurement, not a retry mask —
 * in armed mode it starts only after the banner is visible, i.e. after the
 * consent code has run and any un-gated tracker would already have fired.
 */

const OWNER_STATE = "e2e/.auth/owner.json";
const QUIET_MS = 2_000;

const MARKETING_HOME = "/";
const MARKETING_DEEP = "/features/construction-crm";
const LOGIN = "/login";
const IN_APP = "/dashboard";

const CONSENT_COOKIE = "cf_cookie_consent";
const VENDOR_KEY = /^(__)?ph_/; // PostHog cookies / storage keys

const banner = (page: Page) => page.getByRole("region", { name: "Cookie consent" });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Cookie settings" });
const settingsButton = (page: Page) =>
  page.getByRole("button", { name: "Cookie settings", exact: true });
const categorySwitch = (page: Page, name: string) =>
  dialog(page).getByRole("switch", { name });

function appOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error("consent spec needs a baseURL");
  return new URL(baseURL).origin;
}

/** Let the page go quiet, then hold an observation window for late beacons. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  // Some app pages keep a poll/stream open; idle is best-effort, the window is not.
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(QUIET_MS);
}

/** Load a page and wait until the consent UI has made its decision. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  if (ARMED) await expect(banner(page)).toBeVisible();
  await settle(page);
}

async function consentCookie(context: BrowserContext): Promise<string | null> {
  const c = (await context.cookies()).find((x) => x.name === CONSENT_COOKIE);
  return c ? c.value : null;
}

async function vendorKeys(page: Page): Promise<string[]> {
  const s = await deviceState(page);
  return [...s.cookies, ...s.localStorage, ...s.sessionStorage].filter((k) =>
    VENDOR_KEY.test(k),
  );
}

/** Seed a stored choice, as a returning visitor would have. */
async function seedConsent(
  context: BrowserContext,
  baseURL: string | undefined,
  value: string,
): Promise<void> {
  await context.addCookies([
    { name: CONSENT_COOKIE, value, url: appOrigin(baseURL), sameSite: "Lax" },
  ]);
}

const now = () => Math.floor(Date.now() / 1000);
const record = (analytics: 0 | 1, performance: 0 | 1) =>
  `v2.t${now()}.analytics${analytics}.performance${performance}`;

// ---------------------------------------------------------------------------
// 1. Before any interaction — runs in BOTH modes.
// ---------------------------------------------------------------------------

test.describe("consent — nothing non-essential before any interaction", () => {
  for (const path of [MARKETING_HOME, MARKETING_DEEP, LOGIN]) {
    test(`anonymous ${path}: no consent-required request, no cookie, no storage`, async ({
      page,
      context,
      baseURL,
    }) => {
      const watch = await watchNetwork(context, appOrigin(baseURL));
      await open(page, path);

      expect(watch.consentRequired(), "consent-required requests").toEqual([]);
      const state = await deviceState(page);
      // Not merely "nothing non-essential": an anonymous first visit writes
      // NOTHING to the device at all.
      expect(withoutDevTooling(state)).toEqual(EMPTY_STATE);
      expect(nonEssential(state)).toEqual(EMPTY_STATE);
      if (ARMED) {
        await expect(banner(page)).toBeVisible();
      } else {
        await expect(banner(page)).toHaveCount(0);
      }
    });
  }

  test.describe("signed-in app", () => {
    test.use({ storageState: OWNER_STATE });

    test(`${IN_APP}: only first-party traffic and strictly-necessary storage`, async ({
      page,
      context,
      baseURL,
    }) => {
      const watch = await watchNetwork(context, appOrigin(baseURL));
      await open(page, IN_APP);
      await expect(page).toHaveURL(new RegExp(`${IN_APP}(\\?|$)`));

      expect(watch.consentRequired(), "consent-required requests").toEqual([]);
      const state = await deviceState(page);
      expect(nonEssential(state)).toEqual(EMPTY_STATE);
      // The session cookie is what makes this the signed-in app.
      expect(state.cookies.some((c) => /^sb-.+-auth-token/.test(c))).toBe(true);
      expect(state.cookies).not.toContain(CONSENT_COOKIE);
    });

    test("the app footer offers Cookie settings on every page", async ({ page }) => {
      await page.goto(IN_APP);
      await waitForHydrated(settingsButton(page));
      // While the first-visit banner is up it carries its own "Customise"; the
      // footer link is the entry point for afterwards, so answer the banner first.
      if (ARMED) await banner(page).getByRole("button", { name: "Reject all" }).click();
      await settingsButton(page).click();
      await expect(dialog(page)).toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// Unarmed only — the entry point works even when nothing optional exists.
// ---------------------------------------------------------------------------

test.describe("consent — settings entry point with nothing optional configured", () => {
  test.skip(ARMED, "covered by the armed matrix below");

  test("Cookie settings opens and says only strictly-necessary cookies are used", async ({
    page,
  }) => {
    await page.goto(MARKETING_HOME);
    await waitForHydrated(settingsButton(page));
    await settingsButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText("Strictly necessary");
    await expect(dialog(page).getByRole("switch")).toHaveCount(0);
    await expect(dialog(page)).toContainText("nothing optional to switch on or off");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    expect(await consentCookie(page.context())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2–5. The consent matrix — ARMED only (dummy trackers configured).
// ---------------------------------------------------------------------------

test.describe("consent — armed matrix (dummy trackers configured)", () => {
  test.skip(!ARMED, "needs dummy tracker IDs: run with playwright.consent.config.ts");

  let watch: NetworkWatch;
  test.beforeEach(async ({ context, baseURL }) => {
    watch = await watchNetwork(context, appOrigin(baseURL));
  });

  test("Reject all: nothing is sent or stored, and the choice survives a reload", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);

    // No dark pattern: Reject and Accept are the same control, visually.
    const reject = banner(page).getByRole("button", { name: "Reject all" });
    const accept = banner(page).getByRole("button", { name: "Accept all" });
    const look = (el: Element) => {
      const cs = getComputedStyle(el);
      return {
        background: cs.backgroundColor,
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        border: cs.borderTopWidth + cs.borderTopColor,
        height: Math.round(el.getBoundingClientRect().height),
        top: Math.round(el.getBoundingClientRect().top),
      };
    };
    expect(await reject.evaluate(look)).toEqual(await accept.evaluate(look));

    await reject.click();
    await expect(banner(page)).toHaveCount(0);
    expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics0\.performance0$/);

    await settle(page);
    expect(watch.consentRequired()).toEqual([]);
    // The ONLY thing a rejection leaves on the device is the record of it.
    expect(withoutDevTooling(await deviceState(page))).toEqual({
      ...EMPTY_STATE,
      cookies: [CONSENT_COOKIE],
    });

    await page.reload();
    await settle(page);
    await expect(banner(page)).toHaveCount(0);

    await page.goto(MARKETING_DEEP);
    await settle(page);
    await expect(banner(page)).toHaveCount(0);

    expect(watch.consentRequired()).toEqual([]);
    expect(withoutDevTooling(await deviceState(page))).toEqual({
      ...EMPTY_STATE,
      cookies: [CONSENT_COOKIE],
    });
  });

  test("Accept all: consent-gated requests start only now (positive control)", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);
    expect(watch.consentRequired(), "before the click").toEqual([]);
    expect(await vendorKeys(page)).toEqual([]);

    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect(banner(page)).toHaveCount(0);
    expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics1\.performance1$/);

    // Product analytics boots immediately on the click…
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    // …and only now does the vendor write to the device.
    await expect.poll(() => vendorKeys(page).then((k) => k.length)).toBeGreaterThan(0);

    // Performance monitoring: Sentry's session ping fires on page load, so it
    // shows on the next one — and it is a `session`, not an error report.
    await page.reload();
    await expect.poll(() => watch.byKind("performance").length).toBeGreaterThan(0);
    expect(watch.byKind("performance").flatMap((h) => h.itemTypes ?? [])).toContain("session");
    await expect(banner(page)).toHaveCount(0);
    // Nothing went anywhere the harness does not recognise.
    expect(watch.byKind("unknown-third-party")).toEqual([]);
  });

  test("Withdraw via Cookie settings: tracking stops and tracker storage is cleared", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);
    await banner(page).getByRole("button", { name: "Accept all" }).click();
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    await expect.poll(() => vendorKeys(page).then((k) => k.length)).toBeGreaterThan(0);

    // The persistent entry point, with the current choice reflected in it.
    await settingsButton(page).click();
    await expect(dialog(page)).toBeVisible();
    const analytics = categorySwitch(page, "Product analytics");
    const performance = categorySwitch(page, "Performance monitoring");
    await expect(analytics).toHaveAttribute("aria-checked", "true");
    await expect(performance).toHaveAttribute("aria-checked", "true");
    await expect(dialog(page)).toContainText("Your current choice was saved on");

    await analytics.click();
    await performance.click();
    await expect(analytics).toHaveAttribute("aria-checked", "false");
    await dialog(page).getByRole("button", { name: "Save choices" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics0\.performance0$/);

    // Cleared from the device straight away — no reload needed.
    await expect.poll(() => vendorKeys(page)).toEqual([]);

    // From here on: silence. In-page activity, a client navigation, a hard
    // reload — none of it may produce a consent-required request.
    watch.reset();
    await page.getByRole("button", { name: "Book a demo" }).first().click();
    await page.keyboard.press("Escape");
    await page.goto(MARKETING_DEEP);
    await settle(page);
    await page.reload();
    await settle(page);

    expect(watch.consentRequired()).toEqual([]);
    expect(await vendorKeys(page)).toEqual([]);
    expect(withoutDevTooling(await deviceState(page))).toEqual({
      ...EMPTY_STATE,
      cookies: [CONSENT_COOKIE],
    });
    await expect(banner(page)).toHaveCount(0);
  });

  test("Customise → analytics only: PostHog runs, Sentry performance does not", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);
    await banner(page).getByRole("button", { name: "Customise" }).click();
    await expect(dialog(page)).toBeVisible();

    // Default-denied: every optional switch starts off.
    for (const sw of await dialog(page).getByRole("switch").all()) {
      await expect(sw).toHaveAttribute("aria-checked", "false");
    }
    await categorySwitch(page, "Product analytics").click();
    await dialog(page).getByRole("button", { name: "Save choices" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics1\.performance0$/);

    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);

    watch.reset();
    await page.reload();
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    await settle(page);
    expect(watch.byKind("performance"), "Sentry session/trace envelopes").toEqual([]);
    expect(watch.byKind("unknown-third-party")).toEqual([]);
  });

  test("Customise → performance only: Sentry session runs, PostHog does not", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);
    await banner(page).getByRole("button", { name: "Customise" }).click();
    await categorySwitch(page, "Performance monitoring").click();
    await dialog(page).getByRole("button", { name: "Save choices" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics0\.performance1$/);

    await page.reload();
    await expect.poll(() => watch.byKind("performance").length).toBeGreaterThan(0);
    await settle(page);
    expect(watch.byKind("analytics"), "PostHog requests").toEqual([]);
    expect(await vendorKeys(page)).toEqual([]);
    expect(watch.byKind("unknown-third-party")).toEqual([]);
  });

  test("settings dialog: accessible, keyboard-operable, and closing it is not a choice", async ({
    page,
    context,
  }) => {
    await open(page, MARKETING_HOME);
    const customise = banner(page).getByRole("button", { name: "Customise" });
    await customise.focus();
    await page.keyboard.press("Enter");
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute("aria-modal", "true");

    // Focus moves into the dialog and Tab cannot leave it.
    const focusInside = () =>
      page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    await expect.poll(focusInside).toBe(true);
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      expect(await focusInside(), `Tab press ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusInside(), `Shift+Tab press ${i + 1}`).toBe(true);
    }

    // A switch is operable from the keyboard and announces its state.
    const analytics = categorySwitch(page, "Product analytics");
    await analytics.focus();
    await page.keyboard.press("Space");
    await expect(analytics).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Enter");
    await expect(analytics).toHaveAttribute("aria-checked", "false");

    const results = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);

    // Escape closes WITHOUT recording a choice: the banner is back, focus
    // returns to the control that opened the dialog, and nothing was sent.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(banner(page)).toBeVisible();
    await expect(customise).toBeFocused();
    expect(await consentCookie(context)).toBeNull();
    await settle(page);
    expect(watch.consentRequired()).toEqual([]);

    const bannerAxe = await new AxeBuilder({ page })
      .include('[aria-label="Cookie consent"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(bannerAxe.violations).toEqual([]);
  });

  test("the banner neither shifts the layout nor blocks the page", async ({ page }) => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 375, height: 812 },
    ]) {
      await page.context().clearCookies();
      await page.setViewportSize(viewport);
      await open(page, MARKETING_HOME);

      const measure = () =>
        page.evaluate(() => {
          const h1 = document.querySelector("h1")!.getBoundingClientRect();
          return {
            scrollHeight: document.documentElement.scrollHeight,
            h1Top: Math.round(h1.top + window.scrollY),
            h1Left: Math.round(h1.left),
            bodyOverflow: getComputedStyle(document.body).overflow,
          };
        });
      const withBanner = await measure();
      expect(withBanner.bodyOverflow, "page stays scrollable").not.toBe("hidden");

      const box = await banner(page).evaluate((el) => ({
        position: getComputedStyle(el).position,
        height: el.getBoundingClientRect().height,
      }));
      expect(box.position).toBe("fixed"); // out of flow → cannot shift layout
      expect(box.height).toBeLessThan(viewport.height * 0.5);

      // Content above the banner still takes clicks while it is showing.
      const hit = await page.evaluate(() => {
        const link = document.querySelector<HTMLElement>("header a[href]")!;
        const r = link.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && (top === link || link.contains(top));
      });
      expect(hit, "nav link is not covered").toBe(true);

      await banner(page).getByRole("button", { name: "Reject all" }).click();
      await expect(banner(page)).toHaveCount(0);
      const without = await measure();
      // Identical geometry with and without the banner = zero layout shift.
      expect(without).toEqual(withBanner);
    }
  });

  test("a returning visitor's stored choice is honoured without asking again", async ({
    page,
    context,
    baseURL,
  }) => {
    await seedConsent(context, baseURL, record(1, 0));
    await page.goto(MARKETING_HOME);
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    await settle(page);
    await expect(banner(page)).toHaveCount(0);
    expect(watch.byKind("performance")).toEqual([]);
  });

  test("legacy v1 cookie: 'denied' stays denied; 'granted' covers analytics only and is re-asked", async ({
    page,
    context,
    baseURL,
  }) => {
    await seedConsent(context, baseURL, "denied");
    await page.goto(MARKETING_HOME);
    await settle(page);
    await expect(banner(page)).toHaveCount(0);
    expect(watch.consentRequired()).toEqual([]);

    await context.clearCookies();
    await seedConsent(context, baseURL, "granted");
    await page.goto(MARKETING_HOME);
    await expect(banner(page)).toBeVisible(); // a new category exists → ask again
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    await settle(page);
    expect(watch.byKind("performance"), "never asked about → never on").toEqual([]);
  });

  test("external surfaces never track, even for a visitor who accepted everything", async ({
    page,
    context,
    baseURL,
  }) => {
    await seedConsent(context, baseURL, record(1, 1));
    for (const path of [
      "/q/consent-spec-not-a-real-token",
      "/customer-portal/consent-spec-not-a-real-token",
      "/worker-portal/consent-spec-not-a-real-token",
      "/l/consent-spec-not-a-real-company",
    ]) {
      await page.goto(path);
      await settle(page);
      await expect(banner(page), path).toHaveCount(0);
      expect(watch.consentRequired(), path).toEqual([]);
      expect(await vendorKeys(page), path).toEqual([]);
    }
    // Control: the very same cookie DOES start tracking on a first-party page,
    // so the silence above is the surface rule, not a dead tracker.
    await page.goto(MARKETING_HOME);
    await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);
    await expect.poll(() => watch.byKind("performance").length).toBeGreaterThan(0);
  });

  test.describe("signed-in app", () => {
    test.use({ storageState: OWNER_STATE });

    test("accepting in the app starts analytics; withdrawing from the app footer stops it", async ({
      page,
      context,
    }) => {
      await open(page, IN_APP);
      expect(watch.consentRequired(), "before the click").toEqual([]);

      await banner(page).getByRole("button", { name: "Accept all" }).click();
      await expect.poll(() => watch.byKind("analytics").length).toBeGreaterThan(0);

      await settingsButton(page).click();
      await dialog(page).getByRole("button", { name: "Reject all" }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(await consentCookie(context)).toMatch(/^v2\.t\d+\.analytics0\.performance0$/);
      await expect.poll(() => vendorKeys(page)).toEqual([]);

      watch.reset();
      await page.reload();
      await settle(page);
      expect(watch.consentRequired()).toEqual([]);
      expect(nonEssential(await deviceState(page))).toEqual(EMPTY_STATE);
    });
  });
});
