import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Portal shell — mobile navigation ergonomics (works-quality mobile-pin style).
 *
 * Eleven tabs no longer fit a 375px screen as a horizontal strip. The shell
 * now ships a fixed bottom nav (4 primary destinations + a "More" disclosure)
 * on phones and keeps the tab strip on sm+. These pins hold the ergonomics a
 * refactor would silently lose: touch targets, aria-current, no body-widening
 * sheet, and content clearance above the fixed bar.
 */

const ROOT = resolve(__dirname, "..", "..");
const SHELL = readFileSync(
  resolve(ROOT, "app/customer-portal/[token]/_shell.tsx"),
  "utf8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("two navs, one per form factor — both labelled, both aria-current", () => {
  it("the tab strip is hidden on phones and shown from sm up", () => {
    expect(SHELL).toMatch(/hidden max-w-3xl px-4 sm:block/);
  });

  it("the bottom nav exists only on phones and is fixed to the viewport bottom", () => {
    expect(SHELL).toMatch(/fixed inset-x-0 bottom-0[^"]*sm:hidden/);
  });

  it("both navs carry an accessible name", () => {
    expect(SHELL.match(/aria-label="Portal sections"/g) ?? []).toHaveLength(2);
  });

  it("aria-current='page' marks the active link in the strip, the bar AND the More sheet", () => {
    expect(
      SHELL.match(/aria-current=\{t\.id === active \? "page" : undefined\}/g) ?? [],
    ).toHaveLength(3);
  });
});

describe("this is used on a phone, on site, possibly in gloves", () => {
  it("every bottom-bar target is at least 44px tall (56 here)", () => {
    const barLinks = SHELL.match(/min-h-\[56px\]/g) ?? [];
    expect(barLinks.length).toBeGreaterThanOrEqual(2); // primary links + summary
  });

  it("every More-sheet link is at least 44px tall", () => {
    expect(SHELL).toMatch(/flex min-h-\[44px\] items-center rounded-lg/);
  });

  it("the sheet floats above the bar without widening the body — no horizontal scroll at 375px", () => {
    // Fixed-width absolute panel anchored to the disclosure, not a full-width row.
    expect(SHELL).toMatch(/absolute bottom-full[^"]*w-56/);
    expect(SHELL).toMatch(/grid grid-cols-5/);
  });

  it("content and footer clear the fixed bar on phones only", () => {
    expect(SHELL).toMatch(/pb-24 pt-6 sm:pb-6/);
    expect(SHELL).toMatch(/pb-28 pt-4[^"]*sm:pb-8/);
  });

  it("respects the home-indicator safe area", () => {
    expect(SHELL).toMatch(/pb-\[env\(safe-area-inset-bottom\)\]/);
  });

  it("the disclosure is native details/summary — keyboard + SR support without client JS", () => {
    expect(SHELL).toMatch(/<details/);
    expect(SHELL).toMatch(/<summary/);
    expect(SHELL).not.toMatch(/"use client"/);
    expect(SHELL).not.toMatch(/useState|onClick/);
  });
});

describe("every portal section is reachable from both navs", () => {
  const ALL_TABS = [
    "overview",
    "quotes",
    "invoices",
    "jobs",
    "photos",
    "reports",
    "warranties",
    "documents",
    "messages",
    "requests",
    "profile",
  ];

  it("the tabs list declares all eleven sections", () => {
    for (const id of ALL_TABS) {
      expect(SHELL, `tab "${id}" missing`).toContain(`id: "${id}"`);
    }
  });

  it("the primary set is a subset of the declared tabs, and More carries the rest", () => {
    expect(SHELL).toMatch(/PRIMARY_TAB_IDS[\s\S]*"overview",\s*\n?\s*"jobs",\s*\n?\s*"invoices",\s*\n?\s*"messages",?/);
    expect(SHELL).toMatch(/moreTabs = tabs\.filter\(\(t\) => !PRIMARY_TAB_IDS\.includes\(t\.id\)\)/);
  });

  it("the More trigger reflects an active overflow tab", () => {
    expect(SHELL).toMatch(/moreIsActive = moreTabs\.some\(\(t\) => t\.id === active\)/);
  });
});
