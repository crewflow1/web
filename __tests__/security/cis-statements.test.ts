import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const MIGRATION = "supabase/migrations/20261055000000_cis_statements.sql";
const MIG_DIR = resolve(ROOT, "supabase/migrations");

/**
 * H2-CIS M4 — trust-boundary pins for statements and the monthly return dataset.
 *
 * Hermetic: filesystem + source contracts, no database. The live-Postgres proofs
 * (RLS denial, cross-tenant isolation, immutability, the reissue path,
 * reconciliation) are in __tests__/integration/rls/cis-statements.test.ts.
 *
 * What THIS tier stops is the two controls that matter most being quietly
 * loosened later:
 *
 *   1. THE FILING BOUNDARY. CrewFlow has no HMRC integration. If a "submitted"
 *      or "filed" state ever appears, a user can record that a statutory
 *      obligation was met when it was not — and the penalty for a missed CIS
 *      return starts at £100 and reaches £3,000.
 *   2. THE FABRICATION BOUNDARY. A verification number is never invented, and a
 *      deduction is never recomputed outside M3's engine.
 */

/** Strip SQL line comments so negative assertions test EXECUTABLE statements. */
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

/** Strip TS/JS comments, for source contracts about real code. */
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const sql = sqlOnly(read(MIGRATION));

// ---------------------------------------------------------------------------
// 1. Migration hygiene
// ---------------------------------------------------------------------------

describe("CIS M4 migration hygiene", () => {
  it("uses its reserved slot, with nothing back-dated beneath it", () => {
    // The hazard is a file added LATER with a LOWER number: Supabase keys
    // migration identity on the numeric prefix, so such a file replays out of
    // order from a fresh database while looking fine on an already-migrated one.
    const versions = readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0]!)
      .sort();

    expect(versions).toContain("20261055000000");
    expect(new Set(versions).size, "duplicate migration version prefixes").toBe(versions.length);

    // M4 must sort strictly after the M3 chain it builds on.
    const m4 = versions.indexOf("20261055000000");
    expect(m4).toBeGreaterThan(versions.indexOf("20261051000000"));
    expect(m4).toBeGreaterThan(versions.indexOf("20261054000000"));
  });

  it("does not touch the M2/M3 ledger tables it reads from", () => {
    // M4 is a READER. If it ever alters supplier_payments, its allocations or
    // the snapshots, a document-rendering milestone has acquired the power to
    // move a tax figure.
    for (const t of [
      "supplier_payments",
      "supplier_payment_allocations",
      "cis_payment_snapshots",
      "cis_bill_details",
      "finances",
    ]) {
      expect(sql, `M4 must not alter ${t}`).not.toMatch(
        new RegExp(`alter\\s+table\\s+(public\\.)?${t}\\b`, "i"),
      );
    }
  });

  it("adds no trigger to supplier_payment_allocations", () => {
    // 20261053/54 and __tests__/integration/rls/trigger-firing-order.test.ts
    // depend on the exact set and NAME ORDER of before-insert triggers on that
    // table. Adding one here could reorder them and break a financial-
    // correctness invariant that no sequential test can observe.
    expect(sql).not.toMatch(/on\s+public\.supplier_payment_allocations/i);
  });
});

// ---------------------------------------------------------------------------
// 2. THE FILING BOUNDARY
// ---------------------------------------------------------------------------

describe("CIS M4 never claims anything was filed with HMRC", () => {
  it("constrains the return status domain to prepared|exported and nothing else", () => {
    expect(sql).toMatch(/check\s*\(\s*status\s+in\s*\(\s*'prepared'\s*,\s*'exported'\s*\)\s*\)/i);
  });

  it("has no submitted / filed / accepted state anywhere in the migration", () => {
    for (const word of ["'submitted'", "'filed'", "'accepted'", "'sent'", "'acknowledged'"]) {
      expect(sql, `${word} must not be a state in the CIS M4 schema`).not.toContain(word);
    }
  });

  it("refuses any transition out of prepared other than exported", () => {
    expect(sql).toMatch(/old\.status\s*=\s*'prepared'\s+and\s+new\.status\s*=\s*'exported'/i);
  });

  it("contains no HMRC endpoint, gateway credential or transport call", () => {
    const files = [
      "lib/cis/statements.ts",
      "lib/cis/contractor.ts",
      "server/services/cis-statements.ts",
      "app/(app)/cis/actions.ts",
      "app/api/cis/statements/[id]/pdf/route.ts",
      MIGRATION,
    ];
    for (const f of files) {
      const src = f.endsWith(".sql") ? sqlOnly(read(f)) : codeOf(read(f));
      expect(src, `${f} must not reach a network endpoint`).not.toMatch(
        /https?:\/\/(?!www\.gov\.uk)/i,
      );
      expect(src, `${f} must not call HMRC`).not.toMatch(
        /gov\.uk\/(?!.*guidance)|government\s*gateway|hmrc[-_]?(api|client|token|credential)/i,
      );
      expect(src, `${f} must not fetch`).not.toMatch(/\bfetch\s*\(|axios|got\(/);
    }
  });

  it("derives both deadlines from the ONE definition, never inline", () => {
    // A hand-rolled `+ 14 * 86400000` on a page is how the rendered deadline and
    // the stored `statement_due_on` drift apart. Both deadlines live in
    // lib/cis/tax-month.ts with SQL twins; surfaces call them.
    for (const f of ["app/(app)/cis/page.tsx", "app/(app)/cis/statements/[id]/page.tsx"]) {
      const src = codeOf(read(f));
      expect(src, `${f} must not recompute a CIS deadline inline`).not.toMatch(
        /86_?400_?000|\*\s*24\s*\*\s*60\s*\*\s*60/,
      );
    }
    expect(codeOf(read("app/(app)/cis/page.tsx"))).toMatch(/cisStatementDueDate/);
  });

  it("tells the user plainly, in shipped copy, that CrewFlow does not file", () => {
    const notice = codeOf(read("lib/cis/statements.ts"));
    expect(notice).toMatch(/CrewFlow does not file your CIS return with HMRC/);
    // And the operator page actually renders it.
    expect(read("app/(app)/cis/page.tsx")).toContain("CIS_NO_FILING_NOTICE");
  });

  it("names the export action for what it does, not for filing", () => {
    const actions = codeOf(read("app/(app)/cis/actions.ts"));
    expect(actions).toMatch(/export\s+async\s+function\s+exportCisReturn/);
    expect(actions).not.toMatch(/function\s+(submit|file|send)Cis(Return|Statement)/i);
  });
});

// ---------------------------------------------------------------------------
// 3. THE FABRICATION BOUNDARY
// ---------------------------------------------------------------------------

describe("CIS M4 never invents a verification number", () => {
  it("leaves verification_number nullable with no default and no derivation", () => {
    expect(sql).toMatch(/verification_number\s+text\b/i);
    expect(sql).not.toMatch(/verification_number\s+text[^,]*\bdefault\b/i);
    expect(sql).not.toMatch(/verification_number\s+text\s+not\s+null/i);
    // It is COPIED from a frozen snapshot, never generated.
    expect(sql).toMatch(/s\.verification_reference/i);
  });

  it("requires a number only for the higher-rate unmatched cases", () => {
    // CISR12160: "only if the subcontractor could not be verified and a
    // deduction at the higher rate has been applied".
    expect(sql).toMatch(/'higher_30'\s*,\s*'failed'/);
    const lib = codeOf(read("lib/cis/statements.ts"));
    expect(lib).toMatch(/HIGHER_RATE_STATUSES[^\n]*=\s*\[\s*"higher_30"\s*,\s*"failed"\s*\]/);
  });

  it("prints the absence in words rather than a placeholder", () => {
    const lib = codeOf(read("lib/cis/statements.ts"));
    expect(lib).toMatch(/kind:\s*"missing"/);
    expect(lib).toMatch(/obtain the verification number from HMRC/i);
    // No fabricated shapes anywhere in the shipped source.
    expect(lib).not.toMatch(/V0{6,}/);
  });
});

describe("CIS M4 builds no second deduction engine", () => {
  it("performs no rate arithmetic in the migration", () => {
    // Summation only. A `* rate / 100` here would be a second engine, and two
    // answers to the same tax question is exactly what M3's snapshots exist to
    // prevent.
    expect(sql).not.toMatch(/deduction_rate\s*\/\s*100/);
    expect(sql).not.toMatch(/\*\s*v_rate/);
    expect(sql).not.toMatch(/cis_basis\s*\*/);
  });

  it("does not recompute a deduction in the pure layer either", () => {
    const lib = codeOf(read("lib/cis/statements.ts"));
    expect(lib).not.toMatch(/\/\s*100/);
    expect(lib).not.toMatch(/computeBillBasis|computeAllocationDeduction/);
    // It reads the FROZEN columns and sums them.
    expect(lib).toMatch(/cis_gross_payment/);
    expect(lib).toMatch(/sumMoney/);
  });

  it("reports HMRC's gross amount, not VAT-inclusive cash", () => {
    // supplier_payments.gross_amount is VAT-inclusive. Reporting it would
    // overstate every VAT-registered subcontractor's gross by the VAT.
    const lib = codeOf(read("lib/cis/statements.ts"));
    expect(lib).not.toMatch(/gross_amount:\s*.*supplier_payments/);
    expect(sql).toMatch(/sum\(s\.cis_gross_payment\)/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Tenancy + immutability posture
// ---------------------------------------------------------------------------

describe("CIS M4 tenancy and immutability", () => {
  const TABLES = [
    "cis_contractor_profiles",
    "cis_statements",
    "cis_statement_payments",
    "cis_monthly_returns",
    "cis_monthly_return_lines",
  ];

  it("enables RLS on every new table", () => {
    for (const t of TABLES) {
      expect(sql, `${t} must have RLS enabled`).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
    }
  });

  it("gates every new table on is_org_admin — not the member-read norm", () => {
    // These rows carry the org's own PAYE reference, subcontractors' masked UTRs
    // and verification numbers, and they are the documents a subcontractor uses
    // to reclaim tax. Same posture as M1/M2/M3.
    for (const t of TABLES) {
      const policy = new RegExp(
        `create\\s+policy\\s+"${t}: admin all"\\s+on\\s+public\\.${t}[\\s\\S]{0,240}?using\\s*\\(\\s*public\\.is_org_admin\\(org_id\\)\\s*\\)[\\s\\S]{0,120}?with\\s+check\\s*\\(\\s*public\\.is_org_admin\\(org_id\\)\\s*\\)`,
        "i",
      );
      expect(sql, `${t} must be admin-only for read AND write`).toMatch(policy);
    }
    expect(sql).not.toMatch(/current_org_ids\(\)/);
  });

  it("binds statements to their tenant with a composite FK, not app code", () => {
    expect(sql).toMatch(
      /foreign key \(supplier_id, org_id\) references public\.suppliers \(id, org_id\)/i,
    );
    expect(sql).toMatch(
      /foreign key \(payment_id, org_id, supplier_id\)\s*references public\.supplier_payments \(id, org_id, supplier_id\)/i,
    );
  });

  it("freezes an issued statement and its provenance rows", () => {
    expect(sql).toMatch(/create trigger cis_statements_immutable\s+before update/i);
    expect(sql).toMatch(/create trigger cis_statement_payments_frozen\s+before update/i);
    expect(sql).toMatch(/create trigger cis_monthly_return_lines_frozen\s+before update/i);
    // Forward-only, terminal-is-terminal.
    expect(sql).toMatch(/old\.status in \('superseded', 'withdrawn'\)/i);
  });

  it("refuses deletes except during org teardown", () => {
    // The org-absence test M2/M3 established: during a cascade the parent org is
    // already invisible, so a targeted delete is always refused and a tenant
    // teardown still succeeds.
    for (const t of ["cis_statements", "cis_monthly_returns"]) {
      expect(sql).toMatch(new RegExp(`create trigger ${t}_no_delete\\s+before delete`, "i"));
    }
    expect(sql).toMatch(/exists \(select 1 from public\.organizations where id = old\.org_id\)/i);
  });

  it("constrains both hashes to lowercase hex SHA-256", () => {
    // The tenant_attachments.content_hash idiom (20261033000000).
    const hex = /~\s*'\^\[a-f0-9\]\{64\}\$'/g;
    expect((sql.match(hex) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("reconciles a statement to its payments and a return to its lines, at COMMIT", () => {
    expect(sql).toMatch(
      /create constraint trigger cis_statements_totals_reconcile\s+after insert[\s\S]{0,80}deferrable initially deferred/i,
    );
    expect(sql).toMatch(
      /create constraint trigger cis_monthly_returns_reconcile\s+after insert[\s\S]{0,80}deferrable initially deferred/i,
    );
  });

  it("keeps one current statement per subcontractor per tax month", () => {
    expect(sql).toMatch(
      /create unique index[^;]*cis_statements_one_current_idx[\s\S]{0,200}where status = 'issued'/i,
    );
  });

  it("models a nil return as a row, coherently", () => {
    expect(sql).toMatch(/is_nil\s+boolean\s+not\s+null/i);
    expect(sql).toMatch(/cis_monthly_returns_nil_coherent/i);
  });

  it("stores only a MASKED subcontractor UTR — no second unmasked home", () => {
    expect(sql).toMatch(/subcontractor_utr_masked/);
    // A bare `utr` column on a statement would be a new place to leak from.
    expect(sql).not.toMatch(/^\s*utr\s+text/im);
  });

  it("runs every service call on the tenant client, never service_role", () => {
    const svc = codeOf(read("server/services/cis-statements.ts"));
    expect(svc).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(svc).not.toMatch(/SERVICE_ROLE|createServiceClient|serviceClient/i);
  });

  it("is a READ-ONLY consumer of the M2/M3 ledger", () => {
    // The claim the M2 and M3 allowlist pins now rely on
    // (__tests__/security/supplier-payments.test.ts,
    // __tests__/security/cis-deduction.test.ts): M4 reads the ledger to build
    // documents and never writes to it. Enforced here rather than left as a
    // comment in someone else's test.
    const svc = codeOf(read("server/services/cis-statements.ts"));
    for (const t of ["supplier_payments", "supplier_payment_allocations", "cis_payment_snapshots"]) {
      const writes = new RegExp(
        `table\\([^,]+,\\s*"${t}"\\)\\s*\\.\\s*(insert|update|delete|upsert)`,
      );
      expect(svc, `M4 must not write to ${t}`).not.toMatch(writes);
    }
    // The ONLY table M4 writes directly is its own contractor profile; every
    // other write goes through an RPC, where the DB triggers apply.
    const directWrites = [...svc.matchAll(/table\([^,]+,\s*"([a-z_]+)"\)\s*\.\s*(?:insert|update|delete|upsert)/g)]
      .map((m) => m[1]);
    expect([...new Set(directWrites)].sort()).toEqual(["cis_contractor_profiles"]);
  });

  it("keeps the RPCs SECURITY INVOKER so RLS applies to the caller", () => {
    for (const fn of [
      "issue_cis_statement",
      "withdraw_cis_statement",
      "prepare_cis_monthly_return",
      "mark_cis_monthly_return_exported",
    ]) {
      const body = new RegExp(
        `create or replace function public\\.${fn}\\([\\s\\S]{0,600}?security invoker`,
        "i",
      );
      expect(sql, `${fn} must be SECURITY INVOKER`).toMatch(body);
    }
    // …and each still names the admin gate for a good error message.
    expect((sql.match(/not public\.is_org_admin\(p_org_id\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 5. No stray unmasked identifiers on any public surface
// ---------------------------------------------------------------------------

describe("CIS M4 does not leak tax identifiers", () => {
  it("never renders a raw UTR outside the admin-gated statement PDF", () => {
    const offenders = walk(resolve(ROOT, "app"))
      .filter((f) => /customer-portal|\/q\/|\/api\/public/.test(f))
      .filter((f) => /\butr\b/i.test(read(f)));
    expect(offenders, "a portal surface must never render a UTR").toEqual([]);
  });

  it("keeps the audit trail free of identifiers", () => {
    const actions = codeOf(read("app/(app)/cis/actions.ts"));
    // Presence FLAGS are fine (`has_utr: Boolean(...)`), values are not. The
    // audit log records that an identifier is held, never what it is.
    expect(actions).toMatch(/has_paye_reference/);
    expect(actions).not.toMatch(/employer_paye_reference:\s*parsed\.data/);
    expect(actions).not.toMatch(/\butr:\s*(parsed|input|profile|data|v)\./i);
    expect(actions).not.toMatch(/contractor_utr:\s*parsed\.data/);
  });
});
