import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Contract tests for the multi-org switcher (setActiveOrg).
 *
 * Two guarantees:
 *   1. Security — the requested org is validated against the user's
 *      memberships server-side; the client is never trusted to pick an org.
 *   2. BUG-01 — switching org changes the tenant context for EVERY route,
 *      so the action must purge the full route tree. A bare redirect only
 *      re-renders /dashboard and leaves the client router cache serving the
 *      previous org's customers/quotes/jobs/invoices pages.
 */

const ROOT = resolve(__dirname, "..", "..");
const SRC = readFileSync(resolve(ROOT, "app/(app)/org-actions.ts"), "utf8");

describe("setActiveOrg — multi-org tenant switch", () => {
  it("validates membership server-side before trusting the requested org", () => {
    expect(SRC).toMatch(/from\("memberships"\)/);
    expect(SRC).toMatch(/\.eq\("user_id", user\.id\)/);
    expect(SRC).toMatch(/\.eq\("org_id", orgId\)/);
    expect(SRC).toMatch(/if \(!membership\)/);
  });

  it("purges the full route tree on switch so no prior-org data leaks (BUG-01)", () => {
    expect(SRC).toMatch(/import \{ revalidatePath \} from "next\/cache"/);
    expect(SRC).toMatch(/revalidatePath\("\/", "layout"\)/);
  });
});
