import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * TENANT ISOLATION — the estimating price-book / rate-library + saved quote
 * templates (P3 wave).
 *
 * Three new org-scoped tables carry money and reference data:
 *   price_book_items, quote_templates, quote_template_lines.
 *
 * RLS's current_org_ids() returns EVERY org the viewer belongs to — the OUTER
 * boundary, not the scope. So a member of org A working in org A must never be
 * able to read/write/attach an org B row. This suite pins that on THREE layers:
 *
 *   1. the MIGRATION — RLS enabled, org-pinned policies, and a CROSS-TENANT-SAFE
 *      composite FK so a template line can't attach to another org's template;
 *   2. the READS (lib/pricing/queries.ts) — every read carries its own
 *      .eq("org_id", …), pages (F-1) and fails LOUD;
 *   3. the WRITES (app/(app)/pricing/actions.ts) — every write is active-org
 *      pinned and the hard delete is admin-gated.
 *
 * Plus the F-1 registration: the three tables are enrolled in the repo-wide
 * bare-select guard so a future clamped read fails CI.
 *
 * Style: SOURCE inspection — the documented convention for RSC/action code that
 * has no Supabase mock harness (see active-org-scoping.test.ts). Every assertion
 * fails against a pre-fix (missing) source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const MIGRATION = "supabase/migrations/20261131000000_price_book_and_quote_templates.sql";
const QUERIES = "lib/pricing/queries.ts";
const ACTIONS = "app/(app)/pricing/actions.ts";

const NEW_TABLES = ["price_book_items", "quote_templates", "quote_template_lines"];

// ─────────────────────────────────────────────────────────────────────────────
describe("migration — RLS + org-pinned policies on every new table", () => {
  const sql = src(MIGRATION).toLowerCase();

  for (const t of NEW_TABLES) {
    it(`${t}: row level security is ENABLED`, () => {
      expect(sql).toContain(`alter table public.${t} enable row level security`);
    });

    it(`${t}: has an org_id not null FK to organizations`, () => {
      expect(sql).toMatch(
        new RegExp(`create table if not exists public\\.${t}[\\s\\S]*?org_id\\s+uuid not null references public\\.organizations`),
      );
    });

    it(`${t}: SELECT policy is scoped to current_org_ids() (no open read)`, () => {
      expect(sql).toMatch(
        new RegExp(`policy[^\\n]*${t}[^\\n]*select[\\s\\S]*?org_id in \\(select public\\.current_org_ids\\(\\)\\)`, "i"),
      );
    });

    it(`${t}: INSERT policy checks current_org_ids() (can't write into another org)`, () => {
      expect(sql).toMatch(
        new RegExp(`for insert[\\s\\S]{0,200}?with check \\(org_id in \\(select public\\.current_org_ids\\(\\)\\)\\)`, "i"),
      );
    });
  }

  it("price_book_items: hard DELETE is ADMIN-only (everyday retire is active=false)", () => {
    expect(sql).toMatch(
      /"price_book_items: admins can delete"[\s\S]*?for delete[\s\S]*?is_org_admin\(org_id\)/i,
    );
  });

  it("quote_template_lines: composite FK binds (template_id, org_id) → templates(id, org_id)", () => {
    // A forged template_id from another org is refused at the DB, not just RLS.
    expect(sql).toMatch(
      /foreign key \(template_id, org_id\)\s*references public\.quote_templates \(id, org_id\) on delete cascade/,
    );
    expect(sql).toContain("constraint quote_templates_id_org_key unique (id, org_id)");
  });

  it("money columns are INTEGER PENCE, non-negative", () => {
    expect(sql).toMatch(/unit_price\s+integer not null default 0 check \(unit_price >= 0\)/);
    // …present on BOTH money-bearing tables.
    const count = (sql.match(/unit_price\s+integer not null default 0 check \(unit_price >= 0\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("vat_rate is constrained to the closed 0/5/20 set on money tables", () => {
    const count = (sql.match(/vat_rate\s+integer not null default 20 check \(vat_rate in \(0, 5, 20\)\)/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("reads (lib/pricing/queries.ts) — org-pinned, paged, loud", () => {
  const code = codeOf(src(QUERIES));

  it("every read pins .eq(\"org_id\", orgId) — RLS is the backstop, not the scope", () => {
    const pins = code.match(/\.eq\(\s*["']org_id["']\s*,\s*orgId\s*\)/g) ?? [];
    // price_book_items list, by-id, quote_templates, quote_template_lines = ≥4.
    expect(pins.length).toBeGreaterThanOrEqual(4);
  });

  it("the by-id item read carries its OWN org predicate", () => {
    expect(code).toMatch(/\.eq\("id", id\)[\s\S]{0,80}?\.eq\("org_id", orgId\)/);
  });

  it("list reads page via fetchAllRows (.range) — no silent 1000-row clamp", () => {
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/paginate["']/);
    expect(code).toMatch(/fetchAllRows</);
    expect(code).toMatch(/\.range\(from, to\)/);
  });

  it("every paged read has a unique id tiebreak so pages can't drop/repeat", () => {
    expect(code).toMatch(/\.order\("id", \{ ascending: true \}\)/);
  });

  it("reads are LOUD — a failed read throws readFailure, never a silent partial", () => {
    expect(code).toMatch(/from\s+["']@\/lib\/supabase\/read-failure["']/);
    expect((code.match(/throw readFailure\(/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("this file is server-only (never bundled to the client)", () => {
    expect(code).toMatch(/import ["']server-only["']/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("writes (app/(app)/pricing/actions.ts) — active-org pinned + gated", () => {
  const code = codeOf(src(ACTIONS));

  it("is a server module gated by requireOrgContext()", () => {
    expect(code).toMatch(/^"use server";/);
    expect(code).toMatch(/requireOrgContext\(\)/);
  });

  it("every write pins the ACTIVE org (.eq(\"org_id\", ctx.org.id)), not 'any org I belong to'", () => {
    const pins = code.match(/\.eq\("org_id",\s*ctx\.org\.id\)/g) ?? [];
    // update/archive/delete item + rename/delete template + the quote-line read.
    expect(pins.length).toBeGreaterThanOrEqual(6);
  });

  it("inserts stamp org_id from ctx (never a client-supplied org)", () => {
    expect(code).toMatch(/org_id:\s*ctx\.org\.id/);
    expect(code).not.toMatch(/org_id:\s*formData/);
  });

  it("money is written as INTEGER PENCE via poundsToPence", () => {
    expect(code).toMatch(/from\s+["']@\/lib\/money["']/);
    expect(code).toMatch(/unit_price:\s*poundsToPence\(/);
  });

  it("hard DELETE of a price-book item is admin-gated in the app layer too", () => {
    expect(code).toMatch(
      /deletePriceBookItem[\s\S]*?role !== "owner" && ctx\.membership\.role !== "admin"[\s\S]*?return formError/,
    );
  });

  it("the source-quote line read is org-pinned AND paged (F-1)", () => {
    expect(code).toMatch(
      /\.eq\("quote_id", quoteId\)[\s\S]{0,120}?\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(code).toMatch(/fetchAllRows</);
  });

  it("raw Postgres text never reaches the user — failures return generic sentences", () => {
    expect(code).not.toMatch(/formError\([^)]*error\.message/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("F-1 registration — the new tables are enrolled in the bare-select guard", () => {
  const guard = src("__tests__/security/f1-bare-select-guard.test.ts");
  for (const t of NEW_TABLES) {
    it(`${t} is listed in HIGH_VALUE_TABLES`, () => {
      expect(guard).toContain(`"${t}",`);
    });
  }
});
