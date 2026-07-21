import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Retention scheduling — the derivation stays PURE and staff-only.
 *
 * The dashboard "retention due back" rollup is safe only because it reads on the
 * tenant client (RLS) and computes in pure TS — never the RLS-bypassing admin
 * client (a precedent for which sits in the same dashboard file). These pure
 * libs must therefore touch no Supabase client at all; and the retention terms
 * must never be selected on a customer-portal surface.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("retention scheduling — pure derivation, staff-only", () => {
  it("schedule + rollup libs import no Supabase client", () => {
    for (const p of ["lib/retentions/schedule.ts", "lib/retentions/rollup.ts"]) {
      const code = read(p);
      expect(code, `${p} must be pure`).not.toMatch(/@\/lib\/supabase/);
      expect(code).not.toMatch(/createClient|createAdminClient/);
    }
  });

  it("the customer portal never selects the retention schedule terms", () => {
    // The portal runs on the service-role client; any retention column it
    // SELECTs would leak internal commercial posture (F2/F10).
    const portalJobs = read("app/customer-portal/[token]/jobs/page.tsx");
    expect(portalJobs).not.toMatch(/practical_completion_date|defects_liability|retention_first_release|retention_percent/);
  });
});
