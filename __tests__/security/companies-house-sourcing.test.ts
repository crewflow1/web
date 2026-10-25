import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Companies House BULK sourcing — trust-boundary + scope contracts.
 *
 * Pins the properties a later edit could silently drop: service-role-only pool
 * tables, dedupe/idempotency keys, pool-first KEYLESS sourcing, the 10/week
 * promotion cap, writes only through the sanctioned door, NO outreach, NO officer
 * enrichment, the REST path preserved-but-optional, and ONE canonical SIC list.
 * Hermetic source scan — no DB, no network.
 */
const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const sqlOnly = (s: string) =>
  s.split("\n").map((l) => { const i = l.indexOf("--"); return i === -1 ? l : l.slice(0, i); }).join("\n");
const codeOf = (ts: string) => ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIGRATION = "supabase/migrations/20261234000000_companies_house_sourcing_pool.sql";
const RUNNER = "server/services/hq-lead-sourcing-runner.ts";
const IMPORTER = "scripts/sourcing/companies-house-bulk-import.ts";
const SIC = "lib/sourcing/construction-sic.ts";

describe("migration — pool tables are service-role-only", () => {
  const sql = sqlOnly(read(MIGRATION));
  it("enables RLS on both tables", () => {
    expect(sql).toMatch(/alter table public\.hq_sales_sourcing_pool enable row level security/i);
    expect(sql).toMatch(/alter table public\.hq_sales_sourcing_imports enable row level security/i);
  });
  it("creates NO row-level policy (no client reachability)", () => {
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/to\s+(anon|authenticated)\b/i);
  });
  it("dedupe + idempotency keys exist", () => {
    expect(sql).toMatch(/company_number\s+text\s+not null\s+unique/i);
    expect(sql).toMatch(/snapshot_date\s+date\s+not null\s+unique/i);
  });
  it("promotion links back to hq_sales_companies", () => {
    expect(sql).toMatch(/promoted_company_id\s+uuid\s+references public\.hq_sales_companies\(id\)/i);
  });
});

describe("runner — pool-first, keyless, capped, sanctioned-door-only", () => {
  const src = read(RUNNER);
  const code = codeOf(src);
  it("reads the bulk pool BEFORE the API-key gate (keyless default)", () => {
    const poolAt = code.indexOf("readEligiblePool(");
    const keyAt = code.indexOf("process.env.COMPANIES_HOUSE_API_KEY");
    expect(poolAt).toBeGreaterThan(-1);
    expect(keyAt).toBeGreaterThan(-1);
    expect(poolAt).toBeLessThan(keyAt);
  });
  it("API-key absence does NOT force dark when a pool exists (dark only if neither)", () => {
    // The dark reason names the pool-absence condition — proof the key is not the sole gate.
    expect(src).toMatch(/no bulk pool available and companies-house key not configured/i);
  });
  it("promotes only through the sanctioned createCompany door (no raw prospect insert)", () => {
    expect(code).toMatch(/createCompany\(poolRowToCompanyInput/);
    // no direct insert into the prospect table from the runner
    expect(code).not.toMatch(/from\(\s*["']hq_sales_companies["']\s*\)[\s\S]{0,40}\.insert\(/);
  });
  it("enforces the weekly promotion cap", () => {
    expect(code).toMatch(/SOURCING_BATCH_LIMIT\s*=\s*10/);
    expect(code).toMatch(/result\.sourced\s*>=\s*SOURCING_BATCH_LIMIT/);
  });
  it("lands prospects at status 'new' — never advances/contacts (no outreach)", () => {
    expect(code).toMatch(/status:\s*"new"/);
    expect(code).not.toMatch(/outreach|send_email|sendEmail|contacted|officer/i);
  });
  it("keeps the REST advanced-search path (optional enrichment, not removed)", () => {
    expect(code).toMatch(/searchConstructionCompanies\(apiKey\)/);
  });
  it("uses the ONE canonical SIC list (no inline second allowlist)", () => {
    expect(code).toMatch(/import\s*\{\s*CONSTRUCTION_SIC_CODES\s*\}\s*from\s*"@\/lib\/sourcing\/construction-sic"/);
    // the old inline array literal must be gone
    expect(code).not.toMatch(/CONSTRUCTION_SIC_CODES:\s*readonly string\[\]\s*=\s*\[/);
  });
});

describe("importer — writes only pool tables, no outreach/officer, dry-run + idempotent, no secret logging", () => {
  const src = read(IMPORTER);
  const code = codeOf(src);
  it("writes ONLY the two service-role pool tables", () => {
    const tables = [...code.matchAll(/\.from\(\s*["']([a-z_]+)["']\s*\)/g)].map((m) => m[1]);
    const unique = [...new Set(tables)];
    expect(unique.sort()).toEqual(["hq_sales_sourcing_imports", "hq_sales_sourcing_pool"]);
  });
  it("never creates prospects or does outreach/officer enrichment", () => {
    expect(code).not.toMatch(/createCompany\(/);
    expect(code).not.toMatch(/outreach|officer|appointments|send/i);
  });
  it("supports --dry-run (no DB writes) and snapshot idempotency", () => {
    expect(code).toMatch(/--dry-run|dryRun/);
    expect(code).toMatch(/status['"]?\)\s*===\s*["']success["']|status: string \}\)\.status === "success"/);
    expect(src).toMatch(/already imported — skipping/i);
  });
  it("streams (unzip -p + readline) — never buffers the whole CSV", () => {
    expect(code).toMatch(/spawn\(\s*["']unzip["']\s*,\s*\[\s*["']-p["']/);
    expect(code).toMatch(/createInterface\(/);
  });
  it("never logs the service-role key", () => {
    expect(code).not.toMatch(/console\.log[\s\S]{0,80}SUPABASE_SERVICE_ROLE_KEY/);
    expect(code).not.toMatch(/log\([^)]*process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("canonical SIC source", () => {
  it("is defined once in the shared module and is not server-only", () => {
    const sic = read(SIC);
    expect(sic).toMatch(/export const CONSTRUCTION_SIC_CODES/);
    expect(sic).not.toMatch(/import ["']server-only["']/);
  });
});
