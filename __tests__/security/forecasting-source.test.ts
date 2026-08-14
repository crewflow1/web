import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * FORECASTING — source assertions + a dual-org behavioural proof.
 *
 * The forward forecast layer reads the SAME multi-tenant tables the company
 * signals do, so it inherits the same defect class: `current_org_ids()` admits
 * every org the viewer belongs to, so one unpinned read presents one company's
 * cash or labour as the other's. This suite (a) pins the read layer's source
 * (read-only, org-pinned, loud, bounded), (b) EXECUTES it against a chainable
 * mock seeded with two colliding orgs so a dropped pin fails a number, and (c)
 * re-applies the anti-composite-score ratchet to the new pure modules.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// ---------------------------------------------------------------------------
// Chainable mock — honours eq / in / gte / lte, as Postgres would
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  type Rec = { table: string; eqs: Array<[string, unknown]>; ins: Array<[string, readonly unknown[]]> };
  const reads: Rec[] = [];
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const failing = new Set<string>();

  function makeBuilder(table: string) {
    const rec: Rec = { table, eqs: [], ins: [] };
    reads.push(rec);
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const settle = () => {
      if (failing.has(table)) return { data: null, error: { message: `${table} exploded` } };
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
      range: () => Promise.resolve(settle()),
      then<R>(onF: (v: { data: unknown[] | null; error: { message: string } | null }) => R, onR?: (e: unknown) => R) {
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
    cashOut: {
      loadError: false,
      summary: {
        unpaidBills: 0,
        unpaidBillCount: 0,
        billsSettled: 0,
        vatDue: 0,
        vatReclaim: 0,
        vatQuarterStart: "",
        cisDueNow: 0,
        cisDueOn: null as string | null,
        cisDueMonths: [] as string[],
        cisPastDeadline: 0,
        payrollDraft: 0,
        payrollDraftRunCount: 0,
        committedNotBilled: 0,
        committedPoCount: 0,
      },
    },
    reset() {
      reads.length = 0;
      for (const k of Object.keys(tables)) delete tables[k];
      failing.clear();
      this.reported.length = 0;
      this.cashOut.loadError = false;
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.client }));
vi.mock("@/lib/supabase/read-failure", () => ({
  readFailure: (context: string, error: { message?: string | null }) =>
    new Error(`${context} read failed: ${error.message ?? "unknown error"}`),
  reportReadFailure: (context: string) => {
    h.reported.push(context);
  },
}));
vi.mock("@/server/services/org-cash-out", () => ({
  cashOutVisibleToRole: (role: string) => role === "owner" || role === "admin",
  buildOrgCashOut: async () => ({ summary: h.cashOut.summary, loadError: h.cashOut.loadError }),
}));

const { loadForecasts } = await import("@/server/services/forecasting");
import type { CompanySignalsView } from "@/server/services/intelligence";

const ORG_A = "org-aaaa";
const ORG_B = "org-bbbb";
const NOW = new Date("2026-08-14T10:00:00Z");

/** Minimal signals view: the risk boards depend on it, but this suite targets
 *  the reads (cash timeline + labour), so the composed groups are marked failed
 *  and the risk boards fall to their insufficient/failed paths. */
function failedSignals(): CompanySignalsView {
  const failed = { data: null, failed: true } as const;
  return {
    asAtIso: "2026-08-14",
    todayKey: "2026-08-14",
    utilisation: failed,
    concentration: failed,
    progress: failed,
    programmeVariance: failed,
    exposure: failed,
    cvr: failed,
    materials: failed,
    snags: failed,
    supplierPerformance: failed,
  } as unknown as CompanySignalsView;
}

/** Two orgs whose invoices, jobs and rota deliberately COLLIDE on ids. */
function seedTwoOrgs() {
  h.tables.invoices = [
    { id: "inv-a1", org_id: ORG_A, number: "INV-A1", status: "sent", amount: 1000, total: 1200, due_date: "2026-08-18", job_id: "job-a1" },
    { id: "inv-b1", org_id: ORG_B, number: "INV-B1", status: "sent", amount: 8000, total: 9600, due_date: "2026-08-18", job_id: "job-b1" },
  ];
  h.tables.invoice_payments = [
    { invoice_id: "inv-a1", org_id: ORG_A, amount: 200 }, // org A remaining 1000
    { invoice_id: "inv-b1", org_id: ORG_B, amount: 100 }, // must never touch org A
  ];
  h.tables.jobs = [
    { id: "job-a1", org_id: ORG_A, retention_percent: 5, practical_completion_date: null, defects_liability_months: 12, retention_first_release_pct: 50, site_address_line1: "1 A St", site_city: "Leeds", site_postcode: "LS1" },
    { id: "job-b1", org_id: ORG_B, retention_percent: 5, practical_completion_date: null, defects_liability_months: 12, retention_first_release_pct: 50 },
  ];
  h.tables.retention_releases = [];
  h.tables.expense_budgets = [];
  // The SAME worker rostered in both orgs — a dropped pin would double the hours.
  h.tables.memberships = [
    { org_id: ORG_A, user_id: "user-a" },
    { org_id: ORG_B, user_id: "user-a" },
  ];
  h.tables.users = [{ id: "user-a", full_name: "Alice" }];
  h.tables.rota_entries = [
    { id: "rota-a1", org_id: ORG_A, user_id: "user-a", starts_at: "2026-08-18T08:00:00.000Z", ends_at: "2026-08-18T16:00:00.000Z" },
    { id: "rota-b1", org_id: ORG_B, user_id: "user-a", starts_at: "2026-08-19T08:00:00.000Z", ends_at: "2026-08-19T16:00:00.000Z" },
  ];
}

beforeEach(() => {
  h.reset();
  seedTwoOrgs();
});

// ---------------------------------------------------------------------------
// Behavioural — active-org pinning
// ---------------------------------------------------------------------------

describe("dual-org: every read is pinned to the active org", () => {
  it("EVERY read except the global users profile carries org_id = the active org", async () => {
    await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    expect(h.reads.length).toBeGreaterThanOrEqual(6);
    for (const r of h.reads) {
      if (r.table === "users") continue;
      const orgEq = r.eqs.find(([c]) => c === "org_id");
      expect(orgEq, `${r.table} read is not org-pinned`).toBeDefined();
      expect(orgEq?.[1], `${r.table} read is pinned to the wrong org`).toBe(ORG_A);
    }
  });

  it("the users read is scoped by this org's membership ids only", async () => {
    await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    const usersReads = h.reads.filter((r) => r.table === "users");
    expect(usersReads.length).toBe(1);
    expect(usersReads[0]!.ins.find(([c]) => c === "id")?.[1]).toEqual(["user-a"]);
  });

  it("the cash timeline sees ONLY org A's invoice remaining, not org B's £9,600", async () => {
    const view = await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    expect(view.cashTimeline.failed).toBe(false);
    expect(view.cashTimeline.data!.totalInflow).toBe(1000); // 1200 − 200 paid; org B absent
  });

  it("labour counts org A's one shift, though the same worker is rostered in org B", async () => {
    const view = await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    expect(view.labour.failed).toBe(false);
    expect(view.labour.data!.totalRosteredHours).toBeCloseTo(8, 1); // never 16
  });
});

// ---------------------------------------------------------------------------
// Behavioural — loud reads and role gating
// ---------------------------------------------------------------------------

describe("loud reads and gating", () => {
  it("a failed invoices read fails the cash timeline whole (never an empty forecast)", async () => {
    h.failing.add("invoices");
    const view = await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    expect(view.cashTimeline.failed).toBe(true);
    expect(view.cashTimeline.data).toBeNull();
    expect(h.reported.some((c) => c.includes("cash timeline"))).toBe(true);
    // Labour is independent and still stands.
    expect(view.labour.failed).toBe(false);
  });

  it("a cash-out load error fails the cash timeline (an understated outflow is the one lie to avoid)", async () => {
    h.cashOut.loadError = true;
    const view = await loadForecasts(ORG_A, "owner", failedSignals(), NOW);
    expect(view.cashTimeline.failed).toBe(true);
  });

  it("a role that cannot see outflows gets no cash timeline rather than half a ledger", async () => {
    const view = await loadForecasts(ORG_A, "staff", failedSignals(), NOW);
    expect(view.cashVisible).toBe(false);
    expect(view.cashTimeline.failed).toBe(true);
    // Labour is still available to staff.
    expect(view.labour.failed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source pins — read-only, pinned, bounded, loud
// ---------------------------------------------------------------------------

const SERVICE = src("server/services/forecasting.ts");
const FROM_BLOCKS = [...SERVICE.matchAll(/\.from\("([a-z_]+)"\)([\s\S]*?)\.range\(/g)].map((m) => ({
  table: m[1]!,
  chain: m[2]!,
}));

describe("source pins — the read layer is read-only and pinned", () => {
  it("the service never mutates anything", () => {
    for (const op of [".insert(", ".update(", ".delete(", ".upsert(", ".rpc("]) {
      expect(SERVICE, `forecasting must not ${op}`).not.toContain(op);
    }
  });

  it("every query chain except the global users read pins org_id in source", () => {
    expect(FROM_BLOCKS.length).toBeGreaterThanOrEqual(6);
    for (const { table, chain } of FROM_BLOCKS) {
      if (table === "users") {
        expect(chain, "users must be scoped by membership ids").toContain('.in("id", memberIds)');
        continue;
      }
      expect(chain, `${table} chain must pin org_id`).toContain('.eq("org_id", orgId)');
    }
  });

  it("every query chain keeps a unique total order across page boundaries", () => {
    for (const { table, chain } of FROM_BLOCKS) {
      expect(chain, `${table} chain needs a unique ORDER BY tiebreaker`).toMatch(
        /\.order\("(id|user_id|invoice_id|job_id|starts_at)"/,
      );
    }
  });

  it("every read pages through the loud allRows wrapper (fetchAllRows + readFailure)", () => {
    expect(SERVICE).toContain("fetchAllRows<Row>");
    expect(SERVICE).toContain("throw readFailure(");
    expect(SERVICE).toContain("reportReadFailure(");
    expect((SERVICE.match(/allRows\(/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// The composite-score ratchet — extended to the new forward modules
// ---------------------------------------------------------------------------

describe("the composite-score ratchet still holds over lib/intelligence", () => {
  it("no module (including the new forecast modules) carries a blended score", () => {
    const dir = resolve(ROOT, "lib", "intelligence");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(13); // 9 original + cash-timeline, labour, delay, commercial
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), "utf8");
      expect(text, `${f} must not define a composite score`).not.toMatch(
        /overallScore|healthScore|compositeScore|weightedScore/,
      );
    }
  });

  it("the new forecast modules exist in the swept directory", () => {
    const dir = resolve(ROOT, "lib", "intelligence");
    const files = readdirSync(dir);
    for (const f of ["cash-timeline.ts", "labour-forecast.ts", "delay-risk.ts", "commercial-risk.ts"]) {
      expect(files, `${f} must live in lib/intelligence so the ratchet sweeps it`).toContain(f);
    }
  });
});
