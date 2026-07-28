import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the jobs domain must pin by-id access to ctx.org.id.
 *
 * Why this tier and this style: these are Server Actions / RSC pages / route
 * handlers coupled to createClient + requireOrgContext + cookies(), and the
 * repo has no Supabase mock harness for them — so the invariants are pinned on
 * SOURCE, the documented convention already used by
 * __tests__/security/bank-match-invoice-org-scope.test.ts (see its header).
 * The runtime proof against a real multi-org user lives in the integration
 * tier: __tests__/integration/rls/active-org-scoping.test.ts.
 *
 * The invariant: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to, and `is_org_admin(org_id)` passes for every org they administer. Neither
 * constrains a query to the ACTIVE org (the `active_org_id` cookie). So a
 * by-id read or write in the jobs domain MUST carry its own org predicate, or
 * a user working in org A can read and mutate org B's rows.
 *
 * Every assertion here fails against the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract a single exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("lib/jobs/load — the shared scoped-read chokepoint", () => {
  const SRC = src("lib/jobs/load.ts");

  it("constrains the by-id load to the caller-supplied active org", () => {
    expect(SRC).toMatch(/\.eq\("id", jobId\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("returns null (not a throw) so callers can treat it as not-found", () => {
    expect(SRC).toMatch(/Promise<T \| null>/);
  });
});

describe("jobs detail pages — by-id reads are active-org scoped", () => {
  const pages: Array<[string, string]> = [
    ["app/(app)/jobs/[id]/page.tsx", "the job edit page named in the directive"],
    ["app/(app)/jobs/[id]/blueprints/page.tsx", "blueprints"],
    ["app/(app)/jobs/[id]/certificate/page.tsx", "completion certificate"],
    ["app/(app)/jobs/[id]/commercial/page.tsx", "commercial position"],
    ["app/(app)/jobs/[id]/variations/new/page.tsx", "new variation"],
  ];

  for (const [path, label] of pages) {
    it(`${label} loads the job through loadJobForOrg with ctx.org.id`, () => {
      const SRC = src(path);
      expect(SRC, `${path} should import the chokepoint`).toMatch(
        /import \{ loadJobForOrg \} from "@\/lib\/jobs\/load"/,
      );
      expect(SRC, `${path} should pass the active org`).toMatch(
        /loadJobForOrg[\s\S]{0,200}?ctx\.org\.id/,
      );
    });

    it(`${label} no longer performs a bare unscoped jobs read`, () => {
      const SRC = src(path);
      expect(SRC).not.toMatch(/from\("jobs"\)[\s\S]{0,200}?\.eq\("id", id\)\s*\.maybeSingle\(\)/);
    });

    it(`${label} still treats a missing/foreign job as notFound()`, () => {
      expect(src(path)).toMatch(/if \(!job\w*\) notFound\(\)/);
    });
  }
});

describe("jobs writes — mutations are pinned to the active org", () => {
  const ACTIONS = src("app/(app)/jobs/actions.ts");

  it("updateJob captures ctx and scopes the UPDATE by org_id", () => {
    const F = fn(ACTIONS, "updateJob");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("deleteJob captures ctx and scopes the DELETE by org_id", () => {
    const F = fn(ACTIONS, "deleteJob");
    expect(F).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/\.delete\(\{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the schedule PUT route scopes its jobs UPDATE by org_id", () => {
    const SRC = src("app/api/schedule/[id]/route.ts");
    expect(SRC).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(SRC).toMatch(/\.update\(patch, \{ count: "exact" \}\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });
});

describe("retention writes — must not land in another org's ledger", () => {
  const SRC = src("app/(app)/jobs/retention-actions.ts");

  it("setJobRetentionRate scopes the jobs UPDATE by org_id", () => {
    const F = fn(SRC, "setJobRetentionRate");
    expect(F).toMatch(/\.eq\("id", jobId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("setRetentionSchedule scopes the jobs UPDATE by org_id", () => {
    const F = fn(SRC, "setRetentionSchedule");
    expect(F).toMatch(/\.eq\("id", jobId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("recordRetentionRelease resolves the job in the ACTIVE org before inserting", () => {
    const F = fn(SRC, "recordRetentionRelease");
    expect(F).toMatch(/\.eq\("id", jobId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    // The release row must be stamped from ctx, not from the (previously
    // unscoped) job row's own org_id.
    expect(F).toMatch(/org_id: ctx\.org\.id/);
    expect(F).not.toMatch(/org_id: job\.org_id/);
  });

  it("scopes the job read BEFORE the retention_releases insert, not after", () => {
    const F = fn(SRC, "recordRetentionRelease");
    const scopeIdx = F.indexOf('.eq("org_id", ctx.org.id)');
    const insertIdx = F.indexOf('from("retention_releases"');
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeLessThan(insertIdx);
  });
});

describe("completion certificate — cannot bind another org's job", () => {
  const SRC = src("app/(app)/jobs/[id]/certificate/actions.ts");

  it("createCertificate resolves the job through the active-org chokepoint", () => {
    const F = fn(SRC, "createCertificate");
    expect(F).toMatch(/loadJobForOrg[\s\S]{0,200}?ctx\.org\.id/);
    expect(F).not.toMatch(/from\("jobs"\)[\s\S]{0,120}?\.eq\("id", jobId\)\s*\.maybeSingle\(\)/);
  });

  it("resolves the job before the certificate insert", () => {
    const F = fn(SRC, "createCertificate");
    const loadIdx = F.indexOf("loadJobForOrg");
    const insertIdx = F.indexOf(".insert({");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeLessThan(insertIdx);
  });

  it("issueCertificate freezes its snapshot from an active-org job", () => {
    const F = fn(SRC, "issueCertificate");
    expect(F).toMatch(/loadJobForOrg[\s\S]{0,300}?ctx\.org\.id/);
  });
});

describe("shared dropdown sources — no cross-org blending", () => {
  const SRC = src("app/(app)/jobs/_form-helpers.ts");

  it("listCustomersForOrg requires an org id and filters on it", () => {
    expect(SRC).toMatch(/listCustomersForOrg\(\s*orgId: string,?\s*\)/);
    expect(SRC).toMatch(/from\("customers"\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("listStaffForOrg requires an org id and filters on it", () => {
    expect(SRC).toMatch(/listStaffForOrg\(orgId: string\)/);
    expect(SRC).toMatch(/from\("memberships"\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("no caller invokes either helper without an argument", () => {
    // A zero-arg call would not type-check, but this pins it at the security
    // gate too: the helpers are consumed by 11 surfaces across 5 domains.
    const callers = [
      "app/(app)/jobs/[id]/page.tsx",
      "app/(app)/jobs/new/page.tsx",
      "app/(app)/jobs/calendar/page.tsx",
      "app/(app)/snags/page.tsx",
      "app/(app)/snags/new/page.tsx",
      "app/(app)/snags/[id]/page.tsx",
      "app/(app)/diary/[id]/page.tsx",
      "app/(app)/toolbox/[id]/page.tsx",
      "app/(app)/assets/[id]/page.tsx",
      "app/api/site-reports/[id]/pdf/route.ts",
    ];
    for (const c of callers) {
      const S = src(c);
      expect(S, `${c} calls listStaffForOrg()`).not.toMatch(/listStaffForOrg\(\)/);
      expect(S, `${c} calls listCustomersForOrg()`).not.toMatch(/listCustomersForOrg\(\)/);
    }
  });

  it("the site-report PDF pins the letterhead org instead of taking an arbitrary row", () => {
    const SRC2 = src("app/api/site-reports/[id]/pdf/route.ts");
    expect(SRC2).toMatch(/from\("organizations"\)[\s\S]*?\.eq\("id", ctx\.org\.id\)/);
  });
});
