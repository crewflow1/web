import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CURRENT_TOS_VERSION, LEGACY_TOS_VERSION } from "@/lib/legal/tos";

/**
 * ToS stamping — unit contract (L11 item 3).
 *
 * The org-creation server action must stamp acceptance (org-level: the
 * org is the contracting party — rationale in migration 20261223000000)
 * with the CURRENT version constant, attributed to the creating user.
 * Behaviour against a real database is proved in
 * __tests__/integration/onboarding/tos-acceptance.test.ts.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const ACTION = read("app/onboarding/company/actions.ts");
const MIGRATION = read(
  "supabase/migrations/20261223000000_tos_acceptance.sql",
);

describe("ToS version constant", () => {
  it("is a dated version string, never the reserved backfill marker", () => {
    expect(CURRENT_TOS_VERSION).toMatch(/^\d{4}-\d{2}$/);
    // The stamped version must name terms a person could actually have read:
    // it tracks the PUBLISHED revision (app/terms/page.tsx lastUpdated).
    const termsPage = readFileSync(
      resolve(__dirname, "..", "..", "app/terms/page.tsx"),
      "utf8",
    );
    const published = /lastUpdated="(\d{4}-\d{2})-\d{2}"/.exec(termsPage)?.[1];
    expect(published, "app/terms/page.tsx must carry lastUpdated").toBeTruthy();
    expect(CURRENT_TOS_VERSION).toBe(published);
    expect(CURRENT_TOS_VERSION).not.toBe(LEGACY_TOS_VERSION);
    expect(LEGACY_TOS_VERSION).toBe("legacy");
  });
});

describe("org-creation action stamps acceptance", () => {
  it("writes all three tos columns onto the freshly created org", () => {
    expect(ACTION).toMatch(/from "@\/lib\/legal\/tos"/);
    expect(ACTION).toMatch(/tos_accepted_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(ACTION).toMatch(/tos_accepted_by:\s*user\.id/);
    expect(ACTION).toMatch(/tos_version:\s*CURRENT_TOS_VERSION/);
    // Targeted at the org just created, not some client-supplied id.
    expect(ACTION).toMatch(/\.eq\("id", result\.orgId\)/);
  });

  it("never hard-codes a version string or the legacy marker", () => {
    expect(ACTION).not.toMatch(/tos_version:\s*"/);
    expect(ACTION).not.toMatch(/"legacy"/);
  });
});

describe("migration 20261223000000 — org-level columns + honest backfill", () => {
  it("adds the three columns on organizations (the contracting party)", () => {
    expect(MIGRATION).toMatch(/alter table public\.organizations/);
    expect(MIGRATION).toMatch(/tos_accepted_at timestamptz/);
    expect(MIGRATION).toMatch(
      /tos_accepted_by uuid\s*\n?\s*references public\.users\(id\) on delete set null/,
    );
    expect(MIGRATION).toMatch(/tos_version text/);
    // Documents WHY org-level, not user-level.
    expect(MIGRATION).toMatch(/WHY ORG-LEVEL, NOT USER-LEVEL/);
  });

  it("backfills existing orgs honestly: created_at + 'legacy', never a version claim", () => {
    expect(MIGRATION).toMatch(/set tos_accepted_at = o\.created_at/);
    expect(MIGRATION).toMatch(/tos_version = 'legacy'/);
    expect(MIGRATION).toMatch(/where o\.tos_accepted_at is null/);
    // The backfill must NOT fabricate who clicked.
    expect(MIGRATION).not.toMatch(/set[\s\S]{0,120}tos_accepted_by =/);
    // …and must NOT stamp memberless shells (a bare HQ-seeded org has nobody
    // who could have accepted anything — its honest state stays NULL / "—").
    expect(MIGRATION).toMatch(
      /exists \(select 1 from public\.memberships m where m\.org_id = o\.id\)/,
    );
  });
});

describe("HQ customer page surfaces the stamp", () => {
  it("snapshot selects the tos columns and the page renders them", () => {
    const snapshot = read("server/services/hq-customer-snapshot.ts");
    for (const col of ["tos_accepted_at", "tos_accepted_by", "tos_version"]) {
      expect(snapshot).toMatch(new RegExp(`"${col}"`));
    }
    const page = read("app/admin/customers/[id]/page.tsx");
    expect(page).toMatch(/org\.tos_accepted_at/);
    expect(page).toMatch(/org\.tos_version/);
    expect(page).toMatch(/backfilled from signup date/);
  });
});
