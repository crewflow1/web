import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the public-portal accept-quote flow in
 * app/(app)/quotes/actions.ts → acceptQuoteByToken / declineQuoteByToken.
 *
 * Mocks the Supabase admin client and the sendInvoiceEmail helper so the
 * tests stay fast and pure (no DB, no PDF, no network). What we verify:
 *   1. accept once → invoice INSERT called with correct totals
 *   2. accept twice → second call exits early, no second invoice insert
 *   3. decline → no invoice insert
 *   4. invoice payload amount == quote.subtotal AND vat_total == quote.vat_total
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
    rpc: async () => pop("rpc"),
  };

  return {
    client,
    queue,
    inserts,
    updates,
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

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

// requireOrgContext is only used by owner-path; stub it too.
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "test-org" }, user: { id: "test-user" } },
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockAdmin.client),
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
  sendInvoiceEmailMock.mockClear();
});

// ------------------------------------------------------------------------

describe("acceptQuoteByToken", () => {
  it("creates exactly one invoice + one job on first accept, copying totals + linking them", async () => {
    // 1. lookup quote by token
    mockAdmin.enqueue("maybeSingle", { data: SAMPLE_QUOTE, error: null });
    // 2. update quote → accepted
    mockAdmin.enqueue("update", { data: null, error: null });
    // 3. insert into signatures polymorphic table (Phase G)
    mockAdmin.enqueue("insert", { data: null, error: null });
    // 4. insert job (auto-create, returns id via .select().single())
    mockAdmin.enqueue("insert", { data: { id: "job-uuid-1" }, error: null });
    // 5. update quote with job_id
    mockAdmin.enqueue("update", { data: null, error: null });
    // 6. next_invoice_number rpc
    mockAdmin.enqueue("rpc", { data: "INV-0001", error: null });
    // 7. insert invoice
    mockAdmin.enqueue("insert", { data: { id: "invoice-uuid-1" }, error: null });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", "iphash");

    expect(res).toEqual({ ok: true, quoteId: "quote-uuid-1" });

    // Exactly one invoice INSERT was attempted with the new job_id
    const invoiceInserts = mockAdmin.inserts.filter(
      (p): p is { quote_id: string; amount: number; vat_total: number; status: string; job_id: string | null } =>
        typeof p === "object" && p !== null && "quote_id" in p,
    );
    expect(invoiceInserts).toHaveLength(1);
    const insertedInvoice = invoiceInserts[0];
    if (!insertedInvoice) throw new Error("unreachable — already asserted length");

    expect(insertedInvoice).toMatchObject({
      org_id: SAMPLE_QUOTE.org_id,
      quote_id: SAMPLE_QUOTE.id,
      number: "INV-0001",
      amount: SAMPLE_QUOTE.subtotal,
      vat_total: SAMPLE_QUOTE.vat_total,
      status: "draft",
      job_id: "job-uuid-1",
    });

    // Exactly one job INSERT was attempted
    const jobInserts = mockAdmin.inserts.filter(
      (p): p is { customer_id: string; status: string } =>
        typeof p === "object" && p !== null && "customer_id" in p && "status" in p && !("quote_id" in p),
    );
    expect(jobInserts).toHaveLength(1);
    expect(jobInserts[0]).toMatchObject({
      org_id: SAMPLE_QUOTE.org_id,
      customer_id: SAMPLE_QUOTE.customer_id,
      status: "new",
    });

    // Auto-email was attempted (no key → no_resend_key, but the call happens)
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      mockAdmin.client,
      "invoice-uuid-1",
    );
  });

  it("does NOT create a second job when the quote is a variation (job_id already set)", async () => {
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, job_id: "existing-job-uuid", variation_number: 2 },
      error: null,
    });
    mockAdmin.enqueue("update", { data: null, error: null });
    // Phase G signatures insert
    mockAdmin.enqueue("insert", { data: null, error: null });
    // No job-insert queued — variations skip auto-job creation.
    mockAdmin.enqueue("rpc", { data: "INV-0002", error: null });
    mockAdmin.enqueue("insert", { data: { id: "invoice-uuid-2" }, error: null });

    const res = await actions.acceptQuoteByToken("public-token-2", "Customer Name", null);
    expect(res).toEqual({ ok: true, quoteId: "quote-uuid-1" });

    const jobInserts = mockAdmin.inserts.filter(
      (p): p is { status: string } =>
        typeof p === "object" && p !== null && "status" in p && p.status === "new" && !("quote_id" in p),
    );
    expect(jobInserts).toHaveLength(0);

    // Invoice still carries the existing job_id.
    const invoiceInserts = mockAdmin.inserts.filter(
      (p): p is { job_id: string | null } =>
        typeof p === "object" && p !== null && "quote_id" in p,
    );
    expect(invoiceInserts[0]).toMatchObject({ job_id: "existing-job-uuid" });
  });

  it("does NOT create a duplicate invoice when accept is called a second time", async () => {
    // Lookup returns a quote that's already in 'accepted' status
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "accepted" },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer Name", null);

    // Returns ok with the existing quoteId — idempotent
    expect(res).toEqual({ ok: true, quoteId: SAMPLE_QUOTE.id });

    // Critically: no invoice insert, no email send
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
  });

  it("returns error and does NOT insert invoice when quote is already declined", async () => {
    mockAdmin.enqueue("maybeSingle", {
      data: { ...SAMPLE_QUOTE, status: "declined" },
      error: null,
    });

    const res = await actions.acceptQuoteByToken("public-token-1", "Customer", null);

    expect(res).toEqual({ ok: false, error: "Quote already declined" });
    expect(mockAdmin.inserts).toHaveLength(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
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
