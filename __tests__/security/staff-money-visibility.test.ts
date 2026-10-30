import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Staff money-visibility boundary (pre-Customer-#1 closeout).
 *
 * The "staff/field members cannot see prices or money" rule is enforced across
 * the main money surfaces (invoices, quotes, customers, finances, cash, job
 * Commercial) via requireManagementRole / requireManagementContext. Three
 * surfaces previously rendered money to a `staff` user who reached them by
 * DIRECT URL even though the nav link was hidden:
 *   - /price-book            (the rate library a quote is built from)
 *   - /jobs/[id]/billing     ("Get paid" — contract/billed/received/debtors)
 *   - /jobs/[id]/valuations  (applications for payment — contract + retention)
 *
 * This proves the boundary now FAILS CLOSED at each page (server-side, before
 * any money read) and that management roles still get through — i.e. hiding the
 * tab is defence-in-depth, not the boundary. Hermetic: one mocked redirect +
 * pure-function checks + source contracts. No DB, no network.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
/** Strip comments so ordering/wiring assertions test EXECUTABLE code only. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// The real guard mechanism these pages rely on. Mock only the redirect sink so
// a "denied" outcome is observable; everything else is the genuine module.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const { isManagementRole, requireManagementRole } = await import(
  "@/server/auth/session"
);

const ctxFor = (role: string | null) =>
  ({ membership: { role } }) as unknown as Parameters<typeof requireManagementRole>[0];

// ---------------------------------------------------------------------------
// 1. THE GUARD MECHANISM — staff fails closed, management passes
// ---------------------------------------------------------------------------
describe("requireManagementRole — the money boundary primitive", () => {
  it("treats ONLY owner/admin as management", () => {
    expect(isManagementRole("owner")).toBe(true);
    expect(isManagementRole("admin")).toBe(true);
    expect(isManagementRole("staff")).toBe(false);
    // Any future/unknown role must fail closed, never be silently admitted.
    expect(isManagementRole("viewer")).toBe(false);
    expect(isManagementRole(null)).toBe(false);
    expect(isManagementRole(undefined)).toBe(false);
  });

  it("REDIRECTS a staff caller away (fail closed) — no money data reachable", () => {
    expect(() => requireManagementRole(ctxFor("staff"))).toThrowError(
      /NEXT_REDIRECT:\/dashboard\?error=forbidden/,
    );
  });

  it("redirects an unknown/new role too (fail closed)", () => {
    expect(() => requireManagementRole(ctxFor("viewer"))).toThrowError(/NEXT_REDIRECT:/);
  });

  it("lets owner and admin through (management still works)", () => {
    expect(() => requireManagementRole(ctxFor("owner"))).not.toThrow();
    expect(() => requireManagementRole(ctxFor("admin"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. THE THREE SURFACES ARE WIRED TO IT — before any money read
// ---------------------------------------------------------------------------
// Each money surface must gate server-side BEFORE its first money read. All
// three are now on the R4 capability model — price-book on price_book:view, and
// the job-invoicing surfaces (billing + valuations) on invoices:view — a
// strictly-equal-or-stronger boundary than the old management role (still denies
// staff, additionally supports granular admins). This guard pins the exact gate
// each surface uses and that it precedes the money read.
const SURFACES: {
  file: string;
  firstMoneyRead: string;
  importRe: RegExp;
  guardCall: string;
}[] = [
  {
    file: "app/(app)/price-book/page.tsx",
    firstMoneyRead: "listPriceBookItems(",
    importRe: /requireCapability[\s\S]*from\s+"@\/server\/auth\/capabilities"/,
    guardCall: 'requireCapability("price_book", "view")',
  },
  {
    file: "app/(app)/jobs/[id]/billing/page.tsx",
    firstMoneyRead: "loadJobBilling(",
    importRe: /requireCapability[\s\S]*from\s+"@\/server\/auth\/capabilities"/,
    guardCall: 'requireCapability("invoices", "view")',
  },
  {
    file: "app/(app)/jobs/[id]/valuations/page.tsx",
    firstMoneyRead: "buildJobValuationsView(",
    importRe: /requireCapability[\s\S]*from\s+"@\/server\/auth\/capabilities"/,
    guardCall: 'requireCapability("invoices", "view")',
  },
];

describe("money surfaces gate before reading", () => {
  for (const { file, firstMoneyRead, importRe, guardCall } of SURFACES) {
    it(`${file} gates (${guardCall}) before its money read`, () => {
      const code = codeOf(read(file));
      expect(code, `${file} must import the guard`).toMatch(importRe);
      const guardAt = code.indexOf(guardCall);
      const readAt = code.indexOf(firstMoneyRead);
      expect(guardAt, `${file} must call ${guardCall}`).toBeGreaterThan(-1);
      expect(readAt, `${file} must perform its money read (${firstMoneyRead})`).toBeGreaterThan(-1);
      expect(
        guardAt,
        `${file} must gate BEFORE reading money (${firstMoneyRead})`,
      ).toBeLessThan(readAt);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. THE TABS ARE HIDDEN FROM STAFF (defence-in-depth, not the boundary)
// ---------------------------------------------------------------------------
describe("job Valuations + Billing tabs are management-only", () => {
  const tabs = read("app/(app)/jobs/[id]/_job-tabs.tsx");
  it("marks Valuations adminOnly", () => {
    expect(tabs).toMatch(/label:\s*"Valuations"[\s\S]{0,80}adminOnly:\s*true/);
  });
  it("marks Billing adminOnly", () => {
    expect(tabs).toMatch(/label:\s*"Billing"[\s\S]{0,80}adminOnly:\s*true/);
  });
  it("still filters adminOnly tabs out for non-admins", () => {
    expect(codeOf(tabs)).toMatch(/TABS\.filter\(\(t\)\s*=>\s*isAdmin\s*\|\|\s*!t\.adminOnly\)/);
  });
});
