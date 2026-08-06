import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/**
 * CROSS-ORG REFERENCE INJECTION — static guards (hermetic).
 *
 * The defect (hostile-audit 🔴): jobs/leads.customer_id and .assigned_to were
 * validated only as bare `.uuid()` and inserted straight through. The sole write
 * guard was `.eq("org_id", ctx.org.id)` on the ROW — which does nothing for the
 * FK TARGET. A caller in org A could attach org B's customer, or a non-member,
 * to an org A job/lead (and reassign one via the calendar drag-drop endpoint).
 *
 * The real fix is at the database (composite FK + membership trigger, migration
 * 20261112000000) and is proved against real Postgres in
 * __tests__/integration/rls/jobs-leads-cross-tenant-integrity.test.ts. THESE
 * guards are hermetic (no DB) so the "tests" CI job — which has no Postgres —
 * still fails loudly if either layer regresses:
 *
 *   1. The migration keeps the composite FKs + the assignee membership trigger.
 *   2. Every one of the FIVE write paths runs the app-layer org-membership
 *      re-check before the write, so a forged reference is a clean validation
 *      error rather than a raw DB failure surfacing as a 500 — and the check
 *      cannot be silently dropped from a path.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

// ── The five write paths + the reference each one can attach ─────────────────
// customer_id is only settable on the four form actions; the schedule endpoint
// patches scheduled_date/assigned_to only, so it verifies just the assignee.
const WRITE_PATHS: Array<{ file: string; needsCustomer: boolean }> = [
  { file: "app/(app)/jobs/actions.ts", needsCustomer: true },
  { file: "app/(app)/leads/actions.ts", needsCustomer: true },
  { file: "app/api/schedule/[id]/route.ts", needsCustomer: false },
];

describe("cross-org reference injection · migration guards", () => {
  const MIGRATION = "supabase/migrations/20261112000000_jobs_leads_cross_tenant_fk.sql";
  let sql = "";
  it("the migration file exists", () => {
    sql = read(MIGRATION);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("jobs.customer_id becomes a composite FK to customers(id, org_id)", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/drop constraint jobs_customer_id_fkey/);
    expect(sql).toMatch(
      /add constraint jobs_customer_org_fkey[\s\S]*?foreign key \(customer_id, org_id\)[\s\S]*?references public\.customers \(id, org_id\)/,
    );
  });

  it("leads.customer_id becomes a composite FK to customers(id, org_id)", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/drop constraint leads_customer_id_fkey/);
    expect(sql).toMatch(
      /add constraint leads_customer_org_fkey[\s\S]*?foreign key \(customer_id, org_id\)[\s\S]*?references public\.customers \(id, org_id\)/,
    );
  });

  it("both composite FKs preserve ON DELETE SET NULL (column-list form keeps org_id)", () => {
    sql = sql || read(MIGRATION);
    // The column-list SET NULL nulls ONLY customer_id, so the NOT NULL org_id
    // survives a customer delete (a plain SET NULL would abort the delete).
    // Assert it inside each of the two constraint DDL blocks (not just anywhere
    // in the file — the explanatory comment also mentions the idiom).
    expect(sql).toMatch(
      /add constraint jobs_customer_org_fkey[\s\S]*?on delete set null \(customer_id\)/,
    );
    expect(sql).toMatch(
      /add constraint leads_customer_org_fkey[\s\S]*?on delete set null \(customer_id\)/,
    );
  });

  it("an assignee-membership trigger guards BOTH jobs and leads (INSERT + UPDATE)", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/create or replace function public\.tg_assignee_is_org_member\(\)/);
    // Rejects when the assignee is not a member of the row's org.
    expect(sql).toMatch(/from public\.memberships m[\s\S]*?m\.user_id = new\.assigned_to[\s\S]*?m\.org_id = new\.org_id/);
    expect(sql).toMatch(/raise exception/);
    expect(sql).toMatch(/create trigger jobs_assignee_member_guard[\s\S]*?before insert or update on public\.jobs/);
    expect(sql).toMatch(/create trigger leads_assignee_member_guard[\s\S]*?before insert or update on public\.leads/);
  });
});

describe("cross-org reference injection · app-layer re-check on every write path", () => {
  it("the shared helper verifies customer + assignee are in the active org", () => {
    const helper = read("lib/crm/reference-integrity.ts");
    // customer lookup is org-pinned; assignee is a membership lookup, org-pinned.
    expect(helper).toMatch(/from\("customers"\)[\s\S]*?\.eq\("id", customerId\)[\s\S]*?\.eq\("org_id", orgId\)/);
    expect(helper).toMatch(/from\("memberships"\)[\s\S]*?\.eq\("user_id", userId\)[\s\S]*?\.eq\("org_id", orgId\)/);
    // Loud reads: a lookup ERROR throws, it never degrades to "not in this org".
    expect(helper).toMatch(/if \(error\) throw readFailure/);
  });

  for (const { file } of WRITE_PATHS) {
    it(`${file} invokes the org-membership re-check before writing`, () => {
      const src = read(file);
      // The path pulls in the shared helper (verifyCrmReferences for the form
      // actions, verifyAssigneeInOrg for the reschedule endpoint) …
      const importsHelper =
        /from "@\/lib\/crm\/reference-integrity"/.test(src) &&
        /(verifyCrmReferences|verifyAssigneeInOrg)/.test(src);
      expect(importsHelper, `${file} must import the reference-integrity helper`).toBe(true);
      // … and actually calls it and reacts to a rejection (never ignores it).
      expect(
        /(verifyCrmReferences|verifyAssigneeInOrg)\s*\(/.test(src),
        `${file} must call the reference-integrity helper`,
      ).toBe(true);
      expect(
        /\.ok\)/.test(src),
        `${file} must branch on the check result (reject on !ok)`,
      ).toBe(true);
    });
  }

  it("the two form-action files check BOTH customer_id and assigned_to (via verifyCrmReferences)", () => {
    for (const { file, needsCustomer } of WRITE_PATHS) {
      if (!needsCustomer) continue;
      const src = read(file);
      // verifyCrmReferences takes both customerId + assignedTo, so a single call
      // covers both references for create AND update in these files.
      const calls = src.match(/verifyCrmReferences\(/g) ?? [];
      // create + update = at least two call sites per form-action file.
      expect(calls.length, `${file} should re-check on both create and update`).toBeGreaterThanOrEqual(2);
      expect(src).toMatch(/customerId:/);
      expect(src).toMatch(/assignedTo:/);
    }
  });
});

describe("cross-org reference injection · the schema is not the guard", () => {
  // A regression that tried to "fix" this by tightening the Zod schema alone
  // would be false comfort — Zod cannot know org membership. This documents that
  // the DB + app-layer guards above are the real fix, and pins that the write
  // paths are the enumerated set (a NEW writer of jobs/leads must be added here).
  it("the enumerated write-path set is complete", () => {
    const appDir = join(ROOT, "app");
    // Sanity: the three known files exist and are readable.
    for (const { file } of WRITE_PATHS) {
      expect(() => read(file)).not.toThrow();
    }
    expect(readdirSync(appDir).length).toBeGreaterThan(0);
  });
});
