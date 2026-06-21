import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * CrewFlow HQ — Company Intelligence Database security invariants
 * (CEO Directive #003, Phase 1, Module 1 — the hq_sales_* family).
 *
 * This is the most sensitive data surface in HQ: prospect intelligence on real
 * UK construction companies — names, decision-maker contacts, phone numbers,
 * AI research, pipeline value. It is HQ-only (Super Admin allowlist) and must
 * NEVER be reachable by a customer/staff JWT.
 *
 * The event spine pins its trust boundary in FIVE event-spine-*-invariants
 * suites. Until now the larger, more sensitive Company Intelligence Database —
 * which predates the spine — had NO security-tier coverage at all. This suite
 * closes that gap. Like the spine suites it has no database in this tier (the
 * live RLS denial is proven in the integration tier), so it pins the contract
 * against SOURCE TEXT. These are the assertions that, if they ever silently
 * flipped, would be a hole:
 *   • a hq_sales_* table readable by a JWT client (RLS off, or a policy added);
 *   • a privilege-escalation surface (dynamic SQL, or a SECURITY DEFINER
 *     function without the empty-search_path hardening the spine uses);
 *   • the database coupled back into tenant RLS via a foreign key into a
 *     customer table (which would leak HQ rows on a tenant cascade, or worse);
 *   • an AI-authored row with no traceability (who/which model produced it);
 *   • a search vector that can drift from its source text;
 *   • the data-access service reading a tenant table, touching the spine truth
 *     log, or being importable into a client bundle;
 *   • the /admin/sales surface escaping the single HQ gate, or that gate
 *     announcing itself with a 403 instead of a 404.
 *
 * The migration checks run over `exec` (SQL with `--` comments stripped); the
 * TS checks run over `code` (TS with `//` and block comments stripped) — so the
 * prose that DOCUMENTS the contract can never satisfy a positive match or trip
 * a negative one (e.g. a header that NAMES a tenant table while describing the
 * decoupling rule).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- … EOL).
function execOf(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

// Strip TS block + line comments so a negative match can't be tripped by prose
// in a doc comment, while preserving the `://` of any URL.
function codeOf(ts: string): string {
  return ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// The four migrations that define the Company Intelligence Database family.
const MIGRATIONS = [
  "supabase/migrations/20260714000000_hq_sales_ai.sql",
  "supabase/migrations/20260714000001_hq_sales_ai_scale.sql",
  "supabase/migrations/20260716000000_hq_sales_calling.sql",
  "supabase/migrations/20260717000000_hq_sales_learning.sql",
] as const;

// Every table in the family — each must be RLS:hq (RLS on, ZERO policies).
const TABLES = [
  "hq_sales_sources",
  "hq_sales_companies",
  "hq_sales_contacts",
  "hq_sales_research_reports",
  "hq_sales_recommendations",
  "hq_sales_timeline_events",
  "hq_sales_channel_types",
  "hq_sales_task_types",
  "hq_sales_integrations",
  "hq_sales_locations",
  "hq_sales_channels",
  "hq_sales_ai_tasks",
  "hq_sales_external_records",
  "hq_sales_call_scripts",
  "hq_sales_objections",
  "hq_sales_calls",
  "hq_sales_learnings",
] as const;

// Tenant / customer-facing tables the HQ prospect database must stay decoupled
// from. A foreign key from a hq_sales_* table into any of these would re-couple
// HQ to tenant RLS (the very thing the schema header says it avoids).
const TENANT_TABLES = [
  "organizations",
  "organisations",
  "customers",
  "leads",
  "jobs",
  "quotes",
  "invoices",
] as const;

// Read + comment-strip every migration once, then join into a single haystack.
const execAll = MIGRATIONS.map((p) => execOf(read(p))).join("\n");

/** The column block of a CREATE TABLE (signature → its RLS enable line). */
function tableBlock(table: string): string {
  const start = execAll.indexOf(`create table if not exists public.${table}`);
  expect(start, `table ${table} not found`).toBeGreaterThanOrEqual(0);
  const rlsAt = execAll.indexOf(
    `alter table public.${table} enable row level security`,
    start,
  );
  expect(rlsAt, `RLS enable for ${table} not found`).toBeGreaterThan(start);
  return execAll.slice(start, rlsAt);
}

// =====================================================================
// 0. The migrations ship
// =====================================================================

describe("hq-sales — the Company Intelligence migrations are present", () => {
  for (const mig of MIGRATIONS) {
    it(`${mig} exists`, () => {
      expect(existsSync(resolve(ROOT, mig))).toBe(true);
    });
  }
});

// =====================================================================
// 1. RLS:hq — every table is RLS-on with ZERO policies (service_role only)
// =====================================================================

describe("hq-sales — every table is RLS:hq (service_role BYPASSRLS is the only reader)", () => {
  for (const table of TABLES) {
    it(`${table} is created AND has row level security enabled`, () => {
      expect(execAll).toMatch(
        new RegExp(`create table if not exists public\\.${table}\\b`, "i"),
      );
      expect(execAll).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security`, "i"),
      );
    });
  }

  it("declares NO policies anywhere in the family — no JWT (anon/authenticated) can read a row", () => {
    expect(execAll).not.toMatch(/create policy/i);
  });
});

// =====================================================================
// 2. No privilege-escalation surface — no dynamic SQL, no SECURITY DEFINER
// =====================================================================

describe("hq-sales — the family exposes no escalation surface", () => {
  it("uses NO dynamic SQL (no `execute format(` / `execute '`)", () => {
    expect(execAll).not.toMatch(/\bexecute\s+format\(/i);
    expect(execAll).not.toMatch(/\bexecute\s+'/i);
  });

  it("declares NO SECURITY DEFINER function — access is gated by RLS:hq + the service-role client, not a definer RPC", () => {
    // Unlike the spine (whose read RPCs are SECURITY DEFINER + empty
    // search_path), the prospect database is read straight through the
    // BYPASSRLS service_role. A definer function appearing here would be a new,
    // unhardened escalation path — pin it to zero.
    expect(execAll).not.toMatch(/security definer/i);
  });
});

// =====================================================================
// 3. Decoupled from tenant RLS — no foreign key into a customer table
// =====================================================================

describe("hq-sales — the prospect database is fully decoupled from tenant RLS", () => {
  for (const tenant of TENANT_TABLES) {
    it(`has NO foreign key into public.${tenant}`, () => {
      expect(execAll).not.toMatch(
        new RegExp(`references\\s+public\\.${tenant}\\b`, "i"),
      );
    });
  }
});

// =====================================================================
// 4. AI traceability — every AI-authored row records who/which model made it
// =====================================================================

describe("hq-sales — AI-authored artifacts are traceable", () => {
  it("the traceability triad (generated_by / model / ai_employee_id) exists in the family", () => {
    expect(execAll).toMatch(/\bgenerated_by\b/);
    expect(execAll).toMatch(/\bai_employee_id\b/);
    expect(execAll).toMatch(/\bmodel\b/);
  });

  it("research reports carry the full triad (the canonical AI artifact)", () => {
    const block = tableBlock("hq_sales_research_reports");
    expect(block).toMatch(/\bgenerated_by\b/);
    expect(block).toMatch(/\bmodel\b/);
    expect(block).toMatch(/\bai_employee_id\b/);
  });
});

// =====================================================================
// 5. Search integrity — the FTS vector is GENERATED (can never drift)
// =====================================================================

describe("hq-sales — search vectors are generated, not hand-maintained", () => {
  it("hq_sales_companies.search_tsv is a GENERATED, weighted tsvector", () => {
    expect(execAll).toMatch(/search_tsv\s+tsvector\s+generated always as/i);
    expect(execAll).toMatch(
      /setweight\(to_tsvector\('english', coalesce\(name, ''\)\), 'a'\)/i,
    );
  });
});

// =====================================================================
// 6. CQRS / service trust boundary — server-only, service-role, no tenant reads
// =====================================================================

describe("hq-sales — the data-access service obeys its trust boundary", () => {
  const SVC = "server/services/hq-sales.ts";
  const raw = read(SVC);
  const svc = codeOf(raw);

  it("is a server-only module (cannot be pulled into a client bundle)", () => {
    expect(raw).toMatch(/^import "server-only";/m);
  });

  it("reaches the database through the service-role admin client", () => {
    expect(svc).toMatch(/createAdminClient/);
  });

  it("NEVER reads a tenant table (the HQ prospect DB never touches customer CRM data)", () => {
    for (const tenant of TENANT_TABLES) {
      // Access patterns only: a PostgREST `.from("customers")` or the typed
      // shim `table<…>("customers")`. The bare word in another context is fine.
      expect(svc).not.toMatch(
        new RegExp(`(\\.from\\(|table<[^>]*>\\()\\s*["'\`]${tenant}\\b`, "i"),
      );
    }
  });

  it("NEVER touches the spine truth log (hq_events is the spine's; hq_sales_* has its own timeline)", () => {
    expect(svc).not.toMatch(/hq_events/);
  });
});

// =====================================================================
// 7. The single HQ gate guards the whole /admin/sales surface (404, not 403)
// =====================================================================

describe("hq-sales — the surface inherits the single HQ gate + its non-disclosure semantics", () => {
  it("the admin layout (parent of every /admin/sales route) gates on requireHqPage()", () => {
    // Every app/admin/sales/** page is a child of app/admin/layout.tsx, so the
    // layout's gate is the single chokepoint for the prospect database UI.
    expect(read("app/admin/layout.tsx")).toMatch(/await requireHqPage\(\)/);
  });

  const authCode = codeOf(read("server/auth/hq.ts"));

  it("reduces to the single isSuperAdminEmail allowlist predicate", () => {
    expect(authCode).toMatch(/isSuperAdminEmail/);
  });

  it("answers 404 for a non-allowlisted caller (notFound for pages, status 404 for the API)", () => {
    expect(authCode).toMatch(/notFound\(\)/);
    expect(authCode).toMatch(/status:\s*404/);
  });

  it("never answers 403 (which would announce the HQ surface's existence)", () => {
    expect(authCode).not.toMatch(/403/);
  });
});
