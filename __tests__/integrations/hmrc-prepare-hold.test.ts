import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * HMRC internal prepare/hold — the wire-up that turns the phantom (composers with
 * no callers, hmrc_submissions never written) into a real capability. DARK submit
 * stays off; this only exercises the INTERNAL prepare/hold record.
 *
 * Hermetic: the Supabase client, org context and CIS dataset builder are mocked,
 * so no real DB / HMRC network is touched. The VAT authority (computeVatQuarter)
 * and the composers run FOR REAL — that is the point of case (a): the frozen
 * payload must be composed from the org's own computed figures.
 *
 * Cases:
 *   (a) prepare composes + INSERTs a 'prepared' hmrc_submissions row from the
 *       org's computed VAT figures (output/input VAT flow into the 9 boxes).
 *   (b) idempotent per (org, kind, period): an existing row short-circuits the
 *       insert.
 *   (c) admin-gated (a staff caller is refused, no write) and org-scoped (the
 *       insert pins ctx.org.id, never a client value).
 *   (d) getHmrcSubmissions returns the mapped rows.
 *   (e) CIS300 prepare composes from the dataset builder + contractor profile.
 */

// ── mock Supabase client ────────────────────────────────────────────────────

type Entry = { data?: unknown; error?: unknown };
type Key =
  | "invoices"
  | "finances"
  | "connSelect"
  | "connInsert"
  | "subFind"
  | "subInsert"
  | "subList";

function makeMock() {
  const queues: Record<Key, Entry[]> = {
    invoices: [],
    finances: [],
    connSelect: [],
    connInsert: [],
    subFind: [],
    subInsert: [],
    subList: [],
  };
  const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];

  function pop(key: Key): Entry {
    const e = queues[key].shift();
    if (!e) throw new Error(`no queued response for ${key}`);
    return e;
  }

  function makeChain(table: string) {
    const state = { calledOrder: false };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "lt"]) chain[m] = () => chain;
    chain.limit = () => chain;
    chain.order = () => {
      state.calledOrder = true;
      return chain;
    };

    const selectKey = (): Key => {
      if (table === "invoices") return "invoices";
      if (table === "finances") return "finances";
      if (table === "hmrc_connections") return "connSelect";
      // hmrc_submissions: list read uses .order(); idempotency probe uses .limit()
      return state.calledOrder ? "subList" : "subFind";
    };
    const insertKey = (): Key =>
      table === "hmrc_connections" ? "connInsert" : "subInsert";

    chain.maybeSingle = async () => pop(selectKey());
    chain.single = async () => pop(selectKey());
    chain.then = (resolve: (v: Entry) => unknown) => resolve(pop(selectKey()));

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

// The CIS dataset builder + contractor profile are their own tested services;
// stub them so the CIS case exercises the composer + insert, not snapshot reads.
const cisDataset = {
  taxMonthStart: "2026-04-06",
  taxMonthEnd: "2026-05-05",
  taxMonthLabel: "Apr 2026",
  dueOn: "2026-05-19",
  isNil: false,
  subcontractorCount: 1,
  paymentCount: 1,
  totalGross: 1000,
  totalMaterials: 100,
  totalDeduction: 180,
  lines: [
    {
      supplierId: "sup-1",
      subcontractorName: "Acme Groundworks",
      utrMasked: "*****4321",
      verificationNumber: null,
      verificationNumberRequired: false,
      rate: { rate: 0.2, source: "verified" },
      grossAmount: 1000,
      materialsAmount: 100,
      deductionAmount: 180,
      paymentCount: 1,
    },
  ],
};
vi.mock("@/server/services/cis-statements", () => ({
  liveReturnDataset: vi.fn(async () => cisDataset),
  getContractorProfile: vi.fn(async () => ({
    org_id: "org-1",
    legal_name: "Builder Ltd",
    employer_paye_reference: "123/AB456",
    accounts_office_reference: "123PA00012345",
    contractor_utr: "1234567890",
  })),
}));

// Imports under test, after the mocks.
const actions = await import("@/app/(app)/tax/actions");
const service = await import("@/server/services/hmrc-connections");

function fd(entries: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}

beforeEach(() => {
  caller.role = "owner";
  for (const k of Object.keys(mock.queues) as Key[]) mock.queues[k].length = 0;
  mock.inserts.length = 0;
});

// ── (a) composes + inserts from computed figures ─────────────────────────────

describe("prepareVatReturnAction — composes + inserts a prepared record", () => {
  it("freezes the 9-box payload from the org's computed VAT figures", async () => {
    mock.enqueue("subFind", { data: [], error: null }); // no existing record
    mock.enqueue("invoices", {
      // £100 output VAT on a paid invoice inside the quarter (cash basis)
      data: [
        { status: "paid", vat_total: 100, paid_at: "2026-08-15T00:00:00.000Z", created_at: "2026-08-15T00:00:00.000Z" },
      ],
      error: null,
    });
    mock.enqueue("finances", {
      // £40 input VAT on a finance row inside the quarter (accrual basis)
      data: [{ vat_total: 40, created_at: "2026-08-15T00:00:00.000Z" }],
      error: null,
    });
    mock.enqueue("connSelect", { data: null, error: null }); // no connection yet
    mock.enqueue("connInsert", { data: { id: "conn-1" }, error: null }); // disconnected anchor
    mock.enqueue("subInsert", { data: { id: "sub-1", status: "prepared" }, error: null });

    await actions.prepareVatReturnAction(fd({ quarterStart: "2026-07-01" }));

    // A disconnected connection anchor was created to satisfy the composite FK.
    const conn = mock.inserts.find((i) => i.table === "hmrc_connections");
    expect(conn?.payload).toMatchObject({ org_id: "org-1", provider: "hmrc", status: "disconnected" });

    const sub = mock.inserts.find((i) => i.table === "hmrc_submissions");
    expect(sub, "a hmrc_submissions row must be inserted").toBeDefined();
    expect(sub!.payload).toMatchObject({
      org_id: "org-1",
      connection_id: "conn-1",
      kind: "vat_return",
      period_key: "2026-07-01",
      status: "prepared",
      prepared_by: "user-owner",
    });
    // The frozen payload is composed from computeVatQuarter, not invented.
    const payload = sub!.payload.payload as Record<string, number>;
    expect(payload.vatDueSales).toBe(100); // box 1 = output VAT
    expect(payload.vatReclaimedCurrPeriod).toBe(40); // box 4 = input VAT
    expect(payload.netVatDue).toBe(60); // box 5 = |box3 - box4|
    expect(payload.periodKey).toBe("2026-07-01");
  });
});

// ── (b) idempotent per (org, kind, period) ───────────────────────────────────

describe("prepareVatReturnAction — idempotent per period", () => {
  it("does NOT insert a second row when one already exists for the period", async () => {
    mock.enqueue("subFind", { data: [{ id: "existing-1", status: "held" }], error: null });

    await actions.prepareVatReturnAction(fd({ quarterStart: "2026-07-01" }));

    expect(mock.inserts.find((i) => i.table === "hmrc_submissions")).toBeUndefined();
    expect(mock.inserts.find((i) => i.table === "hmrc_connections")).toBeUndefined();
  });
});

// ── (c) admin-gated + org-scoped ─────────────────────────────────────────────

describe("prepareVatReturnAction — admin gate + org scope", () => {
  it("REFUSES a staff caller and writes nothing", async () => {
    caller.role = "staff";
    await expect(
      actions.prepareVatReturnAction(fd({ quarterStart: "2026-07-01" })),
    ).rejects.toThrow(/owner or admin/i);
    expect(mock.inserts).toHaveLength(0);
  });

  it("pins the insert to ctx.org.id, never a client-supplied org", async () => {
    mock.enqueue("subFind", { data: [], error: null });
    mock.enqueue("invoices", { data: [], error: null });
    mock.enqueue("finances", { data: [], error: null });
    mock.enqueue("connSelect", { data: { id: "conn-9" }, error: null });
    mock.enqueue("subInsert", { data: { id: "sub-9", status: "prepared" }, error: null });

    // A hostile org field in the form must be ignored.
    await actions.prepareVatReturnAction(fd({ quarterStart: "2026-07-01", org_id: "org-EVIL" }));

    const sub = mock.inserts.find((i) => i.table === "hmrc_submissions");
    expect(sub!.payload.org_id).toBe("org-1");
    expect(sub!.payload.connection_id).toBe("conn-9"); // reused existing anchor
  });
});

// ── (d) getHmrcSubmissions read surface ──────────────────────────────────────

describe("getHmrcSubmissions", () => {
  it("returns the org's prepared/held submissions, mapped", async () => {
    mock.enqueue("subList", {
      data: [
        {
          id: "sub-1",
          kind: "vat_return",
          period_key: "2026-07-01",
          status: "prepared",
          payload: { periodKey: "2026-07-01", vatDueSales: 100 },
          prepared_by: "user-owner",
          created_at: "2026-08-01T10:00:00.000Z",
        },
      ],
      error: null,
    });

    const rows = await service.getHmrcSubmissions("org-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "sub-1",
      kind: "vat_return",
      periodKey: "2026-07-01",
      status: "prepared",
      preparedBy: "user-owner",
    });
  });

  it("throws LOUD on a read failure (never a silent empty list)", async () => {
    mock.enqueue("subList", { data: null, error: { message: "boom" } });
    await expect(service.getHmrcSubmissions("org-1")).rejects.toThrow(/hmrc submissions: list/i);
  });
});

// ── (e) CIS300 prepare ───────────────────────────────────────────────────────

describe("prepareCis300ReturnAction — composes from the dataset builder", () => {
  it("inserts a prepared cis300 row for the tax month", async () => {
    mock.enqueue("subFind", { data: [], error: null });
    mock.enqueue("connSelect", { data: { id: "conn-1" }, error: null });
    mock.enqueue("subInsert", { data: { id: "sub-cis", status: "prepared" }, error: null });

    await actions.prepareCis300ReturnAction(fd({ taxMonthEnd: "2026-05-05" }));

    const sub = mock.inserts.find((i) => i.table === "hmrc_submissions");
    expect(sub!.payload).toMatchObject({
      org_id: "org-1",
      connection_id: "conn-1",
      kind: "cis300",
      period_key: "2026-05-05",
      status: "prepared",
    });
    const payload = sub!.payload.payload as {
      taxYear: string;
      subcontractors: Array<{ name: string; totalDeducted: number }>;
      contractor: { employerPayeReference: string | null };
      declarations: { informationCorrect: boolean | null };
    };
    expect(payload.subcontractors[0]).toMatchObject({ name: "Acme Groundworks", totalDeducted: 180 });
    expect(payload.contractor.employerPayeReference).toBe("123/AB456");
    // Declarations are NEVER asserted on the user's behalf.
    expect(payload.declarations.informationCorrect).toBeNull();
  });
});
