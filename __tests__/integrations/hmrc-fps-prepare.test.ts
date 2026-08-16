import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * HMRC RTI FPS internal prepare/hold (20261156) — the wire-up that folds a
 * finalised payroll run's stored lines into an FPS and freezes it in
 * hmrc_submissions. DARK submit stays off; this exercises only the INTERNAL
 * prepare/hold record.
 *
 * Hermetic: the Supabase client, org context and contractor profile are mocked,
 * so no real DB / HMRC network is touched. The composer runs FOR REAL — the
 * frozen payload must be composed from the org's own stored figures.
 *
 * Cases:
 *   (a) prepare folds the run's lines + computes tax-year-to-date, then INSERTs a
 *       'prepared' fps row from the org's stored payroll figures.
 *   (b) refuses a DRAFT run (only finalised figures may be filed) — no write.
 *   (c) idempotent per run: an existing row short-circuits the insert.
 *   (d) org-scoped: the run read + insert pin ctx.org.id, never a client value;
 *       the action refuses a staff caller with no write.
 */

type Entry = { data?: unknown; error?: unknown };
type Key =
  | "runSingle"
  | "yearRuns"
  | "lines"
  | "subFind"
  | "subInsert"
  | "connSelect"
  | "connInsert";

function makeMock() {
  const queues: Record<Key, Entry[]> = {
    runSingle: [],
    yearRuns: [],
    lines: [],
    subFind: [],
    subInsert: [],
    connSelect: [],
    connInsert: [],
  };
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];

  function pop(key: Key): Entry {
    const e = queues[key].shift();
    if (!e) throw new Error(`no queued response for ${key}`);
    return e;
  }

  function makeChain(table: string) {
    const state = { ranged: false };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lte", "lt", "in", "limit"]) chain[m] = () => chain;
    chain.order = () => chain;
    chain.range = () => {
      state.ranged = true;
      return chain;
    };

    // A read reached via `.range()` is a fetchAllRows page (list); otherwise it is
    // a single/idempotency read.
    const readKey = (): Key => {
      if (table === "payroll_runs") return state.ranged ? "yearRuns" : "runSingle";
      if (table === "payroll_lines") return "lines";
      if (table === "hmrc_connections") return "connSelect";
      return "subFind"; // hmrc_submissions idempotency probe
    };
    const insertKey = (): Key => (table === "hmrc_connections" ? "connInsert" : "subInsert");

    chain.maybeSingle = async () => pop(readKey());
    chain.single = async () => pop(readKey());
    chain.then = (resolve: (v: Entry) => unknown) => resolve(pop(readKey()));

    chain.insert = (payload: Record<string, unknown>) => {
      inserts.push({ table, payload });
      const ins: Record<string, unknown> = {};
      ins.select = () => ins;
      ins.single = async () => pop(insertKey());
      ins.then = (resolve: (v: Entry) => unknown) => resolve(pop(insertKey()));
      return ins;
    };
    return chain;
  }

  return {
    client: { from: (t: string) => makeChain(t) },
    queues,
    inserts,
    enqueue(key: Key, entry: Entry) {
      queues[key].push(entry);
    },
  };
}

const mock = makeMock();
const caller = { role: "owner" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mock.client),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: caller.role } },
    user: { id: "user-owner" },
  })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect() throws in Next; mock it to a catchable sentinel that carries the URL.
class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectError(url);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

// The contractor profile is its own tested service; stub it (also stub the CIS
// dataset builder that hmrc-connections imports alongside it).
vi.mock("@/server/services/cis-statements", () => ({
  liveReturnDataset: vi.fn(),
  getContractorProfile: vi.fn(async () => ({
    org_id: "org-1",
    legal_name: "Builder Ltd",
    employer_paye_reference: "123/AB456",
    accounts_office_reference: "123PA00012345",
    contractor_utr: "1234567890",
  })),
}));

const service = await import("@/server/services/hmrc-connections");
const actions = await import("@/app/(app)/payroll/actions");

beforeEach(() => {
  caller.role = "owner";
  for (const k of Object.keys(mock.queues) as Key[]) mock.queues[k].length = 0;
  mock.inserts.length = 0;
});

// ── (a) folds lines + YTD, inserts a prepared fps row ────────────────────────

describe("prepareFpsReturn — composes + inserts from stored payroll figures", () => {
  it("folds the run's lines and computes tax-year-to-date across finalised runs", async () => {
    // A prior finalised run (Apr) + this run (May), same tax year, one employee.
    mock.enqueue("runSingle", {
      data: { id: "run-may", cycle: "monthly", period_start: "2026-05-01", period_end: "2026-05-31", status: "finalised" },
      error: null,
    });
    mock.enqueue("subFind", { data: [], error: null }); // no existing fps
    // year runs in-window (both finalised, period_end <= 2026-05-31)
    mock.enqueue("yearRuns", { data: [{ id: "run-apr" }, { id: "run-may" }], error: null });
    // all in-year lines for user-1: Apr 3000/400/200, May 3200/440/210
    mock.enqueue("lines", {
      data: [
        { payroll_run_id: "run-apr", user_id: "user-1", hours: 160, gross_pay: 3000, paye_estimate: 400, ni_estimate: 200, net_pay: 2400, user: { full_name: "Alex Mason" } },
        { payroll_run_id: "run-may", user_id: "user-1", hours: 168, gross_pay: 3200, paye_estimate: 440, ni_estimate: 210, net_pay: 2550, user: { full_name: "Alex Mason" } },
      ],
      error: null,
    });
    mock.enqueue("connSelect", { data: { id: "conn-1" }, error: null });
    mock.enqueue("subInsert", { data: { id: "fps-1", status: "prepared" }, error: null });

    const res = await service.prepareFpsReturn({
      orgId: "org-1",
      preparedBy: "user-owner",
      payrollRunId: "run-may",
    });
    expect(res.ok).toBe(true);

    const sub = mock.inserts.find((i) => i.table === "hmrc_submissions");
    expect(sub, "an hmrc_submissions row must be inserted").toBeDefined();
    expect(sub!.payload).toMatchObject({
      org_id: "org-1",
      connection_id: "conn-1",
      kind: "fps",
      period_key: "monthly:2026-05-01..2026-05-31",
      status: "prepared",
      prepared_by: "user-owner",
    });
    const payload = sub!.payload.payload as {
      taxYear: string;
      payDate: string;
      employer: { employerPayeReference: string | null };
      employees: Array<{ employeeId: string; taxablePay: number; yearToDate: { taxablePay: number; taxDeducted: number; employeeNic: number } }>;
      finalSubmission: boolean;
    };
    // The period line is THIS run's May figures.
    expect(payload.employees).toHaveLength(1);
    expect(payload.employees[0]).toMatchObject({ employeeId: "user-1", taxablePay: 3200 });
    // YTD sums BOTH finalised runs (Apr + May).
    expect(payload.employees[0]!.yearToDate).toEqual({ taxablePay: 6200, taxDeducted: 840, employeeNic: 410 });
    expect(payload.employer.employerPayeReference).toBe("123/AB456");
    expect(payload.payDate).toBe("2026-05-31");
    expect(payload.finalSubmission).toBe(false);
  });
});

// ── (b) refuses a draft run ──────────────────────────────────────────────────

describe("prepareFpsReturn — refuses a draft run", () => {
  it("does NOT insert when the run is still a draft", async () => {
    mock.enqueue("runSingle", {
      data: { id: "run-draft", cycle: "weekly", period_start: "2026-05-01", period_end: "2026-05-07", status: "draft" },
      error: null,
    });
    const res = await service.prepareFpsReturn({ orgId: "org-1", preparedBy: "user-owner", payrollRunId: "run-draft" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/finalised/i);
    expect(mock.inserts).toHaveLength(0);
  });
});

// ── (c) idempotent per run ───────────────────────────────────────────────────

describe("prepareFpsReturn — idempotent per run", () => {
  it("returns the existing row without inserting a second", async () => {
    mock.enqueue("runSingle", {
      data: { id: "run-1", cycle: "monthly", period_start: "2026-05-01", period_end: "2026-05-31", status: "finalised" },
      error: null,
    });
    mock.enqueue("subFind", { data: [{ id: "existing-fps", status: "held" }], error: null });

    const res = await service.prepareFpsReturn({ orgId: "org-1", preparedBy: "user-owner", payrollRunId: "run-1" });
    expect(res).toMatchObject({ ok: true, id: "existing-fps", created: false });
    expect(mock.inserts.find((i) => i.table === "hmrc_submissions")).toBeUndefined();
  });
});

// ── (d) org-scoped + admin-gated via the action ──────────────────────────────

describe("prepareFpsRunAction — admin gate + org scope", () => {
  it("REFUSES a staff caller (redirect forbidden) and writes nothing", async () => {
    caller.role = "staff";
    await expect(actions.prepareFpsRunAction("run-1")).rejects.toThrow(/REDIRECT:.*forbidden/);
    expect(mock.inserts).toHaveLength(0);
  });

  it("pins the insert to ctx.org.id and redirects on success", async () => {
    mock.enqueue("runSingle", {
      data: { id: "run-1", cycle: "monthly", period_start: "2026-05-01", period_end: "2026-05-31", status: "finalised" },
      error: null,
    });
    mock.enqueue("subFind", { data: [], error: null });
    mock.enqueue("yearRuns", { data: [{ id: "run-1" }], error: null });
    mock.enqueue("lines", {
      data: [
        { payroll_run_id: "run-1", user_id: "user-9", hours: 40, gross_pay: 800, paye_estimate: 90, ni_estimate: 50, net_pay: 660, user: { full_name: "Jo Lee" } },
      ],
      error: null,
    });
    mock.enqueue("connSelect", { data: { id: "conn-9" }, error: null });
    mock.enqueue("subInsert", { data: { id: "fps-9", status: "prepared" }, error: null });

    await expect(actions.prepareFpsRunAction("run-1")).rejects.toThrow(/REDIRECT:.*saved=fps_prepared/);

    const sub = mock.inserts.find((i) => i.table === "hmrc_submissions");
    expect(sub!.payload.org_id).toBe("org-1");
    expect(sub!.payload.connection_id).toBe("conn-9");
  });
});
