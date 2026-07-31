import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PERCENT-COMPLETE IS NOT A VALUATION, AND MUST NEVER BECOME A BILLING TRIGGER.
 *
 * CrewFlow already has ONE staged-billing authority: `job_billing_plans` +
 * `job_billing_stages` + `generate_stage_invoice` (20261039), deliberately
 * date/milestone driven with an explicit human act per stage. If a progress
 * figure typed into a phone on site could raise an invoice, move cash or post
 * to `finances`, the product would have grown a SECOND, rival billing path with
 * far weaker controls — and "we're 60% done" would silently become "£60k is
 * due". Application-for-payment valuation is real UK construction work, but it
 * is adversarial (assessed, certified, disputed) and belongs to the commercial
 * lane, never to a site update.
 *
 * These are STRUCTURAL assertions over the shipped source, not a code review
 * note: the progress lane is proven to have no edge to money at all.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "20261078000000_job_progress_observations.sql";

/** Every file the progress feature owns. */
const PROGRESS_SOURCES = [
  "lib/job-progress/series.ts",
  "lib/job-progress/portal.ts",
  "server/services/job-progress.ts",
  "app/(app)/jobs/[id]/progress-actions.ts",
  "app/(app)/jobs/[id]/_job-progress.tsx",
];

/** Tables and functions that move, hold or represent money. */
const MONEY_TABLES = [
  "finances",
  "invoices",
  "invoice_payments",
  "invoice_line_items",
  "payments",
  "job_billing_plans",
  "job_billing_stages",
  "retention_releases",
  "supplier_bills",
  "supplier_payments",
  "expenses",
];
const MONEY_FUNCTIONS = [
  "generate_stage_invoice",
  "allocate_payment",
  "next_invoice_number",
];

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

/** Source with comments removed — so prose ABOUT billing never trips a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block */
    .replace(/^\s*--.*$/gm, " ") // -- sql line
    .replace(/^\s*\/\/.*$/gm, " "); // // ts line
}

describe("job progress · no finances postings, no link to payment", () => {
  const migrationSrc = read(`supabase/migrations/${MIGRATION}`);
  const migrationCode = stripComments(migrationSrc);

  it("the migration exists and creates the progress table", () => {
    const files = readdirSync(resolve(ROOT, "supabase", "migrations"));
    expect(files).toContain(MIGRATION);
    expect(migrationCode).toMatch(
      /create table if not exists public\.job_progress_observations/,
    );
  });

  it("the migration references NO money table or money function", () => {
    for (const table of MONEY_TABLES) {
      expect(
        migrationCode,
        `20261078 must not touch public.${table} — progress is not a valuation`,
      ).not.toMatch(new RegExp(`\\bpublic\\.${table}\\b`));
    }
    for (const fn of MONEY_FUNCTIONS) {
      expect(migrationCode, `20261078 must not call ${fn}`).not.toContain(fn);
    }
  });

  it("the progress table carries NO money column", () => {
    // Extract the CREATE TABLE body and prove no monetary column exists. A
    // numeric(12,2) is the house money type; an `amount`/`value`/`price` column
    // is how a valuation would first appear.
    const body = migrationCode.match(
      /create table if not exists public\.job_progress_observations\s*\(([\s\S]*?)\n\);/,
    )?.[1];
    expect(body, "could not locate the CREATE TABLE body").toBeTruthy();
    expect(body!).not.toMatch(/numeric\s*\(\s*12\s*,\s*2\s*\)/);
    expect(body!).not.toMatch(/\b(amount|net_amount|gross|total|price|value|cost|vat|currency)\b/i);
    // The one numeric fact it holds is a bounded percentage.
    expect(body!).toMatch(/percent\s+integer not null check \(percent >= 0 and percent <= 100\)/);
  });

  it("the migration installs no trigger that could post on a progress write", () => {
    // Exactly one trigger function is defined, and it is the date/authorship
    // guard. Nothing AFTER INSERT exists to fan out into another table.
    const triggerFns = [
      ...migrationCode.matchAll(/create or replace function public\.(\w+)/g),
    ].map((m) => m[1]);
    expect(triggerFns).toEqual(["tg_job_progress_observation_guard"]);

    const guard = migrationCode.match(
      /create or replace function public\.tg_job_progress_observation_guard[\s\S]*?\$\$;/,
    )?.[0];
    expect(guard).toBeTruthy();
    expect(guard!.toLowerCase()).not.toMatch(/\binsert\s+into\b/);
    expect(guard!.toLowerCase()).not.toMatch(/\bupdate\s+public\./);
    expect(guard!.toLowerCase()).not.toMatch(/\bperform\b/);
  });

  it("the migration adds no RESTRICT anywhere (the 20261052 teardown lesson)", () => {
    expect(migrationCode.toLowerCase()).not.toContain("on delete restrict");
    expect(migrationCode.toLowerCase()).not.toContain("on delete no action");
  });

  it("no progress source file imports a money module", () => {
    const banned =
      /from\s+["']@\/lib\/(finances|commercial|invoices|billing|payments|money|profitability|purchase-orders|payroll)/;
    for (const rel of PROGRESS_SOURCES) {
      const code = stripComments(read(rel));
      expect(code, `${rel} must not import a money module`).not.toMatch(banned);
      expect(code, `${rel} must not import the stage-invoice authority`).not.toContain(
        "generate_stage_invoice",
      );
    }
  });

  it("no progress source file reads or writes a money table", () => {
    for (const rel of PROGRESS_SOURCES) {
      const code = stripComments(read(rel));
      for (const table of MONEY_TABLES) {
        // `.from("finances")` / `.from('invoices')` — the only way the app
        // layer reaches a table through PostgREST.
        expect(
          code,
          `${rel} must not query ${table}`,
        ).not.toMatch(new RegExp(`from\\(\\s*["']${table}["']`));
      }
    }
  });

  it("the customer-safe DTO exposes no money field", () => {
    const portal = stripComments(read("lib/job-progress/portal.ts"));
    expect(portal).not.toMatch(/\b(amount|gross|net|price|due|invoice|payment)\b/i);
  });

  it("the recording action writes ONLY to the progress table", () => {
    const action = stripComments(read("app/(app)/jobs/[id]/progress-actions.ts"));
    const written = [...action.matchAll(/\.from\(\s*["']([\w-]+)["']/g)].map((m) => m[1]);
    // It reads `jobs` for the active-org check and writes the observation. If a
    // third table ever appears here, this test is the place that argues about it.
    expect([...new Set(written)].sort()).toEqual([
      "job_progress_observations",
      "jobs",
    ]);
  });
});
