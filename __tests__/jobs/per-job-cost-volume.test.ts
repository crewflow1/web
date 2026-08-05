import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * PER-JOB PAGES — no silent 1000-row cost truncation (F-1, C35b).
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────
 * Supabase/PostgREST caps every response at the project "Max rows" setting
 * (1000). The per-job pages read a job's `finances` (its cost) with a BARE
 * `.select().eq("job_id", …)` — no `.range()` — so the moment a job crosses
 * 1000 finance postings the read is SILENTLY TRUNCATED: cost is under-stated,
 * profit / margin / budget over-stated, with no error. The fix routes every
 * job-scoped set read through `fetchAllRows`, which pages under the cap.
 *
 * ── WHY THIS TEST IS BEHAVIOURAL, NOT A SOURCE GREP ──────────────────────────
 * Both page components are EXECUTED against a chainable Supabase mock that caps
 * each response at 1000 rows exactly the way PostgREST does. The job is seeded
 * with 1500 finance postings. `computeJobProfitability` is spied (its real
 * implementation kept) so we can read the `costs_total` each page computed. If
 * the finance read dropped its `.range()` (or fetched a single page), the mock
 * would clip the response at 1000 and the computed cost would come up a third
 * short. Because the mock caps like the real cap, only a correctly paged read
 * can see all 1500 rows.
 *
 * ── HERMETIC ─────────────────────────────────────────────────────────────────
 * No real Supabase client is ever constructed (Node CI has no native WebSocket,
 * so a real realtime client would throw). `createClient` and every page
 * collaborator (auth, job loader, child sections, forms) are mocked to pure
 * in-memory fakes / inert components; only the money maths runs for real.
 */

const RESPONSE_CAP = 1000; // the PostgREST max-rows cap the mock emulates
const N_FINANCES = 1500; // > cap, so a single page loses a third of the cost
const COST_EACH = 10;
const JOB = "job-under-test";
const OTHER_JOB = "job-elsewhere";
const ORG = "org-under-test";

// ── the cap-emulating Supabase mock ──────────────────────────────────────────
const h = vi.hoisted(() => {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const cap = { rows: 1000 };

  function makeBuilder(table: string) {
    const eqs: Array<[string, unknown]> = [];
    const ins: Array<[string, unknown[]]> = [];
    // null predicates: wantNull=true for `.is(col,null)`, false for `.not(col,"is",null)`.
    const nulls: Array<{ col: string; wantNull: boolean }> = [];
    const orders: Array<[string, boolean]> = [];

    const filtered = () => {
      let rows = (tables[table] ?? []).filter((row) => {
        for (const [c, v] of eqs) if (row[c] !== v) return false;
        for (const [c, vals] of ins) if (!vals.includes(row[c])) return false;
        for (const { col, wantNull } of nulls) {
          const isNull = row[col] === null || row[col] === undefined;
          if (wantNull !== isNull) return false;
        }
        return true;
      });
      for (let i = orders.length - 1; i >= 0; i--) {
        const [col, asc] = orders[i]!;
        rows = [...rows].sort((a, b) => {
          const av = a[col] as string | number;
          const bv = b[col] as string | number;
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      return rows;
    };

    // PostgREST semantics: inclusive [from, to], response HARD-capped at cap.rows.
    const settleRange = (from: number, to: number) =>
      Promise.resolve({ data: filtered().slice(from, to + 1).slice(0, cap.rows), error: null });

    const builder = {
      select: () => builder,
      eq(c: string, v: unknown) {
        eqs.push([c, v]);
        return builder;
      },
      in(c: string, vals: unknown[]) {
        ins.push([c, vals]);
        return builder;
      },
      is(c: string, v: unknown) {
        nulls.push({ col: c, wantNull: v === null });
        return builder;
      },
      not(c: string, op: string, v: unknown) {
        if (op === "is" && v === null) nulls.push({ col: c, wantNull: false });
        return builder;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return builder;
      },
      range(from: number, to: number) {
        return settleRange(from, to);
      },
      maybeSingle() {
        return Promise.resolve({ data: filtered()[0] ?? null, error: null });
      },
      // Thenable: an awaited chain that never called .range()/.maybeSingle()
      // (the untyped retention/PO reads) resolves to the capped set.
      then<R>(res: (v: { data: Record<string, unknown>[]; error: null }) => R) {
        return Promise.resolve({ data: filtered().slice(0, cap.rows), error: null }).then(res);
      },
    };
    return builder;
  }

  return {
    tables,
    cap,
    client: { from: (t: string) => makeBuilder(t) },
    reset() {
      for (const k of Object.keys(tables)) delete tables[k];
      cap.rows = RESPONSE_CAP;
    },
  };
});

// ── module mocks ─────────────────────────────────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { org: { id: ORG }, membership: { role: "owner", org_id: ORG } },
  }),
}));
vi.mock("@/lib/jobs/load", () => ({
  loadJobForOrg: async () => ({
    id: JOB,
    status: "scheduled",
    scheduled_date: null,
    notes: null,
    customer_id: null,
    assigned_to: null,
    recurring: null,
    site_address_line1: null,
    site_address_line2: null,
    site_city: null,
    site_county: null,
    site_postcode: null,
    site_country: null,
    customer: null,
  }),
}));
vi.mock("@/lib/profitability/labour-rates", () => ({
  loadOrgHourlyPay: async () => new Map<string, number>(),
}));
vi.mock("@/server/services/job-budget", () => ({ loadCurrentJobBudget: async () => null }));

// Spy on the profitability authority, keeping its REAL implementation — this is
// the seam we read each page's computed cost back out of.
vi.mock("@/lib/profitability/compute", async (orig) => {
  const actual = await orig<typeof import("@/lib/profitability/compute")>();
  return { ...actual, computeJobProfitability: vi.fn(actual.computeJobProfitability) };
});

// Inert components / server actions so importing the pages pulls in nothing heavy.
const stub = () => null;
vi.mock("next/link", () => ({ default: stub }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/app/(app)/jobs/actions", () => ({ updateJob: vi.fn(), deleteJob: vi.fn() }));
vi.mock("@/app/(app)/jobs/retention-actions", () => ({
  setJobRetentionRate: vi.fn(),
  recordRetentionRelease: vi.fn(),
  setRetentionSchedule: vi.fn(),
}));
vi.mock("@/app/(app)/jobs/_form", () => ({ JobForm: stub }));
vi.mock("@/app/(app)/jobs/_form-helpers", () => ({
  listCustomersForOrg: async () => [],
  listStaffForOrg: async () => [],
}));
vi.mock("@/components/forms/StateForm", () => ({ StateForm: stub }));
vi.mock("@/components/forms/ConfirmForm", () => ({ ConfirmForm: stub }));
vi.mock("@/components/attachments/AttachmentsPanel", () => ({ AttachmentsPanel: stub }));
vi.mock("@/components/maps/MapActions", () => ({ MapActions: stub }));
vi.mock("@/app/(app)/jobs/[id]/_photo-gallery", () => ({ PhotoGallery: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-assets", () => ({ JobAssetsSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-safety", () => ({ JobSafetySection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-quality", () => ({ JobQualitySection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-delays", () => ({ JobDelaysSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-diary", () => ({ JobDiarySection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-progress", () => ({ JobProgressSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-programme", () => ({ JobProgrammeSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-snags", () => ({ JobSnagsSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-materials", () => ({ JobMaterialsSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_site-timeline", () => ({ SiteTimelineSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/_job-documents", () => ({ JobDocumentsPanel: stub }));
vi.mock("@/app/(app)/jobs/[id]/_blueprints", () => ({ JobBlueprintsPanel: stub }));
vi.mock("@/app/(app)/jobs/[id]/_retention-schedule", () => ({ RetentionScheduleSection: stub }));
vi.mock("@/app/(app)/jobs/[id]/commercial/_commercial-timeline", () => ({ CommercialTimeline: stub }));
vi.mock("@/app/(app)/jobs/[id]/commercial/_budget-form", () => ({ BudgetForm: stub }));

const { computeJobProfitability } = await import("@/lib/profitability/compute");
const EditJobPage = (await import("@/app/(app)/jobs/[id]/page")).default;
const JobCommercialPage = (await import("@/app/(app)/jobs/[id]/commercial/page")).default;

/** The costs_total the page most recently computed. */
function lastComputedCost(): number {
  const results = vi.mocked(computeJobProfitability).mock.results;
  const last = results[results.length - 1];
  if (!last || last.type !== "return" || !last.value) throw new Error("no profit computed");
  return last.value.costs_total;
}

beforeEach(() => {
  h.reset();
  vi.mocked(computeJobProfitability).mockClear();
  // A job with MORE than the cap of finance postings — each £10, so the correct
  // total cost is N*£10. A single-page read would see only the first 1000.
  h.tables.finances = Array.from({ length: N_FINANCES }, (_, i) => ({
    id: `fin-${String(i).padStart(6, "0")}`,
    org_id: ORG,
    job_id: JOB,
    amount: COST_EACH,
    vat_total: 2,
    category: "materials",
    created_at: `2026-07-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    purchase_order_id: null,
  }));
  // A cost on ANOTHER job the job_id filter must exclude even under paging.
  h.tables.finances.push({
    id: "fin-otherjob",
    org_id: ORG,
    job_id: OTHER_JOB,
    amount: 999999,
    vat_total: 0,
    category: "materials",
    created_at: "2026-07-02T00:00:00Z",
    purchase_order_id: null,
  });
});

describe("per-job cost reads page past the 1000-row PostgREST cap (F-1)", () => {
  it("the mock genuinely caps a single response at 1000 rows (harness self-check)", async () => {
    // A single wide read returns only the cap — proving the assertions below are
    // satisfiable ONLY by a real multi-page walk, never by one big fetch.
    const one = await h.client
      .from("finances")
      .select()
      .eq("job_id", JOB)
      .order("id", { ascending: true })
      .range(0, 100_000);
    expect(one.data).toHaveLength(RESPONSE_CAP);
  });

  it("jobs/[id] summary sums EVERY finance posting, not just the first 1000", async () => {
    await EditJobPage({
      params: Promise.resolve({ id: JOB }),
      searchParams: Promise.resolve({}),
    });
    const costs = lastComputedCost();
    // All 1500 × £10 = £15,000 — not the £10,000 a truncated first page gives,
    // and the other job's £999,999 never leaked past the job_id filter.
    expect(costs).toBe(N_FINANCES * COST_EACH);
    expect(costs).toBeGreaterThan(RESPONSE_CAP * COST_EACH);
  });

  it("jobs/[id]/commercial computes cost/profit over EVERY finance posting", async () => {
    await JobCommercialPage({ params: Promise.resolve({ id: JOB }) });
    const costs = lastComputedCost();
    expect(costs).toBe(N_FINANCES * COST_EACH);
    expect(costs).toBeGreaterThan(RESPONSE_CAP * COST_EACH);
  });
});
