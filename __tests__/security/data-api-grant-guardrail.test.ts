import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Supabase Data API grant guardrail (effective 2026-10-30).
 *
 * From 2026-10-30 Supabase stops auto-granting the Data/GraphQL API roles
 * (anon / authenticated) SELECT/INSERT/UPDATE/DELETE on NEW public tables. A
 * table created by a migration applied after that date is INVISIBLE to the
 * Data API (PostgREST 42501 "permission denied") until a GRANT is added — and
 * CrewFlow reaches its data through the Data API, so a client-facing table
 * created without a grant silently breaks the feature that uses it.
 *
 * EXISTING tables are unaffected (Supabase retains their current grants), so we
 * do NOT rewrite the 390 historical migrations. Instead this guardrail forces a
 * CONSCIOUS decision on every FUTURE table: either
 *   (a) GRANT the Data API role(s) explicitly in the same migration, or
 *   (b) mark it service-role-only with a `data-api-exempt: <table>` comment
 *       (e.g. an RLS-locked internal/ops table nothing reads over the Data API).
 *
 * Hermetic: a pure SQL scan of the migrations directory. No DB, no network.
 * Earlier migrations are grandfathered by number; see GRANDFATHER_TIP.
 */

const ROOT = resolve(__dirname, "..", "..");
const MIG_DIR = resolve(ROOT, "supabase/migrations");

// The migration tip at the moment the Oct-30 default took effect. Migrations at
// or below this are grandfathered (their grants were applied under the old
// auto-grant default and Supabase keeps them). Only migrations ABOVE it — the
// ones authored from now on — are policed.
const GRANDFATHER_TIP = "20261230000000";

const migrationNumber = (name: string): string => name.match(/^(\d+)/)?.[1] ?? "0";

/** Strip SQL line comments so table/grant detection reads executable statements. */
const sqlOnly = (src: string): string =>
  src
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");

const createdTables = (execSql: string): string[] => {
  const re =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["`]?([a-z0-9_]+)["`]?/gi;
  const out = new Set<string>();
  for (const m of execSql.matchAll(re)) out.add(m[1].toLowerCase());
  return [...out];
};

/** Tables made reachable to a Data API role in this migration (+ a blanket flag). */
const grantAnalysis = (execSql: string): { all: boolean; tables: Set<string> } => {
  const tables = new Set<string>();
  let all = false;
  for (const stmt of execSql.split(";")) {
    if (!/\bgrant\b/i.test(stmt)) continue;
    if (!/\bto\b[\s\S]*\b(authenticated|anon)\b/i.test(stmt)) continue; // only Data API roles count
    if (/on\s+all\s+tables\s+in\s+schema\s+public/i.test(stmt)) {
      all = true;
      continue;
    }
    const onObj = stmt.match(/on\s+(?:table\s+)?(?:public\.)?["`]?([a-z0-9_]+)["`]?/i);
    if (onObj) tables.add(onObj[1].toLowerCase());
  }
  return { all, tables };
};

/** Tables the author explicitly marked service-role-only (no Data API grant). */
const exemptTables = (rawSql: string): Set<string> => {
  const out = new Set<string>();
  for (const m of rawSql.matchAll(/data-api-exempt:\s*([a-z0-9_]+)/gi)) out.add(m[1].toLowerCase());
  return out;
};

/** The guardrail: returns the tables in `rawSql` that lack a grant AND an exemption. */
export function auditMigration(rawSql: string): string[] {
  const exec = sqlOnly(rawSql);
  const created = createdTables(exec);
  if (created.length === 0) return [];
  const { all, tables: granted } = grantAnalysis(exec);
  if (all) return [];
  const exempt = exemptTables(rawSql);
  return created.filter((t) => !granted.has(t) && !exempt.has(t));
}

// ---------------------------------------------------------------------------
// 1. THE GUARDRAIL ITSELF WORKS (prove it catches a violation)
// ---------------------------------------------------------------------------
describe("auditMigration detects ungranted future tables", () => {
  it("FLAGS a new client-facing table with no grant", () => {
    expect(auditMigration("create table public.widgets (id uuid primary key);")).toEqual([
      "widgets",
    ]);
  });
  it("passes a table with an explicit Data API grant", () => {
    const sql = `create table public.widgets (id uuid primary key);
      grant select, insert, update, delete on public.widgets to authenticated;`;
    expect(auditMigration(sql)).toEqual([]);
  });
  it("passes a service-role-only table marked data-api-exempt", () => {
    const sql = `-- data-api-exempt: ops_widgets (RLS-locked, service-role only)
      create table public.ops_widgets (id uuid primary key);
      alter table public.ops_widgets enable row level security;`;
    expect(auditMigration(sql)).toEqual([]);
  });
  it("passes under a blanket grant on all tables in schema public", () => {
    const sql = `create table public.widgets (id uuid primary key);
      grant select on all tables in schema public to authenticated;`;
    expect(auditMigration(sql)).toEqual([]);
  });
  it("does NOT count a grant to service_role alone as Data API access", () => {
    const sql = `create table public.widgets (id uuid primary key);
      grant all on public.widgets to service_role;`;
    expect(auditMigration(sql)).toEqual(["widgets"]);
  });
  it("flags the ungranted one when a migration adds two tables, one granted", () => {
    const sql = `create table public.a (id uuid primary key);
      create table public.b (id uuid primary key);
      grant select on public.a to authenticated;`;
    expect(auditMigration(sql)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// 2. EVERY FUTURE MIGRATION COMPLIES (the durable protection)
// ---------------------------------------------------------------------------
describe("future migrations declare Data API intent for every new table", () => {
  const future = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => migrationNumber(f) > GRANDFATHER_TIP);

  it("has a grandfather tip at or below the current migration tip", () => {
    const all = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map(migrationNumber)
      .sort();
    expect(all[all.length - 1] >= GRANDFATHER_TIP).toBe(true);
  });

  for (const file of future) {
    it(`${file}: every new public table is granted or data-api-exempt`, () => {
      const offenders = auditMigration(readFileSync(resolve(MIG_DIR, file), "utf8"));
      expect(
        offenders,
        `${file} creates public table(s) [${offenders.join(", ")}] with no Data API GRANT ` +
          `and no "data-api-exempt: <table>" marker. After 2026-10-30 Supabase will not ` +
          `auto-grant them, so the Data API returns 42501. Add an explicit GRANT to the ` +
          `needed role(s), or mark the table service-role-only.`,
      ).toEqual([]);
    });
  }
});
