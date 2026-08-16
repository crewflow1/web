import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
} from "@/lib/gdpr/export-tables";

/**
 * P3W2 Payroll — holiday entitlement + pension auto-enrolment trust-boundary
 * pins (hermetic: migration SQL text + source scans + registry, no DB).
 *
 * Both new tables hold per-employee data, keyed (org_id, user_id). The house
 * rule for such tables (holiday_entitlements, pension_enrolments):
 *   1. RLS enabled.
 *   2. SELECT = own row OR org admin, org-pinned (staff see their own; admins the
 *      org). WRITE = admins ONLY — a worker must never set their own allowance
 *      or their own pension status/rate.
 *   3. FK to organizations ON DELETE CASCADE (org teardown), unique (org_id,
 *      user_id) so config is one-per-employee.
 *   4. Classified for GDPR export (business data, so exported — NOT excluded);
 *      no NI number is stored here (those stay in staff_secrets).
 *   5. The reads/writes that feed payroll stay org-pinned on the tenant client.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const HOLIDAY_MIG = read(
  "supabase/migrations/20261142000000_holiday_entitlements.sql",
);
const PENSION_MIG = read(
  "supabase/migrations/20261142000001_pension_enrolments.sql",
);

const TABLES: ReadonlyArray<[string, string]> = [
  ["holiday_entitlements", HOLIDAY_MIG],
  ["pension_enrolments", PENSION_MIG],
];

// =====================================================================
// 1. RLS + admin-only writes / own-or-admin reads
// =====================================================================

describe.each(TABLES)("%s RLS — per-employee, admin-write", (table, mig) => {
  it("enables row level security", () => {
    expect(mig).toMatch(
      new RegExp(`alter table public\\.${table} enable row level security`),
    );
  });

  it("SELECT policy allows own rows OR org admin, org-pinned", () => {
    const sel = mig.match(
      /create policy[^;]*for select to authenticated[\s\S]*?;/i,
    );
    expect(sel, "missing select policy").not.toBeNull();
    expect(/user_id = auth\.uid\(\)/.test(sel![0])).toBe(true);
    expect(/is_org_admin\(org_id\)/.test(sel![0])).toBe(true);
    expect(/current_org_ids\(\)/.test(sel![0])).toBe(true);
  });

  it("every WRITE policy is admin-only (is_org_admin) and never a bare member", () => {
    for (const verb of ["insert", "update", "delete"]) {
      const block = mig.match(
        new RegExp(
          `create policy[^;]*for ${verb} to authenticated[\\s\\S]*?;`,
          "i",
        ),
      );
      expect(block, `missing ${verb} policy`).not.toBeNull();
      expect(
        /is_org_admin\(org_id\)/.test(block![0]),
        `${verb} policy must gate is_org_admin(org_id)`,
      ).toBe(true);
      // A staff member must not be able to write: no auth.uid() self-write path,
      // and not the broad member predicate either.
      expect(
        /user_id = auth\.uid\(\)/.test(block![0]),
        `${verb} policy must NOT allow self-write`,
      ).toBe(false);
      expect(
        /is_org_member/.test(block![0]),
        `${verb} policy must NOT allow any member`,
      ).toBe(false);
    }
  });

  it("keys per employee and cascades on org teardown", () => {
    expect(mig).toMatch(
      new RegExp(
        `org_id[\\s\\S]*?references public\\.organizations \\(id\\) on delete cascade`,
      ),
    );
    expect(mig).toMatch(/unique \(org_id, user_id\)/);
  });
});

// =====================================================================
// 2. No government identifiers leak into the pension table
// =====================================================================

describe("pension_enrolments stores no government identifiers", () => {
  it("has no ni_number / national insurance column (those live in staff_secrets)", () => {
    expect(/ni_number/i.test(PENSION_MIG)).toBe(false);
    expect(/national\s*insurance/i.test(codeOf(PENSION_MIG))).toBe(false);
  });

  it("bounds status to the four tracked auto-enrolment states", () => {
    expect(PENSION_MIG).toMatch(
      /status in \('not_enrolled', 'enrolled', 'opted_out', 'postponed'\)/,
    );
  });

  it("bounds contribution rates to fractions 0..1", () => {
    expect(PENSION_MIG).toMatch(
      /employer_contribution_rate >= 0 and employer_contribution_rate <= 1/,
    );
  });
});

// =====================================================================
// 3. GDPR export registration (business data → exported, not excluded)
// =====================================================================

describe("GDPR export registration", () => {
  for (const [table] of TABLES) {
    it(`${table} is a known org-scoped table AND exported (not excluded)`, () => {
      expect(KNOWN_ORG_SCOPED_TABLES).toContain(table);
      expect(ORG_EXPORT_TABLES).toContain(table);
      expect(EXCLUDED_FROM_EXPORT[table]).toBeUndefined();
    });
  }
});

// =====================================================================
// 4. The payroll/UI reads that feed employer cost stay org-pinned
// =====================================================================

describe("payroll pension read is org-pinned on the tenant client", () => {
  it("getPensionEnrolmentsForOrg pins org_id and pages (F-1)", () => {
    const svc = codeOf(read("server/services/pension-enrolment.ts"));
    expect(svc).toMatch(/\.eq\("org_id", orgId\)/);
    expect(svc).toMatch(/\.range\(from, to\)/);
  });

  it("the holiday balance service pins org_id on both config and leave reads", () => {
    const svc = codeOf(read("server/services/holiday-balance.ts"));
    // Config read (own-or-admin) and the leave read are both org-pinned.
    const pins = svc.match(/\.eq\("org_id"[^)]*\)/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(2);
  });

  it("the payroll run page still discloses employer costs are estimates", () => {
    const page = read("app/(app)/payroll/[id]/page.tsx").replace(/\s+/g, " ");
    expect(page).toMatch(/<strong>estimates<\/strong>/);
    // Pension is now derived through the enrolment-aware helper.
    expect(page).toMatch(/employerCostsForStoredLineWithPension/);
  });
});
