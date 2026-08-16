import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
} from "@/lib/gdpr/export-tables";

/**
 * MP R2 Payroll — payroll_tax_profiles trust-boundary pins (hermetic: migration SQL
 * text + source scans + registry, no DB).
 *
 * Per-employee payroll tax INPUTS (income-tax region, student-loan plan, salary
 * sacrifice), keyed (org_id, user_id). Same house rule as pension_enrolments /
 * holiday_entitlements:
 *   1. RLS enabled.
 *   2. SELECT = own row OR org admin, org-pinned. WRITE = admins ONLY (a worker must
 *      never set their own tax region / sacrifice — that would change their pay).
 *   3. FK to organizations ON DELETE CASCADE; unique (org_id, user_id).
 *   4. Classified for GDPR export (business payroll config → exported, NOT excluded);
 *      no NI number here (those stay in staff_secrets).
 *   5. The service + admin action that write it stay org-pinned on the tenant client.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG = read(
  "supabase/migrations/20261155000000_payroll_employee_tax_inputs.sql",
);
const TABLE = "payroll_tax_profiles";

// =====================================================================
// 1. RLS + admin-only writes / own-or-admin reads
// =====================================================================

describe(`${TABLE} RLS — per-employee, admin-write`, () => {
  it("enables row level security", () => {
    expect(MIG).toMatch(
      new RegExp(`alter table public\\.${TABLE} enable row level security`),
    );
  });

  it("SELECT policy allows own rows OR org admin, org-pinned", () => {
    const sel = MIG.match(/create policy[^;]*for select to authenticated[\s\S]*?;/i);
    expect(sel, "missing select policy").not.toBeNull();
    expect(/user_id = auth\.uid\(\)/.test(sel![0])).toBe(true);
    expect(/is_org_admin\(org_id\)/.test(sel![0])).toBe(true);
    expect(/current_org_ids\(\)/.test(sel![0])).toBe(true);
  });

  it("every WRITE policy is admin-only (is_org_admin) and never a bare member", () => {
    for (const verb of ["insert", "update", "delete"]) {
      const block = MIG.match(
        new RegExp(`create policy[^;]*for ${verb} to authenticated[\\s\\S]*?;`, "i"),
      );
      expect(block, `missing ${verb} policy`).not.toBeNull();
      expect(
        /is_org_admin\(org_id\)/.test(block![0]),
        `${verb} policy must gate is_org_admin(org_id)`,
      ).toBe(true);
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
    expect(MIG).toMatch(
      /org_id[\s\S]*?references public\.organizations \(id\) on delete cascade/,
    );
    expect(MIG).toMatch(/unique \(org_id, user_id\)/);
  });
});

// =====================================================================
// 2. Value domains are bounded, and no government identifiers leak in
// =====================================================================

describe(`${TABLE} bounds its inputs and stores no identifiers`, () => {
  it("bounds tax_region to the two supported regimes", () => {
    expect(MIG).toMatch(/tax_region in \('rest_of_uk', 'scotland'\)/);
  });

  it("bounds student_loan_plan to none + the four plans", () => {
    expect(MIG).toMatch(
      /student_loan_plan in \('none', 'plan_1', 'plan_2', 'plan_4', 'postgraduate'\)/,
    );
  });

  it("forbids a negative salary sacrifice", () => {
    expect(MIG).toMatch(/salary_sacrifice_annual_pence >= 0/);
  });

  it("defaults preserve existing behaviour (rest_of_uk / none / 0)", () => {
    expect(MIG).toMatch(/tax_region\s+text\s+not null default 'rest_of_uk'/);
    expect(MIG).toMatch(/student_loan_plan text\s+not null default 'none'/);
    expect(MIG).toMatch(/salary_sacrifice_annual_pence bigint not null default 0/);
  });

  it("stores no NI number / national insurance column", () => {
    expect(/ni_number/i.test(MIG)).toBe(false);
    expect(/national\s*insurance/i.test(codeOf(MIG))).toBe(false);
  });
});

// =====================================================================
// 3. GDPR export registration (business data → exported, not excluded)
// =====================================================================

describe("GDPR export registration", () => {
  it(`${TABLE} is a known org-scoped table AND exported (not excluded)`, () => {
    expect(KNOWN_ORG_SCOPED_TABLES).toContain(TABLE);
    expect(ORG_EXPORT_TABLES).toContain(TABLE);
    expect(EXCLUDED_FROM_EXPORT[TABLE]).toBeUndefined();
  });
});

// =====================================================================
// 4. The service + admin action stay org-pinned on the tenant client
// =====================================================================

describe("payroll tax profile reads/writes are org-pinned", () => {
  it("the service pins org_id and pages (F-1)", () => {
    const svc = codeOf(read("server/services/payroll-tax-profile.ts"));
    expect(svc).toMatch(/\.eq\("org_id", orgId\)/);
    expect(svc).toMatch(/\.range\(from, to\)/);
    // upsert pins org_id from context and de-conflicts including org_id.
    expect(svc).toMatch(/onConflict: "org_id,user_id"/);
  });

  it("the staff action is admin-gated and pins org_id from context, not client input", () => {
    const act = codeOf(read("app/(app)/staff/actions.ts"));
    const fn = act.match(
      /export async function upsertPayrollTaxProfileAction[\s\S]*?\n}/,
    );
    expect(fn, "action not found").not.toBeNull();
    expect(/requireAdmin\(ctx\)/.test(fn![0])).toBe(true);
    expect(/ctx\.org\.id/.test(fn![0])).toBe(true);
  });

  it("the payroll run page applies the profile through the shared mapper", () => {
    const page = read("app/(app)/payroll/[id]/page.tsx").replace(/\s+/g, " ");
    expect(page).toMatch(/getPayrollTaxProfilesForOrg\(ctx\.org\.id\)/);
    expect(page).toMatch(/employeeInputFromStoredProfile/);
  });
});
