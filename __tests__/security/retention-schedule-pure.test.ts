import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Retention scheduling — the derivation stays PURE and staff-only.
 *
 * The dashboard "retention due back" rollup is safe only because it reads on the
 * tenant client (RLS) and computes in pure TS — never the RLS-bypassing admin
 * client (a precedent for which sits in the same dashboard file). These pure
 * libs must therefore touch no Supabase client at all.
 *
 * H2-CASH M3 reversal (deliberate): the customer portal now surfaces a NARROW
 * retention subset — the held £ and the earliest release date — on the payment
 * schedule. The security contract is therefore no longer "the portal reads no
 * retention terms" (the schedule loader legitimately reads the job's terms to
 * DERIVE the release date), but "the customer-facing DTO exposes ONLY held +
 * releaseDate — never the rate, certified base, accrued/released split or the
 * raw moiety terms." That structural boundary is what these tests now pin.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("retention scheduling — pure derivation, customer-safe exposure", () => {
  it("schedule + rollup + portal-schedule libs import no Supabase client", () => {
    for (const p of ["lib/retentions/schedule.ts", "lib/retentions/rollup.ts", "lib/customers/portal-schedule.ts"]) {
      const code = read(p);
      expect(code, `${p} must be pure`).not.toMatch(/@\/lib\/supabase/);
      expect(code).not.toMatch(/createClient|createAdminClient/);
    }
  });

  it("the portal JOBS page still selects no retention terms (it has no reason to)", () => {
    const portalJobs = read("app/customer-portal/[token]/jobs/page.tsx");
    expect(portalJobs).not.toMatch(/practical_completion_date|defects_liability|retention_first_release|retention_percent/);
  });

  it("the customer-facing retention DTO exposes ONLY held + releaseDate — no rate/base/moiety", () => {
    // The schedule loader (_schedule.ts) may READ the terms server-side to derive
    // the date, but the PortalRetentionLine that reaches the customer is narrow.
    const dto = read("lib/customers/portal-schedule.ts");
    // The retention line interface fields — nothing but held + releaseDate.
    expect(dto).toMatch(/interface PortalRetentionLine\s*{[^}]*held:[^}]*releaseDate:[^}]*}/s);
    expect(dto).not.toMatch(/ratePercent|invoicedBase|accrued|moiet/i);
    // The loader must only ever hand the schedule {held, releaseDate}, never the raw position.
    const loader = read("app/customer-portal/[token]/_schedule.ts");
    expect(loader).toMatch(/retention:\s*held\s*>\s*0\s*\?\s*{\s*held,\s*releaseDate\s*}/);
  });
});
