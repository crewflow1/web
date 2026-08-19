import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Migration shape guard for 20261177000000 — the three payroll capabilities.
 *
 * These pin the DEFAULT-SAFETY and TENANT-SAFETY contract at the SQL level so a
 * future edit cannot silently make the new columns change existing runs or let an
 * adjustment reference another tenant's line:
 *   - every new payroll_lines column defaults to 0 (⇒ gross unchanged)
 *   - ni_category defaults to 'A' (⇒ standard-rate path, unchanged)
 *   - standard_hours_per_day is NULLABLE (⇒ no holiday pay by default)
 *   - the audit table is org-scoped, RLS-enabled, admin-gated, composite-FK'd
 */

const SQL = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20261177000000_payroll_ni_categories_overtime_holiday.sql",
  ),
  "utf8",
);

describe("migration 20261177000000 — payroll_tax_profiles additions", () => {
  it("adds ni_category defaulting to 'A' with the full eight-letter CHECK", () => {
    expect(SQL).toMatch(/add column if not exists ni_category text not null default 'A'/);
    expect(SQL).toMatch(
      /check \(ni_category in \('A', 'B', 'C', 'J', 'H', 'M', 'V', 'Z'\)\)/,
    );
  });

  it("adds date_of_birth as a NULLABLE column (no default, never required)", () => {
    expect(SQL).toMatch(/add column if not exists date_of_birth date;/);
    // Must not be NOT NULL — it is optional and only powers the consistency warning.
    expect(SQL).not.toMatch(/date_of_birth date not null/);
  });

  it("adds standard_hours_per_day nullable and bounded, so holiday pay is opt-in", () => {
    expect(SQL).toMatch(/add column if not exists standard_hours_per_day numeric\(5, 2\);/);
    expect(SQL).toMatch(/standard_hours_per_day is null/);
  });
});

describe("migration 20261177000000 — payroll_lines additions default to 0", () => {
  const cols = [
    "overtime_hours numeric(6, 2) not null default 0",
    "overtime_pay numeric(10, 2) not null default 0",
    "leave_hours numeric(6, 2) not null default 0",
    "leave_pay numeric(10, 2) not null default 0",
  ];
  for (const c of cols) {
    it(`adds "${c.split(" ")[0]}" defaulting to 0 (gross unchanged for existing runs)`, () => {
      expect(SQL).toContain(`add column if not exists ${c}`);
    });
  }

  it("overtime_multiplier defaults to 1.5 but is inert while overtime_hours is 0", () => {
    expect(SQL).toMatch(
      /add column if not exists overtime_multiplier numeric\(5, 3\) not null default 1\.5/,
    );
  });

  it("guards every new money/hours column as non-negative", () => {
    expect(SQL).toMatch(/payroll_lines_overtime_holiday_nonneg_check/);
  });
});

describe("migration 20261177000000 — payroll_line_adjustments audit table", () => {
  it("is org-scoped and references payroll_lines via a COMPOSITE (id, org_id) FK", () => {
    expect(SQL).toMatch(/create table if not exists public\.payroll_line_adjustments/);
    expect(SQL).toMatch(/unique \(id, org_id\)/); // enables the composite FK
    expect(SQL).toMatch(
      /foreign key \(payroll_line_id, org_id\)\s*references public\.payroll_lines \(id, org_id\)/,
    );
  });

  it("enables RLS and gates read + insert on is_org_admin, with no update/delete policy", () => {
    expect(SQL).toMatch(
      /alter table public\.payroll_line_adjustments enable row level security/,
    );
    expect(SQL).toMatch(/for select to authenticated\s*\n\s*using \(public\.is_org_admin\(org_id\)\)/);
    expect(SQL).toMatch(/for insert to authenticated\s*\n\s*with check \(public\.is_org_admin\(org_id\)\)/);
    expect(SQL).not.toMatch(/for update to authenticated/);
    expect(SQL).not.toMatch(/for delete to authenticated/);
  });

  it("records before AND after values plus the actor", () => {
    for (const c of [
      "old_overtime_hours",
      "new_overtime_hours",
      "old_overtime_multiplier",
      "new_overtime_multiplier",
      "old_gross_pay",
      "new_gross_pay",
      "actor_id",
    ]) {
      expect(SQL).toContain(c);
    }
  });
});
