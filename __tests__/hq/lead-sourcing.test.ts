import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * HQ Sales AI — the R088 lead-sourcing leg (dark by construction).
 *
 *   A. The `lead_sourcing` handler while DARK — no Companies House key: it
 *      COMPLETES (never fails) with the honest dark outcome
 *      { sourced: 0, dark: true, reason: "companies-house key not configured" },
 *      refuses BEFORE any fetch, and writes nothing.
 *   B. The handler while ARMED (spied register) — candidates flow through the
 *      EXISTING sanctioned door (createCompany) only, at status 'new' with the
 *      seeded `companies_house` source slug, already-known company numbers are
 *      skipped, and the fuller `lead_sourcing` provenance rides the result.
 *   C. enqueueLeadSourcing — dedupes per ISO week (UTC Monday stamp), and
 *      skips honestly when the sales-ai identity was never seeded.
 *
 * No governed seam is involved anywhere — this leg is deterministic +
 * adapter-gated by design (the only gate is the adapter's own credential).
 */

const {
  createCompanyMock,
  enqueueTaskMock,
  resolveWorkerIdentityMock,
  registerTaskHandlerMock,
  runReadyTaskMock,
  drainTaskTypeMock,
  knownNumbersData,
} = vi.hoisted(() => ({
  createCompanyMock: vi.fn(),
  enqueueTaskMock: vi.fn(),
  resolveWorkerIdentityMock: vi.fn(),
  registerTaskHandlerMock: vi.fn(),
  runReadyTaskMock: vi.fn(),
  drainTaskTypeMock: vi.fn(),
  /** Rows the mocked known-company-numbers read returns. */
  knownNumbersData: { rows: [] as Array<{ companies_house_number: string | null }> },
}));

vi.mock("@/server/services/hq-sales", () => ({
  createCompany: createCompanyMock,
}));
vi.mock("@/server/services/hq-tasks", () => ({
  enqueueTask: enqueueTaskMock,
}));
vi.mock("@/server/services/hq-worker-runner-kit", () => ({
  resolveWorkerIdentity: resolveWorkerIdentityMock,
  normaliseWorkerOutcome: (o: { status: string }) => o,
}));
vi.mock("@/server/sdk/tasks", () => ({
  registerTaskHandler: registerTaskHandlerMock,
  runReadyTask: runReadyTaskMock,
  drainTaskType: drainTaskTypeMock,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          limit: () => Promise.resolve({ data: knownNumbersData.rows, error: null }),
        }),
      }),
    }),
  }),
}));

const CTX = {
  identity: { employeeId: "emp-sales-1", slug: "sales-ai" },
  task: { id: "task-1", created_by: null },
} as never;

/** A Companies House advanced-search item as the register returns it. */
const chItem = (number: string, name: string) => ({
  company_number: number,
  company_name: name,
  company_status: "active",
  date_of_creation: "2015-03-02",
  sic_codes: ["41202"],
  registered_office_address: {
    address_line_1: "1 Yard Lane",
    locality: "Leeds",
    postal_code: "LS1 1AA",
  },
});

beforeEach(() => {
  createCompanyMock.mockReset();
  enqueueTaskMock.mockReset();
  resolveWorkerIdentityMock.mockReset();
  knownNumbersData.rows = [];
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("A. lead_sourcing handler — DARK path (no key): completes, honestly, fetch-free", () => {
  it("completes with the honest dark outcome and refuses before any fetch", async () => {
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const result = (await leadSourcingHandler(CTX)) as Record<string, unknown>;

    // The exact honest dark outcome — zero sourced, and it says why.
    expect(result).toMatchObject({
      kind: "lead_sourcing",
      sourced: 0,
      dark: true,
      reason: "companies-house key not configured",
    });
    // Refusal BEFORE the adapter: no network call of any kind was made…
    expect(fetchSpy).not.toHaveBeenCalled();
    // …and nothing was written through any door.
    expect(createCompanyMock).not.toHaveBeenCalled();
  });

  it("never fails while dark — the dark path is a COMPLETION (returns, no throw)", async () => {
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "");
    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    await expect(leadSourcingHandler(CTX)).resolves.toBeTruthy();
  });

  it("the result still carries the full lead_sourcing provenance while dark", async () => {
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "");
    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const result = (await leadSourcingHandler(CTX)) as {
      provenance: { source: string; dbSourceSlug: string };
      companies: unknown[];
    };
    expect(result.provenance.source).toBe("lead_sourcing");
    expect(result.provenance.dbSourceSlug).toBe("companies_house");
    expect(result.companies).toEqual([]);
  });
});

describe("B. lead_sourcing handler — ARMED path (spied register): sanctioned door only", () => {
  const armed = (items: unknown[]) => {
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "test-ch-key");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    return fetchSpy;
  };

  it("records register candidates through createCompany, at status 'new' with the seeded source slug", async () => {
    armed([chItem("01234567", "Yard Lane Builders Ltd"), chItem("SC765432", "Clyde Civils Ltd")]);
    createCompanyMock
      .mockResolvedValueOnce({ ok: true, id: "co-1" })
      .mockResolvedValueOnce({ ok: true, id: "co-2" });

    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const result = (await leadSourcingHandler(CTX)) as Record<string, unknown>;

    expect(result.dark).toBe(false);
    expect(result.sourced).toBe(2);
    expect(result.candidates).toBe(2);
    expect(createCompanyMock).toHaveBeenCalledTimes(2);
    const input = createCompanyMock.mock.calls[0]![0];
    // The sanctioned door's contract: entry status, seeded FK-valid source,
    // register-grounded facts only.
    expect(input).toMatchObject({
      name: "Yard Lane Builders Ltd",
      status: "new",
      source: "companies_house",
      country: "United Kingdom",
      companiesHouseNumber: "01234567",
      industry: "Construction",
    });
    expect(input.location).toContain("Leeds");
    // Nothing invented: no scores, no contacts, no deal value.
    expect(input.aiQualificationScore).toBeNull();
    expect(input.primaryEmail).toBeNull();
    expect(input.estimatedDealValueGbp).toBeNull();
    expect(result.companies).toEqual([
      { id: "co-1", name: "Yard Lane Builders Ltd", companyNumber: "01234567" },
      { id: "co-2", name: "Clyde Civils Ltd", companyNumber: "SC765432" },
    ]);
  });

  it("skips candidates whose company number is already a prospect (no duplicates)", async () => {
    armed([chItem("01234567", "Yard Lane Builders Ltd"), chItem("SC765432", "Clyde Civils Ltd")]);
    knownNumbersData.rows = [{ companies_house_number: "01234567" }];
    createCompanyMock.mockResolvedValue({ ok: true, id: "co-2" });

    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const result = (await leadSourcingHandler(CTX)) as Record<string, unknown>;

    expect(result.sourced).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(createCompanyMock).toHaveBeenCalledTimes(1);
    expect(createCompanyMock.mock.calls[0]![0].companiesHouseNumber).toBe("SC765432");
  });

  it("queries the register for active construction (Section F) companies only", async () => {
    const fetchSpy = armed([]);
    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    await leadSourcingHandler(CTX);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain("/advanced-search/companies");
    expect(url).toContain("company_status=active");
    expect(url).toContain("sic_codes=41100");
    expect(url).toContain("sic_codes=43999");
  });

  it("fails LOUDLY (throws, retryable) on a register transport error — never a fake empty run", async () => {
    vi.stubEnv("COMPANIES_HOUSE_API_KEY", "test-ch-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    const { leadSourcingHandler } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    await expect(leadSourcingHandler(CTX)).rejects.toThrow(/advanced search failed/);
    expect(createCompanyMock).not.toHaveBeenCalled();
  });
});

describe("C. enqueueLeadSourcing — weekly dedupe, honest skip when unseeded", () => {
  it("dedupes per ISO week: same week → same dedupeKey (UTC Monday stamp)", async () => {
    resolveWorkerIdentityMock.mockResolvedValue({
      identity: { employeeId: "emp-sales-1", slug: "sales-ai" },
      employeeId: "emp-sales-1",
    });
    enqueueTaskMock.mockResolvedValue({ ok: true, task: { id: "t-1" } });

    const { enqueueLeadSourcing } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    // Wednesday and Friday of the SAME ISO week (Monday 2026-08-24)…
    await enqueueLeadSourcing(new Date("2026-08-26T12:00:00Z"));
    await enqueueLeadSourcing(new Date("2026-08-28T09:00:00Z"));
    expect(enqueueTaskMock).toHaveBeenCalledTimes(2);
    expect(enqueueTaskMock.mock.calls[0]![0].dedupeKey).toBe("lead_sourcing:2026-08-24");
    expect(enqueueTaskMock.mock.calls[1]![0].dedupeKey).toBe("lead_sourcing:2026-08-24");
    // …so the engine's live-dedupeKey idempotency makes the re-tick a no-op.
  });

  it("a different ISO week gets a different dedupeKey", async () => {
    resolveWorkerIdentityMock.mockResolvedValue({
      identity: { employeeId: "emp-sales-1", slug: "sales-ai" },
      employeeId: "emp-sales-1",
    });
    enqueueTaskMock.mockResolvedValue({ ok: true, task: { id: "t-2" } });
    const { enqueueLeadSourcing } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    await enqueueLeadSourcing(new Date("2026-08-31T08:00:00Z")); // next Monday
    expect(enqueueTaskMock.mock.calls[0]![0].dedupeKey).toBe("lead_sourcing:2026-08-31");
  });

  it("enqueues assigned to the sales-ai identity as a low-priority cron task", async () => {
    resolveWorkerIdentityMock.mockResolvedValue({
      identity: { employeeId: "emp-sales-1", slug: "sales-ai" },
      employeeId: "emp-sales-1",
    });
    enqueueTaskMock.mockResolvedValue({ ok: true, task: { id: "t-3" } });
    const { enqueueLeadSourcing } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const out = await enqueueLeadSourcing(new Date("2026-08-26T12:00:00Z"));
    expect(out).toEqual({ ok: true, taskId: "t-3" });
    expect(resolveWorkerIdentityMock).toHaveBeenCalledWith("sales-ai");
    expect(enqueueTaskMock.mock.calls[0]![0]).toMatchObject({
      taskType: "lead_sourcing",
      priority: "low",
      origin: "cron",
      assignedEmployeeId: "emp-sales-1",
    });
  });

  it("skips honestly (no enqueue) when the sales-ai identity was never seeded", async () => {
    resolveWorkerIdentityMock.mockResolvedValue({
      identity: { employeeId: "sales-ai", slug: "sales-ai" },
      employeeId: null,
    });
    const { enqueueLeadSourcing } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    const out = await enqueueLeadSourcing(new Date("2026-08-26T12:00:00Z"));
    expect(out).toEqual({ ok: true, skipped: true });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
  });

  it("leadSourcingWeekOf is the UTC Monday, Sunday inclusive", async () => {
    const { leadSourcingWeekOf } = await import(
      "@/server/services/hq-lead-sourcing-runner"
    );
    expect(leadSourcingWeekOf(new Date("2026-08-24T00:00:00Z"))).toBe("2026-08-24"); // Monday
    expect(leadSourcingWeekOf(new Date("2026-08-30T23:59:59Z"))).toBe("2026-08-24"); // Sunday
    expect(leadSourcingWeekOf(new Date("2026-08-31T00:00:00Z"))).toBe("2026-08-31");
  });
});
