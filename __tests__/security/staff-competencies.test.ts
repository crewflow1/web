import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUALIFICATION_TYPES } from "@/lib/staff/qualifications";

/**
 * Staff competencies (staff_qualifications + jobs.required_qualifications) —
 * source-pinned tenant-isolation invariants.
 *
 * No mock harness exists for RSC pages / server actions, so (matching the house
 * convention) the RLS, composite-FK, admin-write, loud-read and GDPR-registry
 * invariants are pinned against SOURCE here; the runtime is proven separately in
 * the integration RLS tier. These fail loudly if a future edit drops an org pin,
 * weakens an RLS posture, or forgets the registry.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIG = "supabase/migrations/20261149000000_staff_competencies.sql";

describe("migration — RLS + composite FK + admin-only writes", () => {
  const sql = src(MIG);

  it("enables RLS on staff_qualifications", () => {
    expect(sql).toMatch(/alter table public\.staff_qualifications enable row level security/);
  });

  it("scopes reads to org membership and gates every write to admins", () => {
    expect(sql).toMatch(/staff_qualifications_select[\s\S]*current_org_ids\(\)/);
    expect(sql).toMatch(/staff_qualifications_insert[\s\S]*is_org_admin\(org_id\)/);
    expect(sql).toMatch(/staff_qualifications_update[\s\S]*is_org_admin\(org_id\)/);
    expect(sql).toMatch(/staff_qualifications_delete[\s\S]*is_org_admin\(org_id\)/);
  });

  it("binds the member with a COMPOSITE FK to the memberships candidate key", () => {
    expect(sql).toMatch(
      /foreign key \(org_id, user_id\)\s*references public\.memberships \(org_id, user_id\)/,
    );
  });

  it("pins org_id to organizations and cascades on org teardown", () => {
    expect(sql).toMatch(
      /org_id\s+uuid\s+not null references public\.organizations \(id\) on delete cascade/,
    );
  });

  it("enforces the date order and org-first document path at the DB", () => {
    expect(sql).toMatch(/staff_qualifications_dates_ordered/);
    expect(sql).toMatch(/staff_qualifications_document_path_org_first/);
    expect(sql).toMatch(/split_part\(document_path, '\/', 1\) = org_id::text/);
  });

  it("adds jobs.required_qualifications additively, defaulted to empty", () => {
    expect(sql).toMatch(
      /alter table public\.jobs\s*\n?\s*add column if not exists required_qualifications text\[\] not null default '\{\}'::text\[\]/,
    );
  });

  it("the CHECK vocabulary is byte-identical to QUALIFICATION_TYPES", () => {
    const m = sql.match(/qualification_type in \(([^)]*)\)/);
    expect(m).toBeTruthy();
    const inSql = ((m?.[1] ?? "").match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
    expect(new Set(inSql)).toEqual(new Set(QUALIFICATION_TYPES));
  });
});

describe("server actions — org pin + admin gate", () => {
  const code = codeOf(src("app/(app)/staff/actions.ts"));

  it("writes stamp the ACTIVE org and re-check admin", () => {
    expect(code).toMatch(/addStaffQualification/);
    expect(code).toMatch(/deleteStaffQualification/);
    expect(code).toMatch(/org_id: ctx\.org\.id/);
    // both actions call requireAdmin(ctx).
    const admins = code.match(/requireAdmin\(ctx\)/g) ?? [];
    expect(admins.length).toBeGreaterThanOrEqual(2);
  });

  it("the delete is org-pinned as well as id-scoped", () => {
    expect(code).toMatch(/\.delete\(\)[\s\S]*?\.eq\("id", qualId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });
});

describe("reads — active-org pinned + loud", () => {
  it("the qualifications + performance services pin org_id and fail loudly", () => {
    const quals = codeOf(src("server/services/staff-qualifications.ts"));
    expect(quals).toMatch(/\.eq\("org_id", orgId\)/);
    expect(quals).toMatch(/readFailure\("staff detail: qualifications"/);
    expect(quals).toMatch(/readFailure\("briefing: staff qualifications"/);

    const perf = codeOf(src("server/services/staff-performance.ts"));
    expect(perf).toMatch(/\.eq\("org_id", orgId\)/);
    expect(perf).toMatch(/readFailure\(/);
    // never a silent catch-to-empty on the scorecard reads.
    expect(perf).not.toMatch(/catch\s*\{\s*return\s*\[\s*\]/);
  });

  it("the staff detail page reads both loudly (no false-empty scorecard)", () => {
    const page = codeOf(src("app/(app)/staff/[id]/page.tsx"));
    expect(page).toMatch(/listStaffQualifications\(ctx\.org\.id, id\)/);
    expect(page).toMatch(/getStaffPerformance\(ctx\.org\.id, id\)/);
  });
});

describe("GDPR registry — new table registered as non-secret", () => {
  const registry = JSON.parse(src("lib/gdpr/org-tables.json")) as {
    known: string[];
    excluded: Record<string, string>;
  };

  it("lists staff_qualifications in `known` and not in `excluded`", () => {
    expect(registry.known).toContain("staff_qualifications");
    expect(registry.excluded.staff_qualifications).toBeUndefined();
  });
});
