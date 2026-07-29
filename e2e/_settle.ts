import type { Page } from "@playwright/test";

/**
 * Wait for a streamed App Router page to actually settle before running axe.
 *
 * `page.goto()` resolves on `load`, but these pages stream: Suspense fallbacks
 * (Tailwind `animate-pulse` skeletons) still occupy the data-dependent regions
 * at that moment, and the real rows/pills swap in a beat later. axe-core
 * snapshots the tree when analyze() starts, so a scan fired straight after
 * goto() audits the skeleton page — and reports zero violations for content
 * that was never scanned. That is not hypothetical: the register tab badges and
 * status chips on /health-safety failed WCAG AA contrast for as long as they
 * existed, and every CI run stayed green because analyze() always beat the
 * stream (the same scan run after settling reported them immediately).
 *
 * The wait is exact, not a sleep. Skeleton pulses are infinite CSS animations,
 * so "zero running animations" is precisely "every fallback has unmounted";
 * the axe-scanned routes render no persistent animation once settled (verified
 * per route). If someone later adds one, this times out loudly — a prompt to
 * scope the wait — rather than letting the suite silently scan half a page.
 * Fonts settle first: glyph metrics decide axe's large-text contrast threshold.
 */
export async function settleForAxe(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().length === 0);
}
