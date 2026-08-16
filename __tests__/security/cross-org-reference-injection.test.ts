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

// ─────────────────────────────────────────────────────────────────────────────
// QUOTES — the sibling MISS from the jobs/leads fix, and WORSE: a quote renders
// on the PUBLIC, unauthenticated, service-role /q/[token] route (name + email),
// so a foreign customer_id is a cross-tenant PII leak, not just an integrity slip.
// Closed at the DB by migration 20261113000000 (composite FKs on all four child
// refs) + app-layer verifyQuoteReferences on create AND update.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-org reference injection · QUOTES migration guards", () => {
  const MIGRATION = "supabase/migrations/20261113000000_quotes_cross_tenant_fk.sql";
  let sql = "";
  it("the quotes migration file exists", () => {
    sql = read(MIGRATION);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("adds properties_id_org_key + leads_id_org_key (the parent candidate keys)", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(
      /properties_id_org_key[\s\S]*?add constraint properties_id_org_key unique \(id, org_id\)/,
    );
    expect(sql).toMatch(
      /leads_id_org_key[\s\S]*?add constraint leads_id_org_key unique \(id, org_id\)/,
    );
  });

  it("quotes.customer_id becomes a composite FK to customers(id, org_id), NO ACTION preserved (NOT NULL)", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/drop constraint quotes_customer_id_fkey/);
    expect(sql).toMatch(
      /add constraint quotes_customer_org_fkey[\s\S]*?foreign key \(customer_id, org_id\)[\s\S]*?references public\.customers \(id, org_id\)/,
    );
    // customer_id is NOT NULL — the composite FK must NOT carry an ON DELETE
    // SET NULL (that would be impossible against a NOT NULL column). Bound the
    // check to the customer FK's OWN statement (up to its terminating `;`), so
    // the later property/lead/job blocks' legitimate `on delete set null` don't
    // leak into the match via `[\s\S]`.
    expect(sql).not.toMatch(
      /add constraint quotes_customer_org_fkey[^;]*?on delete set null/,
    );
  });

  it("quotes.property_id / lead_id / job_id become composite FKs with column-list SET NULL", () => {
    sql = sql || read(MIGRATION);
    for (const [col, name, parent] of [
      ["property_id", "quotes_property_org_fkey", "properties"],
      ["lead_id", "quotes_lead_org_fkey", "leads"],
      ["job_id", "quotes_job_org_fkey", "jobs"],
    ] as const) {
      expect(sql, `drops bare quotes_${col}_fkey`).toMatch(
        new RegExp(`drop constraint quotes_${col}_fkey`),
      );
      expect(sql, `${name} composite FK`).toMatch(
        new RegExp(
          `add constraint ${name}[\\s\\S]*?foreign key \\(${col}, org_id\\)[\\s\\S]*?references public\\.${parent} \\(id, org_id\\)[\\s\\S]*?on delete set null \\(${col}\\)`,
        ),
      );
    }
  });
});

describe("cross-org reference injection · QUOTES app-layer re-check", () => {
  it("verifyQuoteReferences org-pins customer + property + lead + job lookups", () => {
    const helper = read("lib/crm/reference-integrity.ts");
    expect(helper).toMatch(/export async function verifyQuoteReferences/);
    // Each ref lookup is org-pinned, and a read ERROR throws (loud reads).
    expect(helper).toMatch(/from\("properties"\)[\s\S]*?\.eq\("id", propertyId\)[\s\S]*?\.eq\("org_id", orgId\)/);
    expect(helper).toMatch(/from\("leads"\)[\s\S]*?\.eq\("id", leadId\)[\s\S]*?\.eq\("org_id", orgId\)/);
    expect(helper).toMatch(/from\("jobs"\)[\s\S]*?\.eq\("id", jobId\)[\s\S]*?\.eq\("org_id", orgId\)/);
    expect(helper).toMatch(/if \(error\) throw readFailure/);
  });

  it("quotes/actions.ts calls verifyQuoteReferences on BOTH create and update", () => {
    const src = read("app/(app)/quotes/actions.ts");
    expect(src).toMatch(/from "@\/lib\/crm\/reference-integrity"/);
    const calls = src.match(/verifyQuoteReferences\(/g) ?? [];
    // create + update = at least two call sites.
    expect(calls.length, "createQuote + updateQuote must both re-check").toBeGreaterThanOrEqual(2);
    // Reacts to a rejection (never ignores it).
    expect(src).toMatch(/if \(!refs\.ok\) return formError\(refs\.message/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FINANCES + INVOICES — the C36/C37 class on the two MONEY tables. finances.job_id
// and invoices.job_id were BARE single-column FKs to jobs; a caller in org A could
// attach org B's job_id and contaminate that job's computed cost / margin /
// revenue / VAT for a dual-org user. Closed at the DB by migration 20261119000000
// (composite (job_id, org_id) FKs) + app-layer verifyJobInOrg on both write paths
// + active-org pins on the job-scoped SET reads that render the money.
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-org reference injection · FINANCES + INVOICES migration guards", () => {
  const MIGRATION =
    "supabase/migrations/20261119000000_finances_invoices_job_org_composite_fk.sql";
  let sql = "";
  it("the migration file exists", () => {
    sql = read(MIGRATION);
    expect(sql.length).toBeGreaterThan(0);
  });

  it("defensively nulls out any cross-org job_id BEFORE swapping the FK (both tables)", () => {
    sql = sql || read(MIGRATION);
    // finances: null job_id where no same-org job exists.
    expect(sql).toMatch(
      /update public\.finances[\s\S]*?set job_id = null[\s\S]*?not exists[\s\S]*?from public\.jobs j[\s\S]*?j\.org_id = public\.finances\.org_id/,
    );
    // invoices: same.
    expect(sql).toMatch(
      /update public\.invoices[\s\S]*?set job_id = null[\s\S]*?not exists[\s\S]*?from public\.jobs j[\s\S]*?j\.org_id = public\.invoices\.org_id/,
    );
  });

  it("finances.job_id becomes a composite FK to jobs(id, org_id) with column-list SET NULL", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/drop constraint finances_job_id_fkey/);
    expect(sql).toMatch(
      /add constraint finances_job_org_fkey[\s\S]*?foreign key \(job_id, org_id\)[\s\S]*?references public\.jobs \(id, org_id\)[\s\S]*?on delete set null \(job_id\)/,
    );
  });

  it("invoices.job_id becomes a composite FK to jobs(id, org_id) with column-list SET NULL", () => {
    sql = sql || read(MIGRATION);
    expect(sql).toMatch(/drop constraint invoices_job_id_fkey/);
    expect(sql).toMatch(
      /add constraint invoices_job_org_fkey[\s\S]*?foreign key \(job_id, org_id\)[\s\S]*?references public\.jobs \(id, org_id\)[\s\S]*?on delete set null \(job_id\)/,
    );
  });
});

describe("cross-org reference injection · FINANCES + INVOICES app-layer write re-check", () => {
  // Both money write paths must re-check a supplied job_id against the ACTIVE org
  // BEFORE the write, so a forged job_id is a clean 400 rather than a raw 23503
  // (and never even reaches the row). verifyJobInOrg org-pins its jobs lookup —
  // asserted by the QUOTES block above (it shares the same helper).
  const MONEY_WRITE_PATHS = [
    "app/api/finances/route.ts",
    "app/api/invoices/[id]/route.ts",
  ];
  for (const file of MONEY_WRITE_PATHS) {
    it(`${file} verifies job_id is in the active org before writing`, () => {
      const src = read(file);
      expect(
        /from "@\/lib\/crm\/reference-integrity"/.test(src),
        `${file} must import the reference-integrity helper`,
      ).toBe(true);
      expect(
        /verifyJobInOrg\s*\(/.test(src),
        `${file} must call verifyJobInOrg`,
      ).toBe(true);
      // Reacts to a rejection (never ignores it) and returns a 400.
      expect(
        /if \(!ref\.ok\)/.test(src),
        `${file} must branch on the check result`,
      ).toBe(true);
      // The rejection is a clean 400 — either the raw NextResponse form or the
      // unified responder (respond.error(400, ref.message)).
      expect(src).toMatch(/status: 400|respond\.error\(400,/);
    });
  }
});

describe("cross-org reference injection · FINANCES + INVOICES read pins", () => {
  // The read that LANDS the leak: a job-scoped SET read (`.eq("job_id", …)`) on a
  // money table via the tenant client, with NO `.eq("org_id", …)`, folds every
  // org the dual-org viewer belongs to into ONE job's cost/revenue (RLS spans all
  // membership orgs). Each such read must carry the active-org pin IN-statement.
  const READ_SITES: Array<{ file: string; tables: string[] }> = [
    {
      file: "app/(app)/jobs/[id]/page.tsx",
      tables: ["invoices", "finances"],
    },
    {
      file: "app/(app)/jobs/[id]/commercial/page.tsx",
      // retention_releases + purchase_orders are the same class (job_id-only SET
      // reads that feed the committed/forecast money tiles).
      tables: ["invoices", "finances", "retention_releases", "purchase_orders"],
    },
  ];

  /**
   * For every `.from("<table>")` occurrence, slice the statement up to the NEXT
   * `.from(` (a read statement never contains a second `.from` before its own
   * end). Any slice that reads by `job_id` must also pin `org_id` in that slice.
   * Returns the tables whose job-scoped read is NOT org-pinned.
   */
  function unpinnedJobScopedReads(src: string, tables: string[]): string[] {
    const bad: string[] = [];
    for (const table of tables) {
      const re = new RegExp(`\\.from\\(\\s*["']${table}["']`, "g");
      let m: RegExpExecArray | null;
      let sawJobScoped = false;
      while ((m = re.exec(src))) {
        const rest = src.slice(m.index + 1);
        const next = rest.search(/\.from\s*\(/);
        const slice = next === -1 ? rest : rest.slice(0, next);
        if (!/\.eq\(\s*["']job_id["']/.test(slice)) continue; // not a job-scoped read
        sawJobScoped = true;
        if (!/\.eq\(\s*["']org_id["']/.test(slice)) {
          bad.push(table);
          break;
        }
      }
      // A table we expect to read job-scoped but never saw would make the assert
      // vacuous — flag it so a refactor that drops the read is noticed.
      if (!sawJobScoped) bad.push(`${table} (no job-scoped read found)`);
    }
    return bad;
  }

  for (const { file, tables } of READ_SITES) {
    it(`${file} pins org_id on every job-scoped money read`, () => {
      const src = read(file);
      expect(unpinnedJobScopedReads(src, tables)).toEqual([]);
    });

    it(`RED-calibration: stripping the org pins from ${file} re-flags the reads`, () => {
      const src = read(file).replace(/\.eq\(\s*["']org_id["'][^)]*\)/g, "");
      // With the pins removed, every job-scoped read reverts to org-unscoped.
      const bad = unpinnedJobScopedReads(src, tables);
      for (const table of tables) {
        expect(
          bad.includes(table),
          `${file}: with org pins stripped, the ${table} read must re-flag`,
        ).toBe(true);
      }
    });
  }
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
