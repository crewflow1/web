/**
 * Canonical UK SIC 2007 Section F — Construction (divisions 41–43) allowlist.
 *
 * This is the SINGLE source of truth for "which companies count as
 * construction/trades" across CrewFlow's HQ lead-sourcing lanes:
 *   • the live Companies House Advanced-Search REST path
 *     (server/services/hq-lead-sourcing-runner.ts), and
 *   • the free monthly Companies House BULK dataset pipeline
 *     (scripts/sourcing/companies-house-bulk-import.ts via
 *      lib/sourcing/companies-house-bulk.ts).
 *
 * It is deliberately NOT `server-only`: the bulk importer runs in a plain
 * Node/GitHub-Actions process (outside the Next server), and both paths must
 * use the IDENTICAL list — a divergent second allowlist would silently source
 * different companies from each lane.
 *
 * A documented public standard, not invented org config: the machine-readable
 * form of the "construction sector" the qualification rubric's `sectorOf`
 * classifies on (lib/qualification/criteria.ts).
 */
export const CONSTRUCTION_SIC_CODES: readonly string[] = [
  // 41 — construction of buildings
  "41100", "41201", "41202",
  // 42 — civil engineering
  "42110", "42120", "42130", "42210", "42220", "42910", "42990",
  // 43 — specialised construction activities
  "43110", "43120", "43130", "43210", "43220", "43290",
  "43310", "43320", "43330", "43341", "43342", "43390",
  "43910", "43991", "43999",
];

/** O(1) membership set for the allowlist — used by the bulk filter hot path. */
export const CONSTRUCTION_SIC_SET: ReadonlySet<string> = new Set(CONSTRUCTION_SIC_CODES);
