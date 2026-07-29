import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ATTACHMENT_TARGET_TABLES } from "@/server/services/tenant-attachments";

/**
 * The TS attachment-target list and the DB CHECK must be the SAME set.
 *
 * The CHECK on tenant_attachments.target_table is widened by the
 * introspect-drop-readd idiom, so the authoritative value set is whatever the
 * LAST migration (by filename order — how they replay) re-added. The upload
 * action's Zod enum is built from ATTACHMENT_TARGET_TABLES, so a target the
 * database accepts but the list omits is unreachable from the app — exactly
 * how asset_maintenance_cases (20261002) and asset_fuel_logs (20261058) sat
 * DB-enabled but app-dead until 2026-07-29. This test makes that drift a red
 * build in whichever PR introduces it: widen the CHECK and the list together.
 */
describe("tenant_attachments target list ↔ DB CHECK drift", () => {
  it("ATTACHMENT_TARGET_TABLES equals the value set of the latest CHECK re-add", () => {
    const dir = resolve(__dirname, "..", "..", "supabase", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

    let latest: { file: string; values: string[] } | null = null;
    for (const f of files) {
      const src = readFileSync(resolve(dir, f), "utf8");
      // Match every target_table CHECK body in this file; keep the last one.
      const matches = src.match(/target_table\s+in\s*\(([^)]+)\)/gi);
      if (!matches) continue;
      const body = matches[matches.length - 1]!;
      const values = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
      if (values.length > 0) latest = { file: f, values };
    }

    expect(latest, "no target_table CHECK found — parser drifted from the migrations").not.toBeNull();
    // Guard the parser itself: the set can only grow, and it started at 5.
    expect(latest!.values.length).toBeGreaterThanOrEqual(15);

    const dbSet = [...new Set(latest!.values)].sort();
    const tsSet = [...ATTACHMENT_TARGET_TABLES].sort();
    expect(
      tsSet,
      `TS list must equal the CHECK re-added by ${latest!.file} — widen BOTH in the same PR`,
    ).toEqual(dbSet);
  });
});
