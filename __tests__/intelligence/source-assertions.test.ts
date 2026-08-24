import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * COMPANY SIGNALS — source assertions: active-org pinning, loud reads,
 * read-only, bounded total orders, and the composite-score ratchet.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * RLS is not scoping: `current_org_ids()` admits EVERY org the viewer belongs
 * to, so one unpinned read on this surface presents one company's utilisation,
 * concentration, debt or snag record as the other's. The service is therefore
 * EXECUTED against a chainable mock that HONOURS the filters it is given,
 * seeded with two orgs whose records deliberately collide (same customer id,
 * the same worker rostered in both books) — if any pin were dropped, the org-B
 * rows would surface in org A's signals and the exact-number assertions fail.
 * The source pins are the tripwire on top of that (the aged-ledgers doctrine).
 *
 * ── THE RATCHET ──────────────────────────────────────────────────────────────
 * lib/intelligence/** must never grow an opaque composite score. The grep at
 * the bottom is the negative ratchet: a PR that adds `overallScore` /
 * `healthScore` / `compositeScore` to this layer goes red here first, and the
 * reviewer starts from lib/suppliers/performance.ts header points 1–2.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// The chainable mock — honours eq / in / is / gte / lte, as Postgres would
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  type Rec = {
    table: string;
    eqs: Array<[string, unknown]>;
    ins: Array<[string, readonly unknown[]]>;
  };
  const reads: Rec[] = [];
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const failing = new Set<string>();

  function makeBuilder(table: string) {
    const rec: Rec = { table, eqs: [], ins: [] };
    reads.push(rec);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    // The one place the filtered result is materialised, shared by `.range(...)`
    // (the paged gathers) AND the thenable form (server/services/
    // supplier-performance's `.limit()` chains, which `await` the builder
    // directly). Both must honour the SAME eq/in filters, or a dropped org pin
    // would surface through whichever path a group happens to use.
    const settle = () => {
      if (failing.has(table)) {
        return { data: null, error: { message: `${table} exploded` } };
      }
      const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      return { data: rows, error: null };
    };
    const builder = {
      select: () => builder,
      eq(col: string, val: unknown) {
        rec.eqs.push([col, val]);
        filters.push((row) => row[col] === val);
        return builder;
      },
      in(col: string, vals: readonly unknown[]) {
        rec.ins.push([col, vals]);
        filters.push((row) => vals.includes(row[col]));
        return builder;
      },
      is(col: string, val: unknown) {
        filters.push((row) => (val === null ? row[col] == null : row[col] === val));
        return builder;
      },
      gte(col: string, val: unknown) {
        filters.push((row) => String(row[col]) >= String(val));
        return builder;
      },
      lte(col: string, val: unknown) {
        filters.push((row) => String(row[col]) <= String(val));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      range: () => Promise.resolve(settle()),
      // Thenable: `await builder` resolves to the filtered { data, error }.
      then<R>(
        onF: (v: { data: unknown[] | null; error: { message: string } | null }) => R,
        onR?: (e: unknown) => R,
      ) {
        return Promise.resolve(settle()).then(onF, onR);
      },
    };
    return builder;
  }

  return {
    reads,
    tables,
    failing,
    client: { from: (t: string) => makeBuilder(t) },
    reported: [] as string[],
    // Composed whole-service seams, controllable per test.
    progress: {
      calls: [] as Array<{ orgId: string; jobIds: readonly string[] }>,
      failed: false,
    },
    fulfilment: { lineIds: [] as string[][], pending: false },
    ledgers: {
      calls: [] as Array<{ orgId: string; role: string }>,
      retentionLoadError: false,
      agedLoadError: false,
    },
    reset() {
      reads.length = 0;
      for (const k of Object.keys(tables)) delete tables[k];
      failing.clear();
      this.reported.length = 0;
      this.progress.calls.length = 0;
      this.progress.failed = false;
      this.fulfilment.lineIds.length = 0;
      this.fulfilment.pending = false;
      this.ledgers.calls.length = 0;
      this.ledgers.retentionLoadError = false;
      this.ledgers.agedLoadError = false;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));

// Keep readFailure's real behaviour (throwable, described) without dragging
// Sentry into the unit run; record every panel-scoped report for assertions.
vi.mock("@/lib/supabase/read-failure", () => ({
  readFailure: (context: string, error: { message?: string | null }) =>
    new Error(`${context} read failed: ${error.message ?? "unknown error"}`),
  reportReadFailure: (context: string) => {
    h.reported.push(context);
  },
}));

// The composed whole services own their own org-pin proofs
// (__tests__/security/retention-register-org-scope.test.ts,
// aged-ledgers-org-scope.test.ts, job-progress and fulfilment suites). Here
// they are seams: the assertions are that intelligence.ts passes the ACTIVE
// org, the debtors-only role, and honours their failure flags.
vi.mock("@/server/services/job-progress", () => ({
  loadProgressForJobs: async (_db: unknown, orgId: string, jobIds: readonly string[]) => {
    h.progress.calls.push({ orgId, jobIds });
    return { byJob: new Map(), failed: h.progress.failed };
  },
}));

vi.mock("@/server/services/material-fulfilment", () => ({
  readIssuedForLines: async (_db: unknown, _orgId: string, lineIds: string[]) => {
    h.fulfilment.lineIds.push(lineIds);
    return { issued: [], stockModulePending: h.fulfilment.pending };
  },
}));

const RETENTION_TOTALS = {
  accrued: 500,
  released: 100,
  held: 400,
  outstandingByState: { overdue: 50, due: 150, held: 200, awaiting_completion: 0, released: 0 },
  lineCountByState: { overdue: 1, due: 1, held: 2, awaiting_completion: 0, released: 1 },
  jobCount: 2,
  jobsHoldingCount: 2,
  jobsOverdueCount: 1,
};
const DEBTOR_TOTALS = {
  buckets: { current: 100, d1_30: 50, d31_60: 0, d61_90: 0, d91_plus: 25 },
  total: 175,
  pastDue: 75,
  itemCount: 3,
  partyCount: 2,
  undated: 0,
};

vi.mock("@/server/services/retention-register", () => ({
  buildRetentionRegisterView: async () => ({
    loadError: h.ledgers.retentionLoadError,
    register: { totals: RETENTION_TOTALS },
  }),
}));

vi.mock("@/server/services/aged-ledgers", () => ({
  buildAgedLedgers: async (orgId: string, role: string) => {
    h.ledgers.calls.push({ orgId, role });
    return { loadError: h.ledgers.agedLoadError, debtors: { totals: DEBTOR_TOTALS } };
  },
}));

const { loadCompanySignals } = await import("@/server/services/intelligence");

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";
// The BST month-end instant every intelligence fixture pins: UTC still 31 July,
// London already 1 August — the exact split a UTC-keyed window gets wrong.
const NOW = new Date("2026-07-31T23:30:00Z");

/**
 * Two companies whose records deliberately COLLIDE: the same customer id
 * invoiced by both, the same worker rostered and clocked in both, snags in
 * both. Without the collisions, a dropped pin would still produce
 * separate-looking rows and pass.
 */
function seedTwoOrgs() {
  h.tables.jobs = [
    { id: "job-a1", org_id: ORG_A, status: "in-progress", customer_id: "cust-shared", site_address_line1: "1 High St", site_city: "Leeds", site_postcode: "LS1 1AA" },
    { id: "job-b1", org_id: ORG_B, status: "in-progress", customer_id: "cust-shared", site_address_line1: "9 Low Rd", site_city: "York", site_postcode: "YO1 1AA" },
  ];
  h.tables.memberships = [
    { org_id: ORG_A, user_id: "user-a" },
    { org_id: ORG_B, user_id: "user-b" },
  ];
  // GLOBAL tables — no org_id column; reachable only via the membership ids.
  h.tables.users = [
    { id: "user-a", full_name: "Alice" },
    { id: "user-b", full_name: "Bob" },
  ];
  // Pay moved to staff_compensation (20261218, self-or-admin RLS). Also a global
  // table scoped by member ids — same documented exception as users.
  h.tables.staff_compensation = [
    { user_id: "user-a", hourly_pay: 20 },
    { user_id: "user-b", hourly_pay: 30 },
  ];
  h.tables.rota_entries = [
    // Org A: one 8-hour shift for Alice (meets the coverage sample floor).
    { id: "rota-a1", org_id: ORG_A, user_id: "user-a", job_id: "job-a1", starts_at: "2026-07-30T08:00:00.000Z", ends_at: "2026-07-30T16:00:00.000Z" },
    // Org B rosters THE SAME worker: leaks would double Alice's rostered hours.
    { id: "rota-b1", org_id: ORG_B, user_id: "user-a", job_id: "job-b1", starts_at: "2026-07-29T08:00:00.000Z", ends_at: "2026-07-29T16:00:00.000Z" },
  ];
  h.tables.time_entries = [
    // Org A: Alice clocked 6 of the 8 rostered hours.
    { id: "te-a1", org_id: ORG_A, user_id: "user-a", job_id: "job-a1", started_at: "2026-07-30T08:00:00.000Z", ended_at: "2026-07-30T14:00:00.000Z", breaks: [] },
    // Org B time for the same worker — must never count in org A's book.
    { id: "te-b1", org_id: ORG_B, user_id: "user-a", job_id: "job-b1", started_at: "2026-07-29T08:00:00.000Z", ended_at: "2026-07-29T12:00:00.000Z", breaks: [] },
  ];
  h.tables.invoices = [
    // Org A: £100 to the shared customer, inside the 12-month window.
    { id: "inv-a1", org_id: ORG_A, status: "sent", amount: 100, total: 120, customer_id: "cust-shared", job_id: null, created_at: "2026-07-10T10:00:00.000Z" },
    // Org B: £9,000 to the SAME customer id — either leaking swamps org A.
    { id: "inv-b1", org_id: ORG_B, status: "sent", amount: 9000, total: 10800, customer_id: "cust-shared", job_id: null, created_at: "2026-07-10T10:00:00.000Z" },
  ];
  h.tables.customers = [
    { id: "cust-shared", org_id: ORG_A, name: "Shared Developments (A)" },
    { id: "cust-shared", org_id: ORG_B, name: "Shared Developments (B)" },
  ];
  h.tables.job_budgets = [
    { id: "jb-a1", org_id: ORG_A, job_id: "job-a1", revision: 1, total_cost: 1000, labour_cost: 400, materials_cost: 400, subcontractors_cost: 100, misc_cost: 100, target_margin_pct: 20, note: null, created_at: "2026-06-01T00:00:00.000Z", superseded_at: null },
    { id: "jb-b1", org_id: ORG_B, job_id: "job-b1", revision: 1, total_cost: 5000, labour_cost: 2000, materials_cost: 2000, subcontractors_cost: 500, misc_cost: 500, target_margin_pct: 20, note: null, created_at: "2026-06-01T00:00:00.000Z", superseded_at: null },
  ];
  h.tables.quotes = [];
  // Suppliers — the SAME merchant account in both orgs (merchants are shared
  // between an owner's two companies), so a dropped pin blends their records.
  h.tables.suppliers = [
    { id: "sup-shared", org_id: ORG_A, name: "Shared Merchant (A)" },
    { id: "sup-shared", org_id: ORG_B, name: "Shared Merchant (B)" },
  ];
  // Supplier POs/bills/GRNs carry job_id null so they never enter the CVR
  // rollup (which reads finances/POs by budgeted job id); they exist only to
  // give the supplier-performance rollup something to measure.
  h.tables.purchase_orders = [
    { id: "po-a1", org_id: ORG_A, supplier_id: "sup-shared", number: "PO-A1", status: "received", expected_date: "2026-07-01", total: 1000, job_id: null },
    { id: "po-b1", org_id: ORG_B, supplier_id: "sup-shared", number: "PO-B1", status: "received", expected_date: "2026-07-01", total: 5000, job_id: null },
  ];
  h.tables.finances = [
    // Org A: £1,200 billed against a £1,000 order → £200 over the order.
    { id: "bill-a1", org_id: ORG_A, supplier_id: "sup-shared", purchase_order_id: "po-a1", amount: 1200, vat_total: 0, reference: null, bill_date: "2026-07-05", category: "materials", job_id: null, created_at: "2026-07-05T10:00:00.000Z" },
    // Org B: a clean bill on the SAME merchant id — must never reach org A's £.
    { id: "bill-b1", org_id: ORG_B, supplier_id: "sup-shared", purchase_order_id: "po-b1", amount: 100, vat_total: 0, reference: null, bill_date: "2026-07-05", category: "materials", job_id: null, created_at: "2026-07-05T10:00:00.000Z" },
  ];
  h.tables.goods_received_notes = [
    // Org A: delivered 9 days after the promised date → LATE.
    { id: "grn-a1", org_id: ORG_A, purchase_order_id: "po-a1", status: "posted", number: "GRN-A1", delivery_date: "2026-07-10" },
    // Org B: delivered ON TIME on the same merchant — leaking flips org A's rate.
    { id: "grn-b1", org_id: ORG_B, purchase_order_id: "po-b1", status: "posted", number: "GRN-B1", delivery_date: "2026-07-01" },
  ];
  h.tables.material_requests = [
    { id: "mr-a1", org_id: ORG_A, status: "approved", needed_by: "2026-07-20", job_id: "job-a1" },
    { id: "mr-b1", org_id: ORG_B, status: "approved", needed_by: "2026-07-20", job_id: "job-b1" },
  ];
  h.tables.material_request_lines = [
    { id: "ml-a1", org_id: ORG_A, material_request_id: "mr-a1", description: "Bricks", qty: 100, unit: "pcs", stock_item_id: null },
    { id: "ml-b1", org_id: ORG_B, material_request_id: "mr-b1", description: "Blocks", qty: 400, unit: "pcs", stock_item_id: null },
  ];
  h.tables.snags = [
    { id: "sn-a1", org_id: ORG_A, job_id: "job-a1", trade: "Electrical", status: "open", priority: "medium", due_date: null },
    { id: "sn-b1", org_id: ORG_B, job_id: "job-b1", trade: "Electrical", status: "open", priority: "medium", due_date: null },
    { id: "sn-b2", org_id: ORG_B, job_id: "job-b1", trade: "Plumbing", status: "open", priority: "high", due_date: null },
  ];
  // Programme variance: current baselines whose planned end is in the past, one
  // overdue milestone each, and a recorded delay in each org. Org B's 100-day
  // claim must never surface in org A's exposure.
  h.tables.job_programme_baselines = [
    { id: "bl-a1", org_id: ORG_A, job_id: "job-a1", revision: 1, planned_start: "2026-01-01", planned_end: "2026-07-01", superseded_at: null },
    { id: "bl-b1", org_id: ORG_B, job_id: "job-b1", revision: 1, planned_start: "2026-01-01", planned_end: "2026-07-01", superseded_at: null },
  ];
  h.tables.job_milestones = [
    { id: "ms-a1", org_id: ORG_A, baseline_id: "bl-a1", planned_end: "2026-07-15" },
    { id: "ms-b1", org_id: ORG_B, baseline_id: "bl-b1", planned_end: "2026-07-15" },
  ];
  h.tables.delay_events = [
    { id: "de-a1", org_id: ORG_A, job_id: "job-a1", status: "recorded", working_days_lost: 3, variation_quote_id: null },
    { id: "de-b1", org_id: ORG_B, job_id: "job-b1", status: "recorded", working_days_lost: 100, variation_quote_id: null },
  ];
}

beforeEach(() => {
  h.reset();
  seedTwoOrgs();
});

// ---------------------------------------------------------------------------
// 1. behavioural — every read is pinned to the active org
// ---------------------------------------------------------------------------

describe("dual-org: every table read is pinned to the active org", () => {
  it("EVERY read except the global users profile carries org_id = the active org", async () => {
    await loadCompanySignals(ORG_A, NOW);
    // One full render issues at least the jobs read + 4 utilisation reads +
    // 2 concentration reads + 5 CVR reads + 2 materials reads + 1 snags read.
    expect(h.reads.length).toBeGreaterThanOrEqual(14);
    for (const r of h.reads) {
      // users + staff_compensation are the documented GLOBAL tables (no org_id) —
      // asserted separately below; every other read must pin org_id.
      if (r.table === "users" || r.table === "staff_compensation") continue;
      const orgEq = r.eqs.find(([c]) => c === "org_id");
      expect(orgEq, `${r.table} read is not org-pinned`).toBeDefined();
      expect(orgEq?.[1], `${r.table} read is pinned to the wrong org`).toBe(ORG_A);
    }
  });

  it("every global-table read (users + staff_compensation) is scoped by this org's membership ids", async () => {
    await loadCompanySignals(ORG_A, NOW);
    // users (names) is read via .in('id', memberIds); staff_compensation (pay,
    // 20261218) via .in('user_id', memberIds). BOTH are reached ONLY through this
    // org's membership ids — never a raw table scan, never another org's worker.
    const usersReads = h.reads.filter((r) => r.table === "users");
    // Exact pins (restored): the split read is users(id, full_name) ×1 and
    // staff_compensation(user_id, hourly_pay) ×2 (cvr pay + utilisation). If a
    // read is added/removed, update deliberately — don't relax to a range.
    expect(usersReads.length).toBe(1);
    for (const ur of usersReads) {
      const idIn = ur.ins.find(([c]) => c === "id");
      expect(idIn, "users must be reached through .in('id', memberIds)").toBeDefined();
      expect(idIn?.[1]).toEqual(["user-a"]); // org A's members only — never Bob
    }
    const compReads = h.reads.filter((r) => r.table === "staff_compensation");
    expect(compReads.length).toBe(2);
    for (const cr of compReads) {
      const idIn = cr.ins.find(([c]) => c === "user_id");
      expect(idIn, "staff_compensation must be reached through .in('user_id', memberIds)").toBeDefined();
      expect(idIn?.[1]).toEqual(["user-a"]); // org A's members only — never Bob
    }
  });

  it("utilisation counts ONLY org A's rota and clock, though org B rosters the same worker", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.utilisation.failed).toBe(false);
    const t = view.utilisation.data!.totals;
    // 8h rostered / 6h clocked in org A. Org B's 8h shift and 4h clock for the
    // SAME user id must be absent — either leaking changes these numbers.
    expect(t.rosteredHours).toBe(8);
    expect(t.recordedHours).toBe(6);
    expect(t.coverage.pct).toBe(75);
    expect(t.labourCost).toBe(120); // 6h × Alice's £20; Bob's £30 never enters
  });

  it("concentration sees ONLY org A's £100 to the shared customer, under org A's name", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.concentration.failed).toBe(false);
    const c = view.concentration.data!;
    expect(c.totalRevenue).toBe(100); // org B's £9,000 to the same id is absent
    expect(c.invoiceCount).toBe(1);
    expect(c.top[0]?.name).toBe("Shared Developments (A)");
  });

  it("snag patterns count org A's one snag, not the blended three", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.snags.failed).toBe(false);
    expect(view.snags.data!.total).toBe(1);
  });

  it("the progress rollup is asked about org A's active jobs only", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.progress.failed).toBe(false);
    expect(h.progress.calls).toEqual([{ orgId: ORG_A, jobIds: ["job-a1"] }]);
    expect(view.progress.data!.rollup.activeJobs).toBe(1);
  });

  it("programme variance sees org A's live baseline and delay only — org B's 100-day claim never leaks", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.programmeVariance.failed).toBe(false);
    const r = view.programmeVariance.data!.rollup;
    expect(r.jobsConsidered).toBe(1); // job-a1 only (in-progress = live)
    expect(r.jobsWithBaseline).toBe(1);
    expect(r.behindBaseline.map((j) => j.jobId)).toEqual(["job-a1"]);
    expect(r.overdueMilestoneCount).toBe(1);
    // Org A's single recorded 3-day claim — never the blended 103.
    expect(r.recordedDelayEventCount).toBe(1);
    expect(r.openEotWorkingDaysLost).toBe(3);
  });

  it("the CVR rollup budgets org A's job only", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.cvr.failed).toBe(false);
    expect(view.cvr.data!.jobsWithBudget).toBe(1);
    expect(view.cvr.data!.lines.map((l) => l.jobId)).toEqual(["job-a1"]);
  });

  it("the fulfilment seam receives org A's line ids only", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.materials.failed).toBe(false);
    expect(h.fulfilment.lineIds).toEqual([["ml-a1"]]);
    expect(view.materials.data!.openRequestCount).toBe(1);
  });

  it("the exposure ledgers are composed debtors-only (role 'staff' skips payables)", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.exposure.failed).toBe(false);
    expect(h.ledgers.calls).toEqual([{ orgId: ORG_A, role: "staff" }]);
  });

  it("supplier performance measures ONLY org A's trading history on the shared merchant", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.supplierPerformance.failed).toBe(false);
    const r = view.supplierPerformance.data!;
    // Org B's row on the SAME merchant id is absent — the pin, not RLS, is what
    // stops one merchant's two-company history collapsing into one record.
    expect(r.suppliersConsidered).toBe(1);
    expect(r.suppliersWithRecord).toBe(1);
    // Org A's late delivery counts; org B's on-time delivery on the same
    // merchant must NOT — a leak would make judgeable = 2, on-time 1.
    expect(r.orgPunctuality.count).toBe(1);
    expect(r.orgPunctuality.n).toBe(1);
    // Org A's £200 over-invoice, never org B's clean bill.
    expect(r.overBilledExcessTotal).toBe(200);
  });

  it("the rendered day is the LONDON day; the date-column stamp is the invoice authority's", async () => {
    const view = await loadCompanySignals(ORG_A, NOW);
    // 23:30Z on 31 July is already 1 August in London — the display day.
    expect(view.todayKey).toBe("2026-08-01");
    // asAtIso reuses invoiceBusinessToday (UTC ISO day) for INVOICE/snag date
    // columns — matching each surface's own convention is the rule, not one
    // global "today": snag pages compare with the UTC slice, so snags use
    // asAtIso; /materials/requests compares with formatDayKeyUK, so material
    // demand is fed todayKey (the London day) — see the gather call. Feeding
    // materials the UTC day made this count disagree with its own
    // drill-through page for an hour every BST night (adversarial P2).
    expect(view.asAtIso).toBe("2026-07-31");
  });
});

// ---------------------------------------------------------------------------
// 2. behavioural — loud reads, per group
// ---------------------------------------------------------------------------

describe("loud reads — a failed group fails WHOLE and says so; the rest stand", () => {
  it("a failed snags read fails ONLY the snags group, and reports it", async () => {
    h.failing.add("snags");
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.snags.failed).toBe(true);
    expect(view.snags.data).toBeNull(); // never an empty-but-plausible metric
    expect(view.utilisation.failed).toBe(false);
    expect(view.concentration.failed).toBe(false);
    expect(view.cvr.failed).toBe(false);
    expect(h.reported.some((c) => c.includes("snag"))).toBe(true);
  });

  it("a failed time-entries page fails utilisation whole — a partial ledger is a wrong ratio", async () => {
    h.failing.add("time_entries");
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.utilisation.failed).toBe(true);
    expect(view.snags.failed).toBe(false);
  });

  it("a failed SHARED jobs read fails every group built on it, and only those", async () => {
    h.failing.add("jobs");
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.concentration.failed).toBe(true);
    expect(view.progress.failed).toBe(true);
    expect(view.programmeVariance.failed).toBe(true);
    expect(view.cvr.failed).toBe(true);
    expect(view.snags.failed).toBe(true);
    // These do not depend on the jobs read and must still stand.
    expect(view.utilisation.failed).toBe(false);
    expect(view.materials.failed).toBe(false);
    expect(view.exposure.failed).toBe(false);
  });

  it("a progress-series failure fails the progress group", async () => {
    h.progress.failed = true;
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.progress.failed).toBe(true);
  });

  it("an errored aged ledger fails exposure — it must never render as £0 outstanding", async () => {
    h.ledgers.agedLoadError = true;
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.exposure.failed).toBe(true);
  });

  it("an errored retention register fails exposure the same way", async () => {
    h.ledgers.retentionLoadError = true;
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.exposure.failed).toBe(true);
  });

  it("a stock seam outage is NOT a failure — it is the disclosed unmeasurable state", async () => {
    h.fulfilment.pending = true;
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.materials.failed).toBe(false);
    expect(view.materials.data!.measurable).toBe(false);
  });

  it("a failed suppliers read fails ONLY the supplier-performance group", async () => {
    h.failing.add("suppliers");
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.supplierPerformance.failed).toBe(true);
    expect(view.supplierPerformance.data).toBeNull();
    expect(view.utilisation.failed).toBe(false);
    expect(view.concentration.failed).toBe(false);
    expect(view.snags.failed).toBe(false);
    expect(h.reported.some((c) => c.includes("supplier performance"))).toBe(true);
  });

  it("a failed supplier-bills read fails supplier performance whole (a partial ledger is a wrong record)", async () => {
    h.failing.add("finances");
    const view = await loadCompanySignals(ORG_A, NOW);
    expect(view.supplierPerformance.failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. source pins
// ---------------------------------------------------------------------------

const SERVICE = src("server/services/intelligence.ts");

/** Every `.from("x") … .range(` chain in the service, table + chain body. */
const FROM_BLOCKS = [...SERVICE.matchAll(/\.from\("([a-z_]+)"\)([\s\S]*?)\.range\(/g)].map(
  (m) => ({ table: m[1]!, chain: m[2]! }),
);

describe("source pins — the read layer is read-only and pinned", () => {
  it("the service never mutates anything", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(SERVICE, `intelligence must not ${op}`).not.toContain(op);
    }
  });

  it("every query chain except the global users read pins org_id in source", () => {
    expect(FROM_BLOCKS.length).toBeGreaterThanOrEqual(15);
    for (const { table, chain } of FROM_BLOCKS) {
      if (table === "users") {
        expect(chain, "users must be scoped by membership ids").toContain('.in("id", memberIds)');
        continue;
      }
      if (table === "staff_compensation") {
        // Global pay table (20261218) — scoped by member ids, never org-pinned.
        expect(chain, "staff_compensation must be scoped by membership ids").toContain(
          '.in("user_id", memberIds)',
        );
        continue;
      }
      expect(chain, `${table} chain must pin org_id`).toContain('.eq("org_id", orgId)');
    }
  });

  it("every query chain keeps a unique total order across page boundaries", () => {
    for (const { table, chain } of FROM_BLOCKS) {
      // `id` everywhere; memberships orders by user_id, unique per org by the
      // (org_id, user_id) constraint — a total order once org_id is pinned.
      expect(chain, `${table} chain needs a unique ORDER BY tiebreaker`).toMatch(
        /\.order\("(id|user_id)"/,
      );
    }
  });

  it("every read pages through the loud allRows wrapper (fetchAllRows + readFailure)", () => {
    const calls = (SERVICE.match(/allRows\(/g) ?? []).length;
    // ≥ 15 call sites + the wrapper's own definition.
    expect(calls).toBeGreaterThanOrEqual(16);
    expect(SERVICE).toContain("fetchAllRows<Row>");
    expect(SERVICE).toContain("throw readFailure(");
    expect(SERVICE).toContain("reportReadFailure(");
  });

  it("group failures are caught per group, never page-wide", () => {
    const groups = (SERVICE.match(/group\("intelligence: /g) ?? []).length;
    expect(groups).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 4. the composite-score ratchet
// ---------------------------------------------------------------------------

describe("the composite-score ratchet", () => {
  it("no module in lib/intelligence carries an overall/health/composite score", () => {
    const dir = resolve(ROOT, "lib", "intelligence");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(9); // the ratchet sweeps them all
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), "utf8");
      expect(text, `${f} must not define a composite score`).not.toMatch(
        /overallScore|healthScore|compositeScore|weightedScore/,
      );
    }
  });

  it("the kind ladder in source names no generative kind", () => {
    const prov = src("lib/intelligence/provenance.ts");
    expect(prov).toMatch(/\["fact", "derived", "heuristic"\] as const/);
  });
});
