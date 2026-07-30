import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { settleForAxe } from "./_settle";

/**
 * The /staff add-staff dialog — components/ui/modal.tsx's adoption surface.
 *
 * Scanned and driven in its OPEN state. An unopened dialog renders nothing, so a
 * scan of /staff with the dialog closed audits the page behind it and reports
 * zero violations for a dialog it never saw — the same vacuous pass that
 * e2e/_settle.ts exists to prevent one layer up. Every axe call here therefore
 * opens the dialog first, and `settleForAxe` runs after that, so the 150ms
 * `animate-in` entrance has finished and the panel is measured at rest.
 *
 * The four keyboard proofs are the reason the primitive exists. Before it, this
 * dialog (and the other eight in the repo) had none of them:
 *   1. focus moves INTO the dialog on open
 *   2. focus RESTORES to the trigger on close
 *   3. Tab and Shift+Tab are TRAPPED inside the panel
 *   4. Escape closes
 *
 * READ-ONLY. Nothing here submits the form: `inviteStaff` sends a real invite and
 * writes a membership, and this spec's job is the dialog shell, not the action.
 * Opening and closing a dialog leaves no rows behind, so there is nothing to seed
 * and nothing to clean up.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** A stable identifier for whatever currently has focus. */
function activeElement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const attr = (n: string) => el.getAttribute(n);
    const detail =
      attr("name") ??
      attr("aria-label") ??
      attr("data-testid") ??
      attr("type") ??
      el.textContent?.trim().slice(0, 24) ??
      "";
    return `${el.tagName.toLowerCase()}[${detail}]`;
  });
}

/** Inside the portalled panel — not merely somewhere on the page. */
function focusIsInsidePanel(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="dialog"]');
    return !!panel && !!document.activeElement && panel.contains(document.activeElement);
  });
}

async function openDialog(page: Page): Promise<void> {
  await page.getByTestId("add-staff-button").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a staff member" })).toBeVisible();
}

test.describe("staff add-staff dialog — accessibility + keyboard", () => {
  test.use({ storageState: "e2e/.auth/owner.json" });

  test("has no axe violations with the dialog OPEN at desktop width", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);
  });

  test("has no axe violations and no horizontal overflow with the dialog OPEN at 375px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/staff");
    await openDialog(page);
    await settleForAxe(page);

    const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`).join("\n"),
    ).toEqual([]);

    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
  });

  test("the whole panel is reachable at 375px (it was not before)", async ({ page }) => {
    // On origin/main this panel was 911px tall inside a 764px window with its top
    // at y=-123, so the heading and the close button were off-screen inside a
    // `position: fixed` overlay with no way to scroll. The primitive's panel is
    // `max-h-full overflow-y-auto`, which is a no-op when the content fits and
    // the only thing standing between a phone user and the title when it does not.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/staff");
    await openDialog(page);

    const panel = page.getByRole("dialog");
    const geometry = await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        viewport: window.innerHeight,
      };
    });
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport);
    // The content really is taller than the panel, so this is the scrolling case
    // rather than a viewport that happened to be big enough.
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);

    // Both ends are reachable: the heading without scrolling, the submit button
    // after scrolling within the panel.
    await expect(page.getByRole("heading", { name: "Add a staff member" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Close" })).toBeInViewport();
    await page.getByRole("button", { name: "Send invite" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Send invite" })).toBeInViewport();
  });

  test("PROOF 1 — focus moves into the dialog on open", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);

    await expect
      .poll(() => activeElement(page), { message: "focus never entered the dialog" })
      .toBe("input[full_name]");
    expect(await focusIsInsidePanel(page)).toBe(true);
  });

  test("PROOF 2 — focus returns to the trigger on close", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);
    await expect.poll(() => activeElement(page)).toBe("input[full_name]");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Not "somewhere sensible" — the exact button that opened it. Without this a
    // keyboard user is dropped at the top of the document and has to Tab back
    // through the whole page.
    await expect
      .poll(() => activeElement(page), { message: "focus was not restored to the trigger" })
      .toBe("button[add-staff-button]");
  });

  test("PROOF 3 — Tab and Shift+Tab are trapped inside the panel", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);
    await expect.poll(() => activeElement(page)).toBe("input[full_name]");

    // Backwards off the front edge. DOM order inside the panel starts with the
    // corner ✕, so Shift+Tab from the first field reaches it normally…
    await page.keyboard.press("Shift+Tab");
    expect(await activeElement(page)).toBe("button[Close]");
    // …and one more Shift+Tab is the edge: it must WRAP to the last control in
    // the panel, not step out to the page behind the backdrop.
    await page.keyboard.press("Shift+Tab");
    expect(await activeElement(page)).toBe("button[submit]");
    expect(await focusIsInsidePanel(page)).toBe(true);

    // Forwards off the back edge wraps the other way.
    await page.keyboard.press("Tab");
    expect(await activeElement(page)).toBe("button[Close]");
    expect(await focusIsInsidePanel(page)).toBe(true);

    // And it holds under sustained pressure: 40 Tabs is more than three full laps
    // of this dialog's 12 controls, so any leak would have surfaced.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(await focusIsInsidePanel(page), `focus escaped on Tab #${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await focusIsInsidePanel(page), `focus escaped on Shift+Tab #${i + 1}`).toBe(true);
    }
  });

  test("PROOF 4 — Escape closes, and so do the backdrop and the ✕", async ({ page }) => {
    await page.goto("/staff");

    await openDialog(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await openDialog(page);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await openDialog(page);
    // The backdrop is the overlay OUTSIDE the panel: click near the top-left
    // corner of the viewport, which the panel never occupies at 1280px.
    await page.mouse.click(8, 8);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("body scroll is locked while open and released on close", async ({ page }) => {
    await page.goto("/staff");
    const before = await page.evaluate(() => getComputedStyle(document.body).overflow);

    await openDialog(page);
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).overflow))
      .toBe(before);
  });

  test("the dialog is portalled, so a parent's spacing cannot move it", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);

    // origin/main rendered the overlay inside /staff's `space-y-6` container, so
    // `margin-top: 24px` applied to a `position: fixed` element and the backdrop
    // started at y=24, leaving the top of the screen undimmed.
    const overlay = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const el = panel?.parentElement as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        parentTag: el.parentElement?.tagName.toLowerCase() ?? null,
        marginTop: getComputedStyle(el).marginTop,
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
      };
    });
    expect(overlay).not.toBeNull();
    expect(overlay!.parentTag).toBe("body");
    expect(overlay!.marginTop).toBe("0px");
    expect(overlay!.top).toBe(0);
    expect(overlay!.left).toBe(0);
    expect(overlay!.width).toBe(overlay!.viewportW);
    expect(overlay!.height).toBe(overlay!.viewportH);
  });

  test("role=dialog is on the panel, not on the click-to-dismiss backdrop", async ({ page }) => {
    await page.goto("/staff");
    await openDialog(page);

    const shape = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      const r = dialog.getBoundingClientRect();
      return {
        ariaModal: dialog.getAttribute("aria-modal"),
        labelledBy: dialog.getAttribute("aria-labelledby"),
        labelExists: !!document.getElementById(
          dialog.getAttribute("aria-labelledby") ?? "__missing",
        ),
        fillsViewport: r.width === window.innerWidth && r.height === window.innerHeight,
      };
    });
    expect(shape.ariaModal).toBe("true");
    expect(shape.labelledBy).toBe("invite-staff-title");
    // A dangling aria-labelledby is how a dialog silently loses its name.
    expect(shape.labelExists).toBe(true);
    // If the dialog filled the viewport it would BE the backdrop, which is what
    // main did — and would mean clicking inside the dialog dismisses it.
    expect(shape.fillsViewport).toBe(false);
  });

  test("the entrance animation finishes, so it cannot hang an axe gate", async ({ page }) => {
    // e2e/_settle.ts waits for `document.getAnimations().length === 0` before every
    // axe scan in this repo. `animate-in` sets only `animation-name`, with no
    // fill-mode, so it stops being in-effect when it ends and drains from that
    // list. Adding `fill-mode-both` to the modal would hang every scanned route
    // forever; this is the pin that says so out loud.
    await page.goto("/staff");
    await openDialog(page);
    await expect
      .poll(() => page.evaluate(() => document.getAnimations().length), { timeout: 5_000 })
      .toBe(0);
  });
});
