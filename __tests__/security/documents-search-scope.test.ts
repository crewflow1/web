import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * SECURITY — the Documents home + extended search reads are TENANT-SCOPED and
 * BOUNDED (never a full-table / cross-tenant scan).
 *
 * The global search route runs on the RLS-scoped tenant client, but RLS is the
 * OUTER boundary only: current_org_ids() admits EVERY org the viewer belongs to,
 * so each read MUST additionally pin the ACTIVE org (.eq("org_id", ctx.org.id))
 * and cap its rows. These assertions bite the source so a future edit that drops
 * an org pin or un-bounds a read fails CI. The portal attachment path is asserted
 * to gate on BOTH the explicit portal_visible flag AND customer ownership.
 */

const ROOT = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf-8");
/** Strip block+line comments so prose can't satisfy a code assertion. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("global search route — new entity reads are org-pinned + bounded", () => {
  const src = codeOf(read("app/api/search/route.ts"));
  const NEW_TABLES = ["job_documents", "snags", "purchase_orders", "site_reports"];

  it("caps every entity at the small PER_TYPE sample (well under the 1000 clamp)", () => {
    expect(src).toMatch(/const PER_TYPE = (\d+)/);
    const n = Number(/const PER_TYPE = (\d+)/.exec(src)![1]);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(1000);
  });

  for (const t of NEW_TABLES) {
    it(`${t}: pinned to the active org AND bounded to PER_TYPE in the same read`, () => {
      // .from("t") … .eq("org_id", ctx.org.id) … .limit(PER_TYPE), in order.
      const re = new RegExp(
        `\\.from\\("${t}"\\)[\\s\\S]{0,400}?\\.eq\\(\\s*"org_id",\\s*ctx\\.org\\.id\\s*\\)[\\s\\S]{0,240}?\\.limit\\(PER_TYPE\\)`,
      );
      expect(re.test(src)).toBe(true);
    });
  }

  it("never introduces an unbounded / boundary (.limit(1000)+) read", () => {
    expect(src).not.toMatch(/\.limit\(\s*1000\s*\)/);
    // No JS-side filtering of a capped page (the address-first anti-pattern).
    expect(src).not.toMatch(/rows\.filter\([^)]*includes/);
  });

  it("a failed new-entity read is LOUD (500), never a silent empty domain", () => {
    expect(src).toMatch(/wave3Error/);
    expect(src).toMatch(/query_failed/);
  });
});

describe("/documents home — org-pinned, paged, loud", () => {
  const src = codeOf(read("app/(app)/documents/page.tsx"));

  it("resolves the active org context before reading", () => {
    expect(src).toContain("requireOrgContext");
  });

  it("pins BOTH aggregated reads to the active org", () => {
    for (const t of ["job_documents", "tenant_attachments"]) {
      const re = new RegExp(
        `\\.from\\("${t}" as never\\)[\\s\\S]{0,600}?\\.eq\\("org_id", ctx\\.org\\.id\\)`,
      );
      expect(re.test(src)).toBe(true);
    }
  });

  it("pages the full set (fetchAllRows / range) rather than a truncating read", () => {
    expect(src).toContain("fetchAllRows");
    expect(src).toContain(".range(from, to)");
  });

  it("the HIGH-VALUE jobs name lookup is org-pinned + bounded (no bare scan)", () => {
    expect(src).toMatch(
      /\.from\("jobs"\)[\s\S]{0,300}?\.eq\("org_id", ctx\.org\.id\)[\s\S]{0,120}?\.limit\(JOB_IN_CHUNK\)/,
    );
    expect(src).toMatch(/const JOB_IN_CHUNK = (\d+)/);
    const n = Number(/const JOB_IN_CHUNK = (\d+)/.exec(src)![1]);
    expect(n).toBeLessThan(1000);
  });

  it("reads are LOUD (a failed read throws readFailure)", () => {
    expect(src).toContain("throw readFailure(");
  });
});

describe("portal attachments — gated on the flag AND customer ownership", () => {
  const helper = codeOf(read("app/customer-portal/_attachments.ts"));
  const route = codeOf(
    read("app/customer-portal/[token]/documents/attachments/[id]/route.ts"),
  );

  it("only ever admits explicitly portal-visible rows", () => {
    expect(helper).toMatch(/\.eq\("portal_visible", true\)/);
  });

  it("scopes attachments to the customer's OWN quotes/invoices/jobs", () => {
    // ownedIds filters by org_id AND customer_id.
    expect(helper).toMatch(/\.eq\("org_id", orgId\)/);
    expect(helper).toMatch(/\.eq\("customer_id", customerId\)/);
    expect(helper).toContain('["quotes", "invoices", "jobs"]');
  });

  it("re-verifies flag + ownership on the download route (defence in depth)", () => {
    expect(route).toContain("verifyPortalAttachment");
    // The route takes storage_path from the VERIFIED row, never the request.
    expect(route).toContain("verified.storage_path");
    // Fails closed to a 404 when verification returns null.
    expect(route).toMatch(/if \(!verified\)[\s\S]{0,80}?404/);
  });

  it("the download route resolves the customer through the single token authority", () => {
    expect(route).toContain("loadCustomerByPortalToken");
  });
});

describe("migration — additive, safe, default-off", () => {
  const sql = read(
    "supabase/migrations/20261152000000_documents_home_and_search.sql",
  );

  it("adds portal_visible defaulting FALSE (no behaviour change until flagged)", () => {
    expect(sql).toMatch(
      /add column if not exists portal_visible boolean not null default false/i,
    );
  });

  it("is non-destructive — no drop / delete / truncate / alter-drop", () => {
    expect(sql).not.toMatch(/drop\s+table/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/drop\s+index/i);
    expect(sql).not.toMatch(/alter\s+table[\s\S]*drop/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("every index is guarded (create … if not exists) — idempotent", () => {
    const creates = sql.match(/create index/gi) ?? [];
    const guarded = sql.match(/create index if not exists/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(creates.length);
  });
});
