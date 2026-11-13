import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the public-portal accept-quote flow in
 * app/(app)/quotes/actions.ts → acceptQuoteByToken / declineQuoteByToken.
 *
 * Mocks the Supabase admin client and the sendInvoiceEmail helper so the
 * tests stay fast and pure (no DB, no PDF, no network). What we verify:
 *   1. accept once → the atomic job+invoice step runs ONCE, pinned to the
 *      quote's org, with the net-14 due date; a fresh invoice is emailed
 *   2. accept twice → the step is re-run (it is idempotent and HEALS a partial
 *      first accept) but nothing is re-emailed when the invoice is reused
 *   3. decline → no job/invoice step at all
 *   4. a FAILED step is reported, never silently treated as success
 *
 * WHAT MOVED TO THE DATABASE. The job + invoice are no longer separate
 * PostgREST inserts made from this file — they are one transaction inside
 * `ensure_accepted_quote_artifacts` (migration 20261324000000). So the
 * assertions that used to inspect the INSERT payloads ("amount == subtotal",
 * "invoice carries the job id", "no second job for a variation", "no duplicate
 * invoice") cannot be made against a mock any more, and are made against REAL
 * Postgres instead, where they are stronger:
 * __tests__/integration/resilience/quote-accept-atomic.test.ts. What stays here
 * is the part that IS application logic: which path calls the step, with what
 * arguments, and what the user is told when it fails.
 */

// -- Mock factory --------------------------------------------------------
// Builds a Supabase client whose chained calls are configurable per-test.
// Each terminal operation (maybeSingle / single / rpc / update / insert) is
// resolved from queued responses. The chain itself is a Proxy that returns
// itself for any non-terminal method so we don't need to enumerate them all.

type QueueEntry = { data: unknown; error: unknown };

type Queues = {
  maybeSingle: QueueEntry[];
  single: QueueEntry[];
  update: QueueEntry[];
  insert: QueueEntry[];
  rpc: QueueEntry[];
  select: QueueEntry[];
};

function makeMockSupabase() {
  const queue: Queues = {
    maybeSingle: [],
    single: [],
    update: [],
    insert: [],
    rpc: [],
    select: [],
  };
  const inserts: unknown[] = [];
  const updates: unknown[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  function pop(key: keyof Queues): QueueEntry {
    const entry = queue[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

  // The chain method set we treat as "passthrough" — returns the proxy itself.
  const passthrough = new Set([
    "from",
    "select",
    "eq",
    "in",
    "is",
    "not",
    "lt",
    "lte",
    "gt",
    "gte",
    "order",
    "limit",
    "match",
  ]);

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of passthrough) chain[m] = () => chain;

    chain.maybeSingle = async () => pop("maybeSingle");
    chain.single = async () => pop("single");

    chain.insert = (payload: unknown) => {
      inserts.push(payload);
      // .insert(...).select(...).single() — return a chain that resolves on single
      const insertChain: Record<string, unknown> = {
        select: () => insertChain,
        single: async () => pop("insert"),
      };
      // Allow await on insert(...) directly too (returns first queued response)
      Object.defineProperty(insertChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("insert")),
      });
      return insertChain;
    };

    chain.update = (payload: unknown) => {
      updates.push(payload);
      const updateChain: Record<string, unknown> = {
        eq: () => updateChain,
        select: () => updateChain,
        single: async () => pop("update"),
      };
      Object.defineProperty(updateChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("update")),
      });
      return updateChain;
    };

    return chain;
  }

  const client = {
    from: () => makeChain(),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return pop("rpc");
    },
  };

  return {
    client,
    queue,
    inserts,
    updates,
    rpcCalls,
    enqueue(key: keyof Queues, entry: QueueEntry) {
      queue[key].push(entry);
    },
  };
}

// -- Module mocks --------------------------------------------------------

const mockAdmin = makeMockSupabase();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockAdmin.client,
}));

const sendInvoiceEmailMock = vi.fn(async () => ({
  sent: false,
  reason: "no_resend_key" as const,
}));

vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: sendInvoiceEmailMock,
}));

// Stub next/cache + next/navigation so the action file imports cleanly.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// redirect() THROWS in production (it never returns). Mirror that, so a test
// can assert exactly where the action sent the user and nothing runs past it.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// requireOrgContext is only used by owner-path; stub it too.
//
// The active org MUST match SAMPLE_QUOTE.org_id below. It used to be an
// arbitrary "test-org" because nothing derived from ctx — the owner path
// stamped its new job and invoice from `quote.org_id` instead. That was the
// active-org defect: accepting a quote resolved by id alone created the job,
// the invoice and its number in whatever org the quote turned out to belong
// to. The accepting UPDATE is now scoped to the active org, so a quote in a
// different org matches nothing and the flow bails long before job creation —
// which makes a fixture with mismatched orgs unreachable in practice, not just
// unrealistic. Keeping the two in sync is what the real flow guarantees.
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: {
      org: { id: "org-uuid-1" },
      // Management role so the owner-accept path passes the fix-1 guard —
      // these tests exercise acceptance mechanics, not authorization.
      membership: { org_id: "org-uuid-1", role: "owner" },
      user: { id: "test-user" },
    },
    user: { id: "test-user" },
  })),
  requireManagementRole: (ctx?: { membership?: { role?: string } }) => {
    const role = ctx?.membership?.role;
    if (role !== "owner" && role !== "admin") {
      throw new Error("REDIRECT:/dashboard?error=forbidden");
    }
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockAdmin.client),
}));

// acceptQuoteAsOwner dispatches a `quote.accepted` automation event — stub it
// so the owner-path tests don't touch the real dispatcher.
vi.mock("@/server/services/automation-dispatcher", () => ({
  dispatchAutomation: vi.fn(async () => ({ ok: true })),
}));

// -- Imports under test (after mocks) ------------------------------------
const actions = await import("@/app/(app)/quotes/actions");

// -- Test fixtures -------------------------------------------------------
const SAMPLE_QUOTE = {
  id: "quote-uuid-1",
  org_id: "org-uuid-1",
  status: "sent",
  subtotal: 1000,
  vat_total: 200,
  valid_until: null,
  lead_id: null,
  job_id: null,
  variation_number: null,
  customer_id: "customer-uuid-1",
  number: "Q-0001",
  notes: null,
};

beforeEach(() => {
  mockAdmin.queue.maybeSingle.length = 0;
  mockAdmin.queue.single.length = 0;
  mockAdmin.queue.update.length = 0;
  mockAdmin.queue.insert.length = 0;
  mockAdmin.queue.rpc.length = 0;
  mockAdmin.queue.select.length = 0;
  mockAdmin.inserts.length = 0;
  mockAdmin.updates.length = 0;
  mockAdmin.rpcCalls.length = 0;
  sendInvoiceEmailMock.mockClear();
});

/** The atomic job+invoice step's calls (there must never be more than one per accept). */
const ensureCalls = () =>
  mockAdmin.rpcCalls.filter((c) => c.fn === "ensure_accepted_quote_artifacts");

/** No job or invoice is ever written from application code any more. */
function expectNoDirectJobOrInvoiceInsert() {
  const direct = mockAdmin.inserts.filter(
    (p) =>
      typeof p === "object" &&
      p !== null &&
      ("quote_id" in p || ("customer_id" in p && "status" in p)),
  );
  expect(direct, "job/invoice must only be created inside the atomic RPC").toHaveLength(0);
  expect(mockAdmin.rpcCalls.some((c) => c.fn === "next_invoice_number")).toBe(false);
}

// ------------------------------------------------------------------------

describe("acceptQuoteByToken", () => {
  it("first accept runs the atomic job+invoice step ONCE (org-pinned, net-14) and emails the fresh invoice", async () => {
    // 1. lookup quote by token
    mockAdmin.enqueue("maybeSingle", { data: SAMPLE_QUOTE, error: null });
    // 2. update quote → accepted
    mockAdmin.enqueue("update", { data: null, error: null });
    // 3. insert into signatures polymorphic table (Phase G)
    mockAdmin.enqueue("insert", { data: null, error: null });
    // 4. the ONE atomic job+invoice step
    mockAdmin.enqueue("rpc", {
      data: { job_id: "job-uuid-1", invoice_id: "invoice-uuid-1", created_job: true, created_invoice: true },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", "iphash");

    expect(res).toEqual({ ok: true, quoteId: "quote-uuid-1" });

    expect(ensureCalls()).toHaveLength(1);
    expect(ensureCalls()[0]!.args).toMatchObject({
      // Pinned to the quote's OWN org — the token path has no session org.
      p_org_id: SAMPLE_QUOTE.org_id,
      p_quote_id: SAMPLE_QUOTE.id,
      // BUG-03: auto-created invoice carries a net-14 due date, not null.
      p_due_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      // The job carry: provenance note for the job the step will create.
      p_job_notes: expect.stringContaining("Auto-created from accepted quote Q-0001"),
    });
    expectNoDirectJobOrInvoiceInsert();

    // Auto-email was attempted (no key → no_resend_key, but the call happens)
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(mockAdmin.client, "invoice-uuid-1");
  });

  it("a variation (job_id already set) sends NO job carry — the step reuses the parent job", async () => {
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, job_id: "existing-job-uuid", variation_number: 2 },
      error: null,
    });
    mockAdmin.enqueue("update", { data: null, error: null });
    mockAdmin.enqueue("insert", { data: null, error: null }); // signatures
    mockAdmin.enqueue("rpc", {
      data: { job_id: "existing-job-uuid", invoice_id: "invoice-uuid-2", created_job: false, created_invoice: true },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-2", "Customer Name", null);
    expect(res).toEqual({ ok: true, quoteId: "quote-uuid-1" });

    expect(ensureCalls()).toHaveLength(1);
    expect(ensureCalls()[0]!.args).toMatchObject({ p_job_notes: null, p_job_site_address: null });
    expectNoDirectJobOrInvoiceInsert();
  });

  it("re-accept of a COMPLETE quote re-runs the idempotent step but re-emails nothing", async () => {
    // Lookup returns a quote already 'accepted' with its job + invoice from the first accept.
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "accepted", job_id: "existing-job" },
      error: null,
    });
    // The step FINDS the invoice the first accept created → reuse, nothing created.
    mockAdmin.enqueue("rpc", {
      data: { job_id: "existing-job", invoice_id: "invoice-uuid-1", created_job: false, created_invoice: false },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", null);

    // Returns ok with the existing quoteId — idempotent
    expect(res).toEqual({ ok: true, quoteId: SAMPLE_QUOTE.id });

    // Critically: no status/signature re-write, no insert of any kind, no email.
    expect(mockAdmin.updates).toHaveLength(0);
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("BACKFILLS a missing invoice on re-accept (heals a partial first accept) and emails it", async () => {
    // Already 'accepted' BUT the first accept's job+invoice step had failed, so NO
    // invoice is linked. The re-accept must run the step again (and email the
    // invoice it creates), not no-op.
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "accepted", job_id: "existing-job" },
      error: null,
    });
    mockAdmin.enqueue("rpc", {
      data: { job_id: "existing-job", invoice_id: "invoice-backfilled", created_job: false, created_invoice: true },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", null);
    expect(res).toEqual({ ok: true, quoteId: SAMPLE_QUOTE.id });

    expect(ensureCalls()).toHaveLength(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(mockAdmin.client, "invoice-backfilled");
  });

  it("FAULT: the job+invoice step fails → acceptance stands, nothing is emailed, the failure is logged loudly", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAdmin.enqueue("maybeSingle", { data: SAMPLE_QUOTE, error: null });
    mockAdmin.enqueue("update", { data: null, error: null });
    mockAdmin.enqueue("insert", { data: null, error: null }); // signatures
    // The database is unavailable / the transaction aborted and rolled back.
    mockAdmin.enqueue("rpc", { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", null);

    // The customer's decision was recorded and is not thrown away…
    expect(res).toEqual({ ok: true, quoteId: SAMPLE_QUOTE.id });
    // …but no invoice exists, so none may be emailed, and nothing was written
    // piecemeal from here (the DB rolled the step back as a unit).
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    expectNoDirectJobOrInvoiceInsert();
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes("accepted quote left without job/invoice")),
      "the invoice-less state must be loud, not a silent log line",
    ).toBe(true);
    errorSpy.mockRestore();
  });

  it("returns error and does NOT run the job+invoice step when quote is already declined", async () => {
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "declined" },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer", null);

    expect(res).toEqual({ ok: false, error: "Quote already declined" });
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(ensureCalls()).toHaveLength(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });
});

describe("acceptQuoteAsOwner", () => {
  // Owner accepts "on the customer's behalf" (e.g. confirmed by phone).
  // redirect() throws (as in production), so each test asserts the destination.
  const ownerFormData = {
    get: (k: string) => (k === "signer_name" ? "Owner Test" : null),
  } as unknown as FormData;

  it("accepts, runs the atomic job+invoice step in the ACTIVE org, emails the fresh invoice, redirects saved=accepted", async () => {
    // 1. idempotency pre-read: quote not yet accepted → no short-circuit
    mockAdmin.enqueue("maybeSingle", { data: { ...SAMPLE_QUOTE, status: "sent" }, error: null });
    // 2. update quote → accepted (returns the quote row via .select().single())
    mockAdmin.enqueue("update", { data: SAMPLE_QUOTE, error: null });
    // 3. the ONE atomic job+invoice step
    mockAdmin.enqueue("rpc", {
      data: { job_id: "owner-job-1", invoice_id: "owner-invoice-1", created_job: true, created_invoice: true },
      error: null,
    });
    // 4. lead lookup (no linked lead)
    mockAdmin.enqueue("maybeSingle", { data: { lead_id: null }, error: null });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      "REDIRECT:/quotes/quote-uuid-1?saved=accepted",
    );

    expect(ensureCalls()).toHaveLength(1);
    expect(ensureCalls()[0]!.args).toMatchObject({
      p_org_id: "org-uuid-1", // the ACTIVE org from the session, never the row's
      p_quote_id: SAMPLE_QUOTE.id,
      p_due_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expectNoDirectJobOrInvoiceInsert();

    // Invoice email send was attempted against the new invoice, carrying the
    // ACTIVE org so the helper re-applies the scope to its own load — this
    // send renders the org's letterhead and bank details, so it must not be
    // able to resolve an invoice outside the org that triggered it.
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      mockAdmin.client,
      "owner-invoice-1",
      { orgId: "org-uuid-1" },
    );
  });

  it("FAULT: the job+invoice step fails → STILL advances the lead, then redirects with warn=invoice_skipped (never plain success)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAdmin.enqueue("maybeSingle", { data: { ...SAMPLE_QUOTE, status: "sent" }, error: null });
    mockAdmin.enqueue("update", { data: SAMPLE_QUOTE, error: null });
    mockAdmin.enqueue("rpc", { data: null, error: { code: "40001", message: "could not serialize access" } });
    // The accept continues: lead lookup finds a linked lead → advanced to won.
    mockAdmin.enqueue("maybeSingle", { data: { lead_id: "lead-uuid-1" }, error: null });
    mockAdmin.enqueue("update", { data: null, error: null });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      "REDIRECT:/quotes/quote-uuid-1?saved=accepted&warn=invoice_skipped",
    );

    // Before the fix an invoice failure redirected away BEFORE this write.
    expect(mockAdmin.updates).toContainEqual(expect.objectContaining({ status: "won" }));
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    expectNoDirectJobOrInvoiceInsert();
    errorSpy.mockRestore();
  });

  it("re-accept of an already-accepted quote HEALS: runs only the idempotent step, never re-stamps the acceptance", async () => {
    // Owner clicks accept again after a `warn=invoice_skipped`. The pre-read sees
    // status=accepted with no job. This used to redirect saved=accepted having
    // created nothing — the quote stayed invoice-less and the retry said "done".
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "accepted" },
      error: null,
    });
    mockAdmin.enqueue("rpc", {
      data: { job_id: "healed-job", invoice_id: "healed-invoice", created_job: true, created_invoice: true },
      error: null,
    });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      "REDIRECT:/quotes/quote-uuid-1?saved=accepted",
    );

    expect(ensureCalls()).toHaveLength(1);
    // The acceptance itself (status / accepted_at / signature) is NOT rewritten.
    expect(mockAdmin.updates).toHaveLength(0);
    // The backfilled invoice is new to the customer → emailed once.
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(mockAdmin.client, "healed-invoice", { orgId: "org-uuid-1" });
  });

  it("re-accept of a COMPLETE quote is a clean no-op: nothing created, nothing emailed", async () => {
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "accepted", job_id: "existing-job-x" },
      error: null,
    });
    mockAdmin.enqueue("rpc", {
      data: { job_id: "existing-job-x", invoice_id: "existing-inv-x", created_job: false, created_invoice: false },
      error: null,
    });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      "REDIRECT:/quotes/quote-uuid-1?saved=accepted",
    );

    expect(mockAdmin.inserts).toHaveLength(0);
    expect(mockAdmin.updates).toHaveLength(0);
    // No duplicate email — the customer already got the invoice on first accept.
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("FAULT: re-accept heal that STILL cannot create the invoice keeps the warning up (no false success)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAdmin.enqueue("maybeSingle", { data: { ...SAMPLE_QUOTE, status: "accepted" }, error: null });
    mockAdmin.enqueue("rpc", { data: null, error: { code: "53300", message: "too many connections" } });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      "REDIRECT:/quotes/quote-uuid-1?saved=accepted&warn=invoice_skipped",
    );
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("FAULT: the pre-read itself fails → throws loudly, writes NOTHING (a failed read is not 'not accepted yet')", async () => {
    mockAdmin.enqueue("maybeSingle", { data: null, error: { code: "PGRST000", message: "connection refused" } });

    await expect(actions.acceptQuoteAsOwner("quote-uuid-1", ownerFormData)).rejects.toThrow(
      /quote accept: quote read failed/,
    );
    expect(mockAdmin.updates).toHaveLength(0);
    expect(ensureCalls()).toHaveLength(0);
  });
});

describe("declineQuoteByToken", () => {
  it("does NOT create an invoice on decline", async () => {
    // 1. lookup quote by token
    mockAdmin.enqueue("maybeSingle", { data: SAMPLE_QUOTE, error: null });
    // 2. update quote → declined
    mockAdmin.enqueue("update", { data: null, error: null });

    const res = await actions.declineQuoteByToken("public-token-1", "Too expensive");

    expect(res).toEqual({ ok: true, quoteId: SAMPLE_QUOTE.id });
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });
});
