import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the stragglers surfaced by the loud-read-failures
 * audit (docs/loud-read-failures.md, "Out-of-scope observations").
 *
 * THE INVARIANT (unchanged from the closed read-side programme): every RLS
 * policy in this schema is `org_id in current_org_ids()` or
 * `is_org_admin(org_id)`, and BOTH admit EVERY org the viewer belongs to.
 * Neither constrains a query to the ACTIVE org (the `active_org_id` cookie →
 * `requireOrgContext()`). An org-scoped read or write with no org predicate is
 * therefore multi-org for any dual-org member. Companions:
 *   __tests__/security/active-org-scoping.test.ts          (jobs, #456)
 *   __tests__/security/active-org-finance-scoping.test.ts  (finance, #459)
 *   __tests__/security/active-org-supplier-scoping.test.ts (suppliers, #463)
 *   __tests__/security/active-org-assets-scoping.test.ts   (asset/QR, #464)
 *   __tests__/security/fleet-active-org-scoping.test.ts    (fleet, #465)
 *   __tests__/security/active-org-list-scoping.test.ts     (lists, #468)
 *   __tests__/security/active-org-signoff-denominator.test.ts (H&S, #473)
 *
 * This slice pins the audit's straggler list: the payroll hours window (a
 * shared member's OTHER-org time entries were summed into this org's gross
 * pay), the payroll run gates, the site-report create-time job resolve (form
 * input — a foreign job id hung this org's report off the other company's
 * job and customer), the bank-CSV invoice scorer (it could suggest the other
 * company's invoice for this org's bank line), three detail subjects loaded
 * by primary key alone (toolbox talk, snag, purchase order), the
 * purchase-order action gates + writes, and the AI aggregates (both payloads
 * are stamped with ONE org_id but read every org's rows).
 *
 * Deliberately NOT pinned here, per the programme's derived-safe doctrine
 * (see active-org-list-scoping.test.ts §1b): child reads keyed on a pinned
 * subject's id (payroll_lines by run id, PO line items / supplier bills by PO
 * id) and FK-label resolves that take a column of an already-pinned row
 * (toolbox/snag job labels, issueReport's job read). confirmBankMatch is
 * owned by bank-match-invoice-org-scope.test.ts; the payments membership-role
 * read is owned by the membership-role-derivation slice.
 *
 * Why this tier and this style: these are Server Actions and RSC pages
 * coupled to `createClient` + `requireOrgContext` + `cookies()`, which the
 * repo has no Supabase mock harness for — so the invariants are pinned on
 * SOURCE, the documented convention of every companion above. Every new-pin
 * assertion fails against the pre-fix source (17 of 23 verified red); the
 * rest are regression guards on pins and stamps that already existed.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract one exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

/** The canonical pin in a page/action, where ctx comes from requireOrgContext(). */
const CTX_PIN = /\.eq\(\s*["']org_id["'],\s*ctx\.org\.id\s*\)/;
const CTX_PIN_G = () => /\.eq\(\s*["']org_id["'],\s*ctx\.org\.id\s*\)/g;
const countPins = (source: string) => (source.match(CTX_PIN_G()) ?? []).length;
/** The pin in a helper that takes the active org as an argument. */
const ARG_PIN = /\.eq\(\s*["']org_id["'],\s*orgId\s*\)/;

/** A file that pins by ctx.org.id must actually destructure ctx. */
const CAPTURES_CTX = /const \{[^}]*\bctx\b[^}]*\} = await requireOrgContext\(\)/;

// ---------------------------------------------------------------------------
// 1. Payroll — money computed from a cross-org read is a wrong payslip
// ---------------------------------------------------------------------------

describe("payroll actions — runs, hours and locks stay inside the ACTIVE org", () => {
  const SRC = () => src("app/(app)/payroll/actions.ts");

  it("createPayrollRun pins the HOURS window (the sum that becomes gross pay)", () => {
    // A member of two orgs has time_entries in both; RLS returns them all.
    // Unpinned, the other company's shifts were paid on THIS company's payroll.
    const F = fn(SRC(), "createPayrollRun");
    expect(F).toMatch(
      /\.from\("time_entries"\)\s*\.select\("id, user_id[\s\S]{0,80}?breaks"\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.gte\("started_at", windowStartIso\)/,
    );
    // The closed-entries filter must survive alongside the pin.
    expect(F).toMatch(/\.not\("ended_at", "is", null\)/);
  });

  it("createPayrollRun's open-entry guard keeps its pin (regression, not a new fix)", () => {
    const F = fn(SRC(), "createPayrollRun");
    expect(F).toMatch(
      /\.from\("time_entries"\)[\s\S]{0,160}?\.eq\("org_id", ctx\.org\.id\)\s*\.is\("ended_at", null\)/,
    );
  });

  it("finalisePayrollRun resolves the run by id AND active org", () => {
    const F = fn(SRC(), "finalisePayrollRun");
    expect(F).toMatch(
      /\.from\("payroll_runs"\)\s*\.select\("id, period_start, period_end, status"\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("finalisePayrollRun locks time entries inside the ACTIVE org only", () => {
    // The lock is keyed by user_id + window, NOT by the run id — so the run
    // pin does not derive it. Unpinned, finalising here stamped a shared
    // member's OTHER-org entries with this org's payroll_line_id.
    const F = fn(SRC(), "finalisePayrollRun");
    expect(F).toMatch(
      /\.update\(\{ payroll_line_id: l\.id \}\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("user_id", l\.user_id\)/,
    );
  });

  it("finalisePayrollRun's status flip carries the pin too", () => {
    const F = fn(SRC(), "finalisePayrollRun");
    expect(F).toMatch(
      /\.update\(\{ status: "finalised"[\s\S]{0,80}?\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("deletePayrollRun gates AND deletes by id + active org", () => {
    const F = fn(SRC(), "deletePayrollRun");
    expect(F).toMatch(
      /\.select\("status"\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(F).toMatch(/\.delete\(\)\s*\.eq\("id", runId\)\s*\.eq\("org_id", ctx\.org\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. Site reports — the create-time job resolve takes FORM input
// ---------------------------------------------------------------------------

describe("site-reports createSiteReport — the job resolve is pinned", () => {
  // The create-time job resolve moved into the SHARED write core (train "offl":
  // createSiteReportDraftRecord in server/services/site-report-writes.ts), which
  // both the online form post and the offline queue replay now call — so the pin
  // is enforced once for both entry points. It pins by the org ARGUMENT (`orgId`
  // = ctx.org.id) rather than ctx directly.
  const F = () =>
    fn(src("server/services/site-report-writes.ts"), "createSiteReportDraftRecord");

  it("resolves the job by id AND active org (job_id arrives from the form)", () => {
    // The report shell is stamped org_id: orgId, so an unpinned resolve would let
    // a dual-org member hang this org's report off the OTHER org's job —
    // inheriting that job's customer_id for portal scoping.
    expect(F()).toMatch(
      /from\("jobs"[\s\S]*?\.select\("id, customer_id"\)\s*\.eq\("id", args\.input\.job_id\)\s*\.eq\("org_id", orgId\)/,
    );
  });

  it("the pinned resolve runs BEFORE gatherReportSources, so it gates the aggregation", () => {
    // gatherReportSources reads diaries/snags/etc by job_id; verifying the job
    // first makes those child reads derived-safe.
    const body = F();
    const resolveIdx = body.indexOf('.eq("id", args.input.job_id)');
    const gatherIdx = body.indexOf("gatherReportSources(");
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(gatherIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(gatherIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Payments — the bank-CSV scorer must only ever suggest THIS org's invoices
// ---------------------------------------------------------------------------

describe("payments uploadBankCsv — the match-scoring read is pinned", () => {
  it("pulls unpaid invoices for the ACTIVE org only, keeping the status filter", () => {
    // Unpinned, the scorer could write a 'suggested' match naming the OTHER
    // company's invoice onto this org's bank line. (The confirm path's own
    // org re-check is owned by bank-match-invoice-org-scope.test.ts.)
    const F = fn(src("app/(app)/payments/actions.ts"), "uploadBankCsv");
    expect(F).toMatch(
      /\.from\("invoices"\)[\s\S]{0,300}?\.eq\("org_id", ctx\.org\.id\)\s*\.in\("status", \["sent", "awaiting_payment", "partially_paid", "overdue"\]\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Detail subjects loaded by primary key alone
// ---------------------------------------------------------------------------

describe("detail subjects are pinned by id AND org", () => {
  const SUBJECTS: Array<[string, string, string]> = [
    // path, table, what the pin protects downstream
    [
      "app/(app)/toolbox/[id]/page.tsx",
      "toolbox_talks",
      "the briefing content, sign-off panel and evidence PDF links",
    ],
    ["app/(app)/snags/[id]/page.tsx", "snags", "the defect detail + status/reassign controls"],
    [
      "app/(app)/purchase-orders/[id]/page.tsx",
      "purchase_orders",
      "the committed-spend lines and the supplier-bill panel",
    ],
  ];

  for (const [path, table, protects] of SUBJECTS) {
    it(`${path} pins its ${table} subject (protects ${protects})`, () => {
      const s = src(path);
      expect(s).toMatch(CAPTURES_CTX);
      expect(s, `${path} no longer reads ${table}`).toMatch(
        new RegExp(`\\.from\\(\\s*["']${table}["']`),
      );
      expect(s, `${path}: the subject load lost its active-org predicate`).toMatch(CTX_PIN);
      // The by-id predicate must survive alongside the org pin — a subject
      // loaded by org ALONE would render an arbitrary row.
      expect(s, `${path} must still identify the subject by id`).toMatch(
        /\.eq\(\s*["']id["'],\s*id\s*\)/,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 4b. The read-side stragglers the independent red-team wave found (#456 class).
//     These three detail pages read their PRIMARY subject by id alone — a
//     dual-org member could open the OTHER org's quote / diary entry / expense
//     draft (financial + PII rows) inside the active org's shell, next to the
//     lifecycle, delete and approve-to-Finances actions. The systemic backstop
//     is __tests__/security/active-org-read-pin-guard.test.ts; these are the
//     per-instance regression pins, in the same style as §4.
// ---------------------------------------------------------------------------

describe("read-side stragglers — quote / diary / expense subjects are pinned by id AND org", () => {
  const SUBJECTS: Array<[string, string, string]> = [
    [
      "app/(app)/quotes/[id]/page.tsx",
      "quotes",
      "the totals, priced cost basis, customer PII and lifecycle/delete actions",
    ],
    [
      "app/(app)/diary/[id]/page.tsx",
      "site_diary_entries",
      "the entry detail + delete control (and its job_id label resolve)",
    ],
    [
      "app/(app)/expenses/[id]/page.tsx",
      "expense_drafts",
      "the supplier/amount/VAT/reference and the approve-to-Finances action",
    ],
  ];

  for (const [path, table, protects] of SUBJECTS) {
    it(`${path} pins its ${table} subject (protects ${protects})`, () => {
      const s = src(path);
      expect(s).toMatch(CAPTURES_CTX);
      expect(s, `${path} no longer reads ${table}`).toMatch(
        new RegExp(`\\.from\\(\\s*["']${table}["']`),
      );
      expect(s, `${path}: the subject load lost its active-org predicate`).toMatch(CTX_PIN);
      expect(s, `${path} must still identify the subject by id`).toMatch(
        /\.eq\(\s*["']id["'],\s*id\s*\)/,
      );
    });
  }

  it("diary + site-report + snag job-label resolves are routed through the org-pinned jobs chokepoint", () => {
    // These FK-label resolves take a pinned parent's job_id; they now go through
    // loadJobForOrg(…, ctx.org.id) instead of an unpinned .from("jobs").eq("id",…).
    for (const path of [
      "app/(app)/diary/[id]/page.tsx",
      "app/(app)/site-reports/[id]/page.tsx",
      "app/(app)/snags/[id]/page.tsx",
    ]) {
      expect(src(path), `${path}: job label resolve must use loadJobForOrg`).toMatch(
        /loadJobForOrg[\s\S]{0,160}?ctx\.org\.id/,
      );
    }
  });

  it("addInvoicePayment resolves the invoice by id AND active org before stamping the payment", () => {
    // The recorded payment is stamped with the invoice row's org_id; an unpinned
    // read let a dual-org member post a payment against the OTHER org's invoice.
    const F = fn(src("app/(app)/invoices/[id]/payment-actions.ts"), "addInvoicePayment");
    expect(F).toMatch(
      /\.from\("invoices"\)\s*\.select\("id, total, org_id"\)\s*\.eq\("id", invoiceId\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Purchase-order actions — every gate and write carries the pin
// ---------------------------------------------------------------------------

describe("purchase-order actions — gates and writes stay inside the ACTIVE org", () => {
  const SRC = () => src("app/(app)/purchase-orders/actions.ts");

  it("updatePurchaseOrder gates on id + org and writes with the same predicate", () => {
    const F = fn(SRC(), "updatePurchaseOrder");
    expect(F).toMatch(/\.select\("status"\)\s*\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(
      /expected_date: parsed\.data\.expected_date \?\? null,\s*\}\)\s*\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
  });

  it("setPurchaseOrderStatus captures ctx, gates on id + org, and writes pinned", () => {
    const F = fn(SRC(), "setPurchaseOrderStatus");
    expect(F, "the action used requireOrgContext as a bare auth gate").toMatch(CAPTURES_CTX);
    expect(F).toMatch(/\.select\("status"\)\s*\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/\.update\(\{ status: to \}\)\s*\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    // The lifecycle guard must survive the pin.
    expect(F).toMatch(/canTransitionPo\(existing\.status as PurchaseOrderStatus, to\)/);
  });

  it("deletePurchaseOrder deletes by id + org and COUNTS, so a foreign/missing PO is a not-found", () => {
    // RLS filters non-admins (and the pin filters foreign orgs) to 0 rows
    // with NO error — the old code fell through to the success redirect and a
    // false "deleted" audit entry. Same treatment as movePin in #468.
    const F = fn(SRC(), "deletePurchaseOrder");
    expect(F).toMatch(CAPTURES_CTX);
    expect(F).toMatch(
      /\.delete\(\{ count: "exact" \}\)\s*\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(F).toMatch(/if \(!count\) redirect\(`?\/purchase-orders/);
  });

  it("recordSupplierBill resolves its PO by id + org before inheriting job/supplier", () => {
    // The bill posts to finances stamped org_id: ctx.org.id but inherits the
    // PO's job_id + supplier_id — a foreign PO would cross-link two
    // companies' money. The DB same-org trigger backstops this; the pin makes
    // the action fail closed with a clean "not found" instead.
    const F = fn(SRC(), "recordSupplierBill");
    expect(F).toMatch(
      /\.select\("id, job_id, supplier_id"\)\s*\.eq\("id", purchaseOrderId\)\s*\.eq\("org_id", ctx\.org\.id\)/,
    );
    expect(F, "the bill insert must keep stamping the active org").toMatch(/org_id: ctx\.org\.id,/);
    expect(F, "the dedupe guard keeps its own pin (regression)").toMatch(
      /\.select\("id"\)\s*\.eq\("org_id", ctx\.org\.id\)\s*\.eq\("purchase_order_id", po\.id\)/,
    );
  });

  it("createPurchaseOrder still stamps the shell with the active org (regression)", () => {
    const F = fn(SRC(), "createPurchaseOrder");
    expect(F).toMatch(/org_id: ctx\.org\.id,/);
    const n = countPins(SRC());
    expect(n, `expected at least 7 active-org predicates across the PO actions, found ${n}`)
      .toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// 6. AI aggregates — a payload stamped with ONE org_id must read ONE org
// ---------------------------------------------------------------------------

describe("lib/ai/aggregates — every read is pinned to the orgId the payload claims", () => {
  const SRC = () => src("lib/ai/aggregates.ts");

  it("computeActivitySummary pins all four reads (activity_log, quotes, invoices, jobs)", () => {
    const F = fn(SRC(), "computeActivitySummary");
    // `id` is now selected as the unique pagination tiebreak (F-1 fix); the
    // active-org pin still immediately follows the select.
    expect(F).toMatch(
      /\.from\("activity_log"\)\s*\.select\("id, action, created_at"\)\s*\.eq\("org_id", orgId\)/,
    );
    expect(F).toMatch(/\.from\("quotes"\)[\s\S]{0,220}?\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.from\("invoices"\)[\s\S]{0,120}?\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.from\("jobs"\)[\s\S]{0,160}?\.eq\("org_id", orgId\)/);
    // The window filter must survive alongside the pin.
    expect(F).toMatch(/\.eq\("org_id", orgId\)\s*\.gte\("created_at", since\)/);
  });

  it("computeLeadInsights pins the leads read, keeping its window filter", () => {
    const F = fn(SRC(), "computeLeadInsights");
    expect(F).toMatch(
      /\.from\("leads"\)[\s\S]{0,120}?\.eq\("org_id", orgId\)\s*\.gte\("created_at", since\)/,
    );
  });

  it("every caller passes ctx.org.id (the ACTIVE org, never a request value)", () => {
    const CALLERS: Array<[string, string[]]> = [
      ["app/(app)/insights/page.tsx", ["computeActivitySummary", "computeLeadInsights"]],
      ["app/(app)/dashboard/page.tsx", ["computeActivitySummary", "computeLeadInsights"]],
      ["app/api/ai/activity_summary/route.ts", ["computeActivitySummary"]],
      ["app/api/ai/lead_insights/route.ts", ["computeLeadInsights"]],
    ];
    for (const [path, calls] of CALLERS) {
      const s = src(path);
      for (const call of calls) {
        expect(s, `${path}: ${call} must receive the active org`).toMatch(
          new RegExp(`${call}\\(ctx\\.org\\.id`),
        );
      }
    }
  });

  it("the aggregates never touch the active-org cookie (a scope fix, not a context switch)", () => {
    expect(SRC()).not.toMatch(/setActiveOrg|cookies\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. Behaviour preservation — the slice added predicates, nothing else
// ---------------------------------------------------------------------------

describe("the pins do not change anything else", () => {
  it("no touched action file writes the active-org cookie", () => {
    for (const p of [
      "app/(app)/payroll/actions.ts",
      "app/(app)/site-reports/actions.ts",
      "app/(app)/payments/actions.ts",
      "app/(app)/purchase-orders/actions.ts",
    ]) {
      expect(src(p), `${p} must not write the active-org cookie`).not.toMatch(
        /setActiveOrg|cookies\(/,
      );
    }
  });

  it("payroll's derived-safe child read stays keyed by the pinned run (no double pin)", () => {
    // payroll_lines rows are created with the run and carry its org; keying by
    // the PINNED run id is the derived-safe doctrine of §1b. This guards
    // against a future "cleanup" replacing the run-id key with something else.
    expect(fn(src("app/(app)/payroll/actions.ts"), "finalisePayrollRun")).toMatch(
      /\.from\("payroll_lines"\)\s*\.select\("id, user_id"\)\s*\.eq\("payroll_run_id", runId\)/,
    );
  });
});
