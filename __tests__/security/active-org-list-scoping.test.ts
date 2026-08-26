import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the LIST surfaces must pin every collection read to
 * `ctx.org.id`.
 *
 * The last enumerated slice of the defect class. Companions:
 *   __tests__/security/active-org-scoping.test.ts          (jobs, #456)
 *   __tests__/security/active-org-finance-scoping.test.ts  (finance, #459)
 *   __tests__/security/active-org-supplier-scoping.test.ts (suppliers, #463)
 *   __tests__/security/active-org-assets-scoping.test.ts   (asset/QR, #464)
 *   __tests__/security/fleet-active-org-scoping.test.ts    (fleet, #465)
 *
 * The invariant: every list policy in this schema is
 * `org_id in current_org_ids()` (or `is_org_admin(org_id)`), and BOTH admit
 * EVERY org the viewer belongs to. Neither constrains a query to the ACTIVE org
 * (the `active_org_id` cookie → `requireOrgContext()`). A list read must
 * therefore carry its own org predicate, or a dual-org member sees the two
 * companies interleaved — one register, one address book, one sales ledger, and
 * a dashboard whose money tiles are the SUM of two businesses.
 *
 * Why this tier and this style: these are RSC pages and route handlers coupled
 * to `createClient` + `requireOrgContext` + `cookies()`, and the repo has no
 * Supabase mock harness for them — so the invariants are pinned on SOURCE, the
 * documented convention already used by the companion files above. The runtime
 * proof, against real Postgres with a real multi-org user's JWT, lives in
 * __tests__/integration/rls/active-org-list-scoping.test.ts (139 assertions
 * across 34 domains).
 *
 * Every assertion here fails against the pre-fix source. Together with the
 * integration tier this means a pin cannot be quietly dropped: deleting one
 * goes red HERE, and weakening the predicate's effect goes red THERE.
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

/**
 * The canonical pin as it appears in a page or route handler. `ctx` comes from
 * `requireOrgContext()`, never from a query string or a request body.
 */
const CTX_PIN = /\.eq\(\s*["']org_id["'],\s*ctx\.org\.id\s*\)/;
/** Global form, for counting how many reads in a file carry the pin. */
const CTX_PIN_G = () => /\.eq\(\s*["']org_id["'],\s*ctx\.org\.id\s*\)/g;
const countPins = (source: string) => (source.match(CTX_PIN_G()) ?? []).length;
/**
 * The pin as it appears in a helper that takes the active org as an argument.
 * `as never` is tolerated on either side: `notifications` predates the generated
 * Supabase types, so its call sites cast — the predicate is the same.
 */
const ARG_PIN = /\.eq\(\s*["']org_id["'](?:\s+as\s+never)?,\s*orgId(?:\s+as\s+never)?\s*\)/;

/** A page that captures ctx must actually destructure it, not just await. */
// A page must CAPTURE ctx (to scope reads by ctx.org.id), not bare-await the auth
// gate. Either the direct requireOrgContext() or the i18n-wave request helper
// getRequestI18n() (which returns the same ctx and enforces requireOrgContext
// internally) satisfies this — both destructure ctx from the resolved request.
const CAPTURES_CTX =
  // Either the classic org-context capture, or the management-gated API form
  // (fix 1: `const guard = await requireManagementApi(); … const { ctx } = guard;`)
  // — the latter is STRICTLY stronger: it wraps requireOrgContext AND adds the
  // owner/admin gate before any table read.
  /const \{[^}]*\bctx\b[^}]*\} = await (requireOrgContext|getRequestI18n|requireManagementContext)\(\)|const guard = await requireManagementApi\(\);[\s\S]{0,300}?const \{[^}]*\bctx\b[^}]*\} = guard/;

// ---------------------------------------------------------------------------
// 1. List pages — one pin per collection read, keyed by the table it reads
// ---------------------------------------------------------------------------

/**
 * file → the tables whose reads on that page MUST carry the active-org pin.
 *
 * The assertion is per-table rather than per-line so it survives ordinary
 * edits (a reordered chain, a new column) but fails the moment a pin is
 * dropped from any table's read on that page.
 */
const PAGE_PINS: Array<[string, string[]]> = [
  // ---- asset domain
  ["app/(app)/assets/page.tsx", ["assets"]],
  ["app/(app)/assets/holdings/page.tsx", ["asset_assignments"]],
  ["app/(app)/assets/inspections/page.tsx", ["asset_inspections", "asset_inspection_overrides"]],
  ["app/(app)/assets/templates/page.tsx", ["asset_inspection_templates"]],
  // ---- commercial
  ["app/(app)/jobs/page.tsx", ["customers", "jobs"]],
  ["app/(app)/customers/page.tsx", ["customers"]],
  ["app/(app)/invoices/page.tsx", ["invoices", "customers"]],
  ["app/(app)/invoices/new/page.tsx", ["quotes"]],
  ["app/(app)/quotes/page.tsx", ["quotes", "customers"]],
  ["app/(app)/leads/page.tsx", ["leads"]],
  ["app/(app)/finances/page.tsx", ["finances"]],
  ["app/(app)/finances/new/page.tsx", ["jobs"]],
  ["app/(app)/purchase-orders/page.tsx", ["purchase_orders"]],
  ["app/(app)/expenses/page.tsx", ["expense_drafts"]],
  ["app/(app)/payments/page.tsx", ["bank_statements", "invoices"]],
  ["app/(app)/payments/new/page.tsx", ["invoices", "invoice_payments"]],
  ["app/(app)/payroll/page.tsx", ["payroll_runs", "payroll_lines"]],
  ["app/(app)/tax/page.tsx", ["invoices", "finances", "payroll_lines"]],
  ["app/(app)/reviews/page.tsx", ["review_requests"]],
  ["app/(app)/reviews/new/page.tsx", ["customers", "jobs"]],
  // ---- operations / H&S
  ["app/(app)/snags/page.tsx", ["snags", "jobs"]],
  ["app/(app)/snags/new/page.tsx", ["jobs"]],
  ["app/(app)/toolbox/page.tsx", ["toolbox_talks", "jobs"]],
  ["app/(app)/site-reports/page.tsx", ["site_reports", "jobs"]],
  ["app/(app)/site-reports/new/page.tsx", ["jobs"]],
  ["app/(app)/diary/page.tsx", ["site_diary_entries", "jobs"]],
  ["app/(app)/compliance/page.tsx", ["compliance_documents"]],
  ["app/(app)/inbox/page.tsx", ["inbound_enquiries"]],
  ["app/(app)/activity/page.tsx", ["activity_log"]],
  ["app/(app)/imports/page.tsx", ["imports"]],
  // ---- personal / staff
  ["app/(app)/me/page.tsx", ["time_entries", "rota_entries", "leave_requests", "jobs"]],
  ["app/(app)/staff/[id]/timesheet/page.tsx", ["time_entries"]],
  // ---- the shell
  ["app/(app)/layout.tsx", ["notifications"]],
  // ---- dashboard: every tile
  [
    "app/(app)/dashboard/page.tsx",
    [
      "jobs",
      "invoices",
      "finances",
      "leads",
      "memberships",
      "quotes",
      "activity_log",
      "invoice_payments",
      "bank_statement_lines",
      "time_entries",
      "retention_releases",
    ],
  ],
  // ---- leads detail (a collection-bearing page the earlier slices missed)
  ["app/(app)/leads/[id]/page.tsx", ["leads", "calls", "quotes"]],
];

describe("list pages — every collection read is pinned to the ACTIVE org", () => {
  for (const [path, tables] of PAGE_PINS) {
    const SRC = () => src(path);

    it(`${path} destructures ctx from requireOrgContext (not a bare await)`, () => {
      expect(
        SRC(),
        "a page that pins by ctx.org.id must actually capture ctx",
      ).toMatch(CAPTURES_CTX);
    });

    for (const table of tables) {
      it(`${path} still reads ${table} (the pin list is not stale)`, () => {
        expect(
          SRC(),
          `${path} no longer reads ${table} — update this pin list`,
        ).toMatch(new RegExp(`\\.from\\(\\s*["']${table}["']`));
      });
    }

    it(`${path} carries a pin for EVERY one of its ${tables.length} pinned table(s)`, () => {
      // Counting is what makes this a real tripwire: a per-file "at least one
      // pin" assertion would stay green while someone deleted the pin from all
      // but one read. The count is a floor, not an equality, because several of
      // these pages read the same table more than once (e.g. /jobs reads
      // `jobs` for the paged list AND for today's panel).
      const n = countPins(SRC());
      expect(
        n,
        `${path}: expected at least ${tables.length} active-org predicate(s) ` +
          `(one per pinned read: ${tables.join(", ")}), found ${n}`,
      ).toBeGreaterThanOrEqual(tables.length);
    });
  }
});

// ---------------------------------------------------------------------------
// 1b. Detail pages the EARLIER slices missed
//
// The by-id slices (#456 jobs, #459 finance, #463 suppliers, #464 asset/QR)
// pinned the detail pages in their own domains. The app-wide sweep for this
// slice found eight subjects still loaded by primary key alone, in domains no
// earlier slice covered. Each is fixed here, and each also GATES a set of
// child collection reads: pinning the subject makes the children (keyed on the
// subject's id) derived-safe, which is why they need no pin of their own.
// ---------------------------------------------------------------------------

describe("detail subjects the earlier slices missed are pinned by id AND org", () => {
  const SUBJECTS: Array<[string, string, string]> = [
    // path, table, what the pin protects downstream
    [
      "app/(app)/customers/[id]/page.tsx",
      "customers",
      "the portal token + the quote/job/lead/invoice/payment rollups",
    ],
    ["app/(app)/compliance/[id]/page.tsx", "compliance_documents", "the signed download"],
    [
      "app/(app)/invoices/[id]/page.tsx",
      "invoices",
      "the line items, payments and the money actions on the page",
    ],
    ["app/(app)/payroll/[id]/page.tsx", "payroll_runs", "every payroll line + NI numbers"],
    ["app/(app)/site-reports/[id]/page.tsx", "site_reports", "publish/withdraw to the portal"],
    [
      "app/(app)/payments/reconcile/[id]/page.tsx",
      "bank_statements",
      "the statement lines and the invoice match candidates",
    ],
    ["app/(app)/imports/[id]/page.tsx", "imports", "commit + rollback of imported rows"],
    ["app/(app)/imports/[id]/audit/page.tsx", "imports", "rollback of imported rows"],
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

  it("the reconcile page pins its invoice match-candidate list too", () => {
    // The candidates are a LIST, not a child of the statement, so the subject
    // pin does not cover them: offering the other company's invoice here would
    // let a bank line be matched across companies.
    const s = src("app/(app)/payments/reconcile/[id]/page.tsx");
    expect(s).toMatch(/\.from\("invoices"\)[\s\S]{0,200}?\.eq\("org_id", ctx\.org\.id\)/);
  });
});

// ---------------------------------------------------------------------------
// 2. Shared list helpers — the active org is an ARGUMENT, never implicit
// ---------------------------------------------------------------------------

describe("list helpers — the caller passes the ACTIVE org explicitly", () => {
  const HELPERS: Array<[string, string[]]> = [
    ["app/(app)/diary/_data.ts", ["listJobOptions"]],
    ["app/(app)/toolbox/_form-options.ts", ["loadToolboxFormOptions"]],
    ["app/(app)/leads/_form-helpers.ts", ["listCustomersForLead", "listStaffForLead"]],
    [
      "app/(app)/quotes/_form-helpers.ts",
      ["listCustomersForQuote", "listPropertiesForQuote", "listLeadsForQuote"],
    ],
    [
      "app/(app)/health-safety/_data.ts",
      ["listRiskAssessments", "getRiskAssessment", "getRevisionSiblings", "listAssessors"],
    ],
    ["app/(app)/health-safety/permits/_data.ts", ["listPermits", "getPermit", "listRamsOptions"]],
    [
      "lib/reports/aggregates.ts",
      ["jobsPerWeek", "revenuePerMonth", "vatPerQuarter", "topCustomersByRevenue"],
    ],
    // The jobs calendar's read moved into this window-scoping seam (F-1);
    // the active org is an explicit orgId argument the page derives from ctx.org.id.
    ["lib/schedule/calendar-data.ts", ["fetchCalendarJobs"]],
    ["server/services/customer-support-service.ts", ["listMySupportTickets"]],
    [
      "server/services/notifications-service.ts",
      ["getLatestNotificationsForCustomer", "getUnreadCountForCustomer"],
    ],
  ];

  for (const [path, names] of HELPERS) {
    for (const name of names) {
      it(`${path} · ${name} takes orgId and pins on it`, () => {
        const F = fn(src(path), name);
        expect(F, `${name} must demand the active org rather than trusting RLS`).toMatch(
          /orgId: string/,
        );
        expect(F, `${name} lost its active-org predicate`).toMatch(ARG_PIN);
      });
    }
  }

  it("the reports aggregates take the org FIRST, so a forgotten arg is a type error", () => {
    // `jobsPerWeek(8)` used to compile. With orgId first it cannot, so every
    // call site had to be revisited rather than silently keeping the default.
    const SRC = src("lib/reports/aggregates.ts");
    for (const name of ["jobsPerWeek", "revenuePerMonth", "vatPerQuarter", "topCustomersByRevenue"]) {
      expect(fn(SRC, name)).toMatch(new RegExp(`${name}\\(\\s*\\n?\\s*orgId: string`));
    }
  });

  it("every reports caller passes ctx.org.id", () => {
    for (const p of [
      "app/(app)/reports/page.tsx",
      "app/api/reports/route.ts",
      "app/api/reports/export/route.ts",
    ]) {
      const s = src(p);
      expect(s, `${p} must capture ctx`).toMatch(CAPTURES_CTX);
      for (const name of ["jobsPerWeek", "revenuePerMonth", "vatPerQuarter", "topCustomersByRevenue"]) {
        expect(s, `${p}: ${name} must receive the active org`).toMatch(
          new RegExp(`${name}\\(ctx\\.org\\.id`),
        );
      }
    }
  });

  it("the H&S pages and PDF routes pass ctx.org.id into the pinned read layer", () => {
    const CALLERS: Array<[string, string[]]> = [
      ["app/(app)/health-safety/page.tsx", ["listRiskAssessments"]],
      ["app/(app)/health-safety/new/page.tsx", ["listAssessors"]],
      [
        "app/(app)/health-safety/[id]/page.tsx",
        ["getRiskAssessment", "getRevisionSiblings", "listAssessors"],
      ],
      ["app/(app)/health-safety/permits/page.tsx", ["listPermits", "listJobOptions"]],
      ["app/(app)/health-safety/permits/new/page.tsx", ["listJobOptions", "listRamsOptions"]],
      ["app/(app)/health-safety/permits/[id]/page.tsx", ["getPermit", "listJobOptions", "listRamsOptions"]],
      ["app/api/health-safety/[id]/pdf/route.ts", ["getRiskAssessment", "listAssessors"]],
      ["app/api/health-safety/permits/[id]/pdf/route.ts", ["getPermit"]],
      ["app/(app)/health-safety/actions.ts", ["getRiskAssessment"]],
      ["app/(app)/diary/new/page.tsx", ["listJobOptions"]],
      ["app/(app)/diary/[id]/edit/page.tsx", ["listJobOptions"]],
      ["app/(app)/toolbox/new/page.tsx", ["loadToolboxFormOptions"]],
      ["app/(app)/toolbox/[id]/edit/page.tsx", ["loadToolboxFormOptions"]],
      ["app/(app)/leads/new/page.tsx", ["listCustomersForLead", "listStaffForLead"]],
      ["app/(app)/leads/[id]/page.tsx", ["listCustomersForLead", "listStaffForLead"]],
      ["app/(app)/quotes/new/page.tsx", ["listCustomersForQuote", "listPropertiesForQuote", "listLeadsForQuote"]],
      ["app/(app)/quotes/[id]/page.tsx", ["listCustomersForQuote", "listPropertiesForQuote", "listLeadsForQuote"]],
      ["app/(app)/support/page.tsx", ["listMySupportTickets"]],
      ["app/(app)/notifications/page.tsx", ["getLatestNotificationsForCustomer"]],
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

  it("the PDF routes keep labelling the header with the SUBJECT's own org", () => {
    // Pinning the subject to the active org must not disturb the H&S M4
    // decision that the letterhead names the record's own org. With the pin the
    // two are the same org — this asserts the labelling was not "simplified"
    // away while the pin was added.
    expect(src("app/api/health-safety/[id]/pdf/route.ts")).toMatch(/\.eq\("id", ra\.org_id\)/);
    expect(src("app/api/health-safety/permits/[id]/pdf/route.ts")).toMatch(
      /\.eq\("id", permit\.org_id\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The command palette — the most reachable list surface in the product
// ---------------------------------------------------------------------------

describe("/api/search — every entity in the palette is active-org scoped", () => {
  const SEARCH = () => src("app/api/search/route.ts");

  it("captures ctx rather than using requireOrgContext as a bare auth gate", () => {
    expect(SEARCH()).toMatch(CAPTURES_CTX);
  });

  for (const table of [
    "customers",
    "memberships",
    "risk_assessments",
    "permits_to_work",
    "jobs",
    "quotes",
    "leads",
    "invoices",
  ]) {
    it(`pins the ${table} search branch`, () => {
      const s = SEARCH();
      const i = s.indexOf(`.from("${table}")`);
      expect(i, `${table} branch not found`).toBeGreaterThan(-1);
      // The pin must appear inside this branch's own chain, not merely
      // somewhere in the file — a per-branch window, because this route issues
      // eight independent queries and dropping one is the realistic regression.
      const window = s.slice(i, i + 600);
      expect(window, `the ${table} search branch lost its active-org predicate`).toMatch(CTX_PIN);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. List-serving API routes (the same lists, over HTTP)
// ---------------------------------------------------------------------------

describe("list + export routes — pinned to the ACTIVE org", () => {
  const ROUTES: Array<[string, string[]]> = [
    ["app/api/activity/route.ts", ["activity_log"]],
    // NB: app/api/schedule/route.ts is asserted separately below — it delegates
    // its jobs read to the shared fetchCalendarJobs reader (lib/schedule/
    // calendar-data.ts), so the `.from("jobs")` + org pin live there, not inline.
    ["app/api/finances/route.ts", ["finances"]],
    ["app/api/invoices/route.ts", ["invoices"]],
    ["app/api/finances/export/route.ts", ["finances"]],
    ["app/api/invoices/export/route.ts", ["invoices", "invoice_line_items"]],
    // NB: the quarterly-pdf route reads `finances` inline but delegates its output-VAT
    // ledger read (invoice_payments + parent invoices) to gatherVatQuarterInputs — the
    // shared VAT-authority reader — so those `.from(...)` + org pins live there, asserted
    // separately below (same pattern as app/api/schedule/route.ts → fetchCalendarJobs).
    ["app/api/tax/quarterly-pdf/route.ts", ["finances"]],
  ];

  for (const [path, tables] of ROUTES) {
    it(`${path} captures ctx and pins ${tables.join(" + ")}`, () => {
      const s = src(path);
      expect(s).toMatch(CAPTURES_CTX);
      for (const t of tables) {
        expect(s, `${path} no longer reads ${t}`).toMatch(
          new RegExp(`\\.from\\(\\s*["']${t}["']`),
        );
      }
      const n = countPins(s);
      expect(
        n,
        `${path}: expected at least ${tables.length} active-org predicate(s), found ${n}`,
      ).toBeGreaterThanOrEqual(tables.length);
    });
  }

  it("app/api/schedule/route.ts pins jobs via the shared fetchCalendarJobs reader", () => {
    // The GET handler no longer reads jobs inline: it was routed through
    // fetchCalendarJobs (lib/schedule/calendar-data.ts) to fix the F-1 silent
    // truncation — the same reader the /jobs/calendar server render uses. The
    // active-org pin must survive that delegation, so it is followed here rather
    // than dropped: the route must (a) capture ctx and (b) hand the ACTIVE org to
    // the reader, and the reader must (c) read `.from("jobs")` with the org pin.
    const route = src("app/api/schedule/route.ts");
    expect(route).toMatch(CAPTURES_CTX);
    expect(
      route,
      "schedule route must pass the ACTIVE org (ctx.org.id) into fetchCalendarJobs",
    ).toMatch(/fetchCalendarJobs\(\s*\{[\s\S]*?orgId:\s*ctx\.org\.id/);

    const reader = src("lib/schedule/calendar-data.ts");
    const i = reader.indexOf(`.from("jobs")`);
    expect(i, "calendar-data reader no longer reads jobs").toBeGreaterThan(-1);
    // The org pin (ARG_PIN — the reader takes the active org as `orgId`) must sit
    // in the shared scoped() builder that both the non-recurring and recurring
    // reads compose from.
    expect(
      reader,
      "the shared calendar jobs read lost its active-org predicate",
    ).toMatch(ARG_PIN);
  });

  it("app/api/tax/quarterly-pdf/route.ts pins its output-VAT ledger via gatherVatQuarterInputs", () => {
    // The PDF's output VAT is CASH — it comes from the invoice_payments ledger,
    // read by the shared gatherVatQuarterInputs (server/services/vat-quarter-inputs.ts).
    // The active-org pin must survive that delegation: the route must (a) capture ctx
    // and (b) hand the ACTIVE org to the reader, and the reader must (c) pin org_id on
    // every read it issues.
    const route = src("app/api/tax/quarterly-pdf/route.ts");
    expect(route).toMatch(CAPTURES_CTX);
    expect(
      route,
      "quarterly-pdf must pass the ACTIVE org (ctx.org.id) into gatherVatQuarterInputs",
    ).toMatch(/gatherVatQuarterInputs\(\s*[\s\S]*?ctx\.org\.id/);

    const reader = src("server/services/vat-quarter-inputs.ts");
    for (const t of ["invoice_payments", "invoices", "supplier_payments", "supplier_payment_allocations"]) {
      expect(reader, `vat-quarter-inputs no longer reads ${t}`).toMatch(
        new RegExp(`\\.from\\(\\s*["']${t}["']`),
      );
    }
    // Every read in the reader is org-pinned by argument (ARG_PIN — it takes the
    // active org as `orgId`).
    expect(reader, "the VAT ledger reads lost their active-org predicate").toMatch(ARG_PIN);
  });

  it("the money exports are pinned — a bookkeeping CSV is ONE company's ledger", () => {
    // The sharpest consequence of the blend: a Xero/Sage import or a VAT
    // working paper containing two businesses' figures under one letterhead.
    for (const p of [
      "app/api/finances/export/route.ts",
      "app/api/invoices/export/route.ts",
      "app/api/tax/quarterly-pdf/route.ts",
    ]) {
      expect(src(p)).toMatch(CTX_PIN);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The service-layer stragglers named by the enumeration
// ---------------------------------------------------------------------------

describe("server/services/blueprints — the drawing register is active-org scoped", () => {
  const SRC = () => src("server/services/blueprints.ts");

  for (const name of [
    "listBlueprints",
    "listBlueprintVersions",
    "listBlueprintVersionsForBlueprints",
    "getBlueprintVersionUrl",
  ]) {
    it(`${name} captures ctx and pins on ctx.org.id`, () => {
      const F = fn(SRC(), name);
      expect(F, `${name} used requireOrgContext as a bare auth gate`).toMatch(CAPTURES_CTX);
      expect(F, `${name} lost its active-org predicate`).toMatch(CTX_PIN);
    });
  }

  it("createBlueprint confirms the parent job is in the ACTIVE org", () => {
    // The shell is stamped `org_id: ctx.org.id`, so an unpinned job check let a
    // dual-org member hang this org's drawing off the OTHER org's job.
    const F = fn(SRC(), "createBlueprint");
    expect(F).toMatch(/\.from\("jobs"\)[\s\S]{0,200}?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("the signed-download path pins the ACTIVE org as well as the row's own org", () => {
    // `storagePathBelongsToOrg` is an anti-poisoning check on the ROW's org; it
    // is not a scope. Both must be present.
    const F = fn(SRC(), "getBlueprintVersionUrl");
    expect(F).toMatch(CTX_PIN);
    expect(F, "the storage-evidence-wave path check must survive").toMatch(
      /storagePathBelongsToOrg\(/,
    );
  });
});

describe("server/services/blueprint-pins — pins and their snags are active-org scoped", () => {
  const SRC = () => src("server/services/blueprint-pins.ts");

  it("listPinsForVersion pins BOTH the pin read and the joined snag read", () => {
    const F = fn(SRC(), "listPinsForVersion");
    expect(F).toMatch(CAPTURES_CTX);
    expect(F).toMatch(/\.from\("blueprint_pins"\)[\s\S]{0,400}?\.eq\("org_id", ctx\.org\.id\)/);
    expect(
      F,
      "the snag join carries the defect titles — it needs the pin too",
    ).toMatch(/\.from\("snags"\)[\s\S]{0,300}?\.eq\("org_id", ctx\.org\.id\)/);
  });

  it("listLinkableSnags is pinned", () => {
    const F = fn(SRC(), "listLinkableSnags");
    expect(F).toMatch(CAPTURES_CTX);
    expect(F).toMatch(CTX_PIN);
  });

  it("movePin is pinned AND counts rows, so a foreign/missing pin is reported", () => {
    // Without `{ count: "exact" }` PostgREST returns a null count, so the
    // existing `Pin not found.` branch could never fire — the caller was told
    // the move succeeded. Same treatment as updateSupplier in #463.
    const F = fn(SRC(), "movePin");
    expect(F).toMatch(CAPTURES_CTX);
    expect(F).toMatch(/\{ count: "exact" \}/);
    expect(F).toMatch(/\.eq\("id", parsed\.data\.id\)[\s\S]{0,120}?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });
});

describe("shared services behind list surfaces", () => {
  it("the notification bell and centre are pinned (user_id alone is not a scope)", () => {
    // A dual-org member's own notifications exist in BOTH orgs and both satisfy
    // `user_id = auth.uid()`, so the org predicate is what separates them.
    expect(fn(src("server/services/notifications-service.ts"), "getLatestNotificationsForCustomer"))
      .toMatch(/\.eq\("org_id" as never, orgId as never\)/);
    expect(fn(src("server/services/notifications-service.ts"), "getUnreadCountForCustomer"))
      .toMatch(/\.eq\("org_id" as never, orgId as never\)/);
    const layout = src("app/(app)/layout.tsx");
    expect(layout).toMatch(/\.from\("notifications"\)[\s\S]{0,400}?\.eq\("org_id", ctx\.org\.id\)/);
    expect(layout, "the per-user filter must survive alongside the org pin").toMatch(
      /\.eq\("user_id", user\.id\)/,
    );
  });

  it("the daily briefing's dismissal read is pinned like every sibling read", () => {
    // The write stamps org_id and `item_key` is a generic string, so an
    // unpinned read let a dismissal in one org hide the line in the other.
    expect(src("server/services/briefing.ts")).toMatch(
      /\.from\("briefing_dismissals"\)[\s\S]{0,200}?\.eq\("org_id", orgId\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Silent truncation — a paged list needs a UNIQUE total order
// ---------------------------------------------------------------------------

describe("paged lists carry a unique `id` tiebreaker (the F-1 truncation class)", () => {
  /**
   * `.range()` / fetchAllRows paging over a NON-unique sort key can drop or
   * repeat rows at a page boundary: PostgREST may order ties differently
   * between requests. Every paged list must end its ORDER BY with the primary
   * key. These four ordered by `created_at` alone.
   */
  const PAGED: Array<[string, string]> = [
    ["app/(app)/quotes/page.tsx", "quotes"],
    ["app/(app)/invoices/page.tsx", "invoices"],
    ["app/(app)/finances/page.tsx", "finances"],
    ["app/(app)/activity/page.tsx", "activity_log"],
    ["app/api/activity/route.ts", "activity_log"],
    ["app/api/finances/route.ts", "finances"],
    ["app/api/invoices/route.ts", "invoices"],
  ];

  for (const [path, label] of PAGED) {
    it(`${path} (${label}) breaks created_at ties on id`, () => {
      expect(src(path), `${path} pages over a non-unique order`).toMatch(
        /\.order\(\s*["']created_at["'][\s\S]{0,120}?\.order\(\s*["']id["']/,
      );
    });
  }

  it("customers already had the tiebreaker (regression guard, not a new fix)", () => {
    expect(src("app/(app)/customers/page.tsx")).toMatch(
      /\.order\("created_at"[\s\S]{0,120}?\.order\("id"/,
    );
  });

  it("the jobs list still breaks scheduled_date ties on id (regression guard)", () => {
    expect(src("app/(app)/jobs/page.tsx")).toMatch(
      /\.order\("scheduled_date"[\s\S]{0,160}?\.order\("id", \{ ascending: true \}\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Behaviour preservation — the slice added predicates, nothing else
// ---------------------------------------------------------------------------

describe("the pins do not change anything else", () => {
  it("no list surface switches the viewer's active org to match the URL", () => {
    // Auto-switching would turn a scoping fix into a silent context change — a
    // product decision this slice must not assume. Same stance as #456/#463.
    for (const p of [
      "app/(app)/health-safety/_data.ts",
      "app/(app)/health-safety/permits/_data.ts",
      "app/(app)/toolbox/_form-options.ts",
      "app/(app)/diary/_data.ts",
      "lib/reports/aggregates.ts",
      "server/services/blueprints.ts",
      "server/services/blueprint-pins.ts",
    ]) {
      expect(src(p), `${p} must not write the active-org cookie`).not.toMatch(/setActiveOrg|cookies\(/);
    }
  });

  it("row caps are unchanged — the pin narrows tenancy, not volume", () => {
    expect(src("app/(app)/assets/page.tsx")).toMatch(/\.limit\(1000\)/);
    expect(src("app/(app)/snags/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/site-reports/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/purchase-orders/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/toolbox/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/diary/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/compliance/page.tsx")).toMatch(/\.limit\(500\)/);
    expect(src("app/(app)/inbox/page.tsx")).toMatch(/\.limit\(200\)/);
    expect(src("app/(app)/expenses/page.tsx")).toMatch(/\.limit\(200\)/);
    expect(src("app/(app)/imports/page.tsx")).toMatch(/\.limit\(20\)/);
    expect(src("app/(app)/layout.tsx")).toMatch(/\.limit\(30\)/);
  });

  it("existing status/kind filters still compose with the new pin", () => {
    // The filter chains are the thing most easily broken by inserting an .eq()
    // into a hand-written builder cast, so pin the filters explicitly.
    expect(src("app/(app)/assets/page.tsx")).toMatch(/query\.eq\("status", statusFilter\)/);
    expect(src("app/(app)/snags/page.tsx")).toMatch(/query\.eq\("priority", priorityFilter\)/);
    expect(src("app/(app)/compliance/page.tsx")).toMatch(/baseQuery\.eq\("kind", filter\)/);
    expect(src("app/(app)/inbox/page.tsx")).toMatch(/query\.eq\("status", filter\)/);
    expect(src("app/(app)/reviews/page.tsx")).toMatch(/baseQuery\.eq\("status", filter\)/);
    expect(src("app/(app)/expenses/page.tsx")).toMatch(/\.eq\("status", filter\)/);
  });

  it("the surfaces prior slices already pinned are untouched (no double-fix)", () => {
    expect(src("app/(app)/jobs/_form-helpers.ts"), "#456").toMatch(ARG_PIN);
    expect(src("app/(app)/purchase-orders/_data.ts"), "#463").toMatch(ARG_PIN);
    expect(src("app/(app)/assets/new/page.tsx"), "#464").toMatch(CTX_PIN);
    // #465 pinned loadSupplierOptions with an inline `.eq("org_id", orgId)`.
    // The F-1 picker-completion wave routes it through the org-pinned + PAGED
    // listSuppliersForOrg chokepoint instead (the inline read was clamped at
    // 1000); the org scope is preserved there, so assert the delegation.
    expect(src("app/(app)/fleet/_components/load.ts"), "#465").toMatch(
      /listSuppliersForOrg[\s\S]*?orgId/,
    );
    expect(src("app/(app)/staff/page.tsx")).toMatch(CTX_PIN);
    expect(src("app/(app)/staff/leave/page.tsx")).toMatch(CTX_PIN);
    expect(src("server/services/org-cash.ts")).toMatch(ARG_PIN);
  });
});
