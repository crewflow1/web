import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Hotfix pin — Migration OS upload no longer crashes on the
 * job/quote/payment entity types that PR #90 introduced.
 *
 * Two invariants:
 *   1. The widening migration exists and lists every type the
 *      TypeScript registry (lib/imports/detect.ts) accepts.
 *   2. The bulk row insert in app/(app)/imports/actions.ts has a
 *      per-row fallback that NEVER redirects out — matching the
 *      CEO directive's "AI flags issues but does not stop migration"
 *      rule.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = read(
  "supabase/migrations/20260617000000_widen_import_rows_entity_check.sql",
);
const ACTIONS = read("app/(app)/imports/actions.ts");
const DETECT = read("lib/imports/detect.ts");

describe("Migration OS hotfix — widened entity_type CHECK", () => {
  it("migration exists and is idempotent", () => {
    expect(MIGRATION).toMatch(/drop constraint if exists import_rows_entity_type_check/);
    expect(MIGRATION).toMatch(/add constraint import_rows_entity_type_check/);
  });

  it("CHECK includes every TypeScript EntityType the app can produce", () => {
    // Walk the EntityType union in detect.ts and assert each appears
    // in the CHECK list.
    const unionBlock =
      DETECT.match(/export type EntityType =[^;]+;/)?.[0] ?? "";
    const types = Array.from(unionBlock.matchAll(/"([a-z_]+)"/g)).map(
      (m) => m[1],
    );
    expect(types.length).toBeGreaterThanOrEqual(9);
    for (const t of types) {
      expect(MIGRATION).toMatch(new RegExp(`'${t}'`));
    }
    // 'unknown' is also written by the app at detect.ts in the
    // detection fallback path — pin it explicitly.
    expect(MIGRATION).toMatch(/'unknown'/);
  });
});

describe("Migration OS hardening — upload never aborts on row insert", () => {
  it("bulk insert has a per-row fallback (no hard redirect on rowErr)", () => {
    // The previous pattern was: if (rowErr) redirect(...row_insert_failed)
    // The hotfix replaces that with a per-row retry loop. Pin both
    // shapes for clarity.
    expect(ACTIONS).toMatch(/falling back to per-row/);
    expect(ACTIONS).toMatch(
      /for \(const single of slice\)[\s\S]*\.insert\(single\)/,
    );
  });

  it("per-row failures are surfaced as status='error' rows, not silent gaps", () => {
    expect(ACTIONS).toMatch(/status: "error"/);
    expect(ACTIONS).toMatch(/db rejected row/);
  });

  it("the old redirect-on-bulk-error path is gone", () => {
    // Catching this regression — a future refactor that re-introduces
    // the bail-out would silently undo the directive's partial-success
    // promise.
    expect(ACTIONS).not.toMatch(/redirect\(`\/imports\/\$\{importId\}\?error=row_insert_failed`\)/);
  });
});
