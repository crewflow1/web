import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Hotfix pin — first-login auto-trial accepts BOTH legacy
 * status="approved" (from /admin/organizations) and current
 * status="won" (from the /admin/demos kanban).
 *
 * Before this fix, a prospect approved via the new Demos CRM
 * kanban would hit /access-pending on first sign-up because
 * bootstrap-account.ts:80 only checked for "approved".
 *
 * Pin both shapes so a future refactor that re-narrows the filter
 * is caught.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const BOOTSTRAP = read("server/services/bootstrap-account.ts");
const DEMOS_ACTIONS = read("app/admin/demos/actions.ts");

describe("auto-trial — accepts both approved + won statuses", () => {
  it("bootstrap query uses .in() with both vocab values", () => {
    // Matches whether the formatter wraps the array onto multiple lines.
    expect(BOOTSTRAP).toMatch(
      /\.in\("status",\s*\[\s*"approved",\s*"won"\s*\]\)/,
    );
  });

  it("no longer uses the brittle .eq('status', 'approved') filter", () => {
    expect(BOOTSTRAP).not.toMatch(/\.eq\("status", "approved"\)/);
  });

  it("the Demos kanban DOES still write status='won' (the vocab the fix targets)", () => {
    // Sanity check that the two surfaces are aligned. If the kanban
    // ever renames "won" to something else, this test fires so we
    // remember to update bootstrap-account.ts in lockstep.
    expect(DEMOS_ACTIONS).toMatch(/"won"/);
    expect(DEMOS_ACTIONS).toMatch(/parsed\.data\.status === "won"/);
  });
});
