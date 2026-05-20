import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for the four-stage invoice reminder cron at
 * app/api/cron/invoice-reminders/route.ts.
 *
 * Mocks the Supabase admin client and sendInvoiceEmail. What we verify:
 *   1. paid invoice → no reminder triggered (status filter excludes it)
 *   2. unpaid invoice at day_3 window → exactly one stage fires + row inserted
 *   3. unpaid invoice at day_14 window with no prior reminder → fires day_14
 *      (escalation works even without earlier stages)
 *   4. unpaid invoice at day_7 window with an existing day_7 row → skipped
 *      (duplicate prevented)
 */

// -- Mock factory --------------------------------------------------------

type QueueEntry = { data?: unknown; error?: unknown; count?: number };
type Queues = {
  // Per-stage candidate query (returns invoices to consider for a stage)
  candidates: QueueEntry[];
  // Per-candidate "does this stage already exist?" check (returns count)
  existing: QueueEntry[];
  // The reminder-row insert
  insertReminder: QueueEntry[];
};

function makeMockSupabase() {
  const queue: Queues = { candidates: [], existing: [], insertReminder: [] };
  const reminderInserts: unknown[] = [];

  function pop(key: keyof Queues): QueueEntry {
    const entry = queue[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

  // Each .from(table)... chain — we track whether the current chain is
  // a "candidates select" (terminates in `.limit().then`) or an
  // "existing select" (terminates in `.head=true` count) or an "insert".
  const passthrough = new Set([
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "not",
    "lt",
    "lte",
    "gt",
    "gte",
    "order",
    "match",
  ]);

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    let isCountQuery = false;

    chain.select = (_cols: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head && opts?.count === "exact") isCountQuery = true;
      return chain;
    };
    for (const m of passthrough) {
      if (m === "select") continue;
      chain[m] = () => chain;
    }
    chain.limit = () => chain;

    // .then handler — for candidates queries
    Object.defineProperty(chain, "then", {
      value: (resolve: (v: QueueEntry) => unknown) => {
        if (isCountQuery) {
          // count query against invoice_reminders
          const entry = pop("existing");
          return resolve({ count: entry.count ?? 0, data: null, error: entry.error ?? null });
        }
        // candidates select on invoices (or anything else)
        if (table === "invoices") {
          return resolve(pop("candidates"));
        }
        return resolve({ data: [], error: null });
      },
    });

    chain.insert = (payload: unknown) => {
      if (table === "invoice_reminders") reminderInserts.push(payload);
      const insertChain: Record<string, unknown> = {};
      Object.defineProperty(insertChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => {
          if (table === "invoice_reminders") return resolve(pop("insertReminder"));
          return resolve({ data: null, error: null });
        },
      });
      return insertChain;
    };

    return chain;
  }

  const client = {
    from: (table: string) => makeChain(table),
  };

  return {
    client,
    queue,
    reminderInserts,
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
  sent: true as const,
  emailId: "msg-1",
  to: "customer@example.com",
  sent_at: "2026-05-20T09:00:00Z",
  new_status: "sent",
}));

vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: sendInvoiceEmailMock,
}));

vi.mock("@/lib/cron/auth", () => ({
  isCronAuthorised: () => true,
}));

vi.mock("@/lib/env", () => ({
  env: { RESEND_API_KEY: "re_test", NODE_ENV: "test" },
}));

// -- Imports under test (after mocks) ------------------------------------
const { GET } = await import("@/app/api/cron/invoice-reminders/route");

// -- Test fixtures + helpers ---------------------------------------------

function makeInvoice(opts: { sent_at: string; status?: string } = { sent_at: "2026-05-17T09:00:00Z" }) {
  return {
    id: "invoice-uuid-1",
    org_id: "org-uuid-1",
    number: "INV-0001",
    status: opts.status ?? "sent",
    sent_at: opts.sent_at,
    amount: 1000,
    vat_total: 200,
    total: 1200,
    due_date: "2026-06-01",
    paid_at: null,
    notes: null,
    quote_id: "quote-uuid-1",
    quote: { customer: { email: "customer@example.com" } },
  };
}

const fakeRequest = new Request("https://crewflow.uk/api/cron/invoice-reminders", {
  headers: { authorization: "Bearer test" },
});

beforeEach(() => {
  mockAdmin.queue.candidates.length = 0;
  mockAdmin.queue.existing.length = 0;
  mockAdmin.queue.insertReminder.length = 0;
  mockAdmin.reminderInserts.length = 0;
  sendInvoiceEmailMock.mockClear();
});

// ------------------------------------------------------------------------

describe("invoice-reminders cron", () => {
  it("paid invoices are filtered out by the status query and no reminder is triggered", async () => {
    // The cron makes 4 candidate queries (one per stage). For paid
    // invoices to be excluded, each query returns an empty list — the
    // .neq('status', 'paid') filter is doing the work.
    for (let i = 0; i < 4; i++) {
      mockAdmin.enqueue("candidates", { data: [], error: null });
    }

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.sent).toBe(0);
    expect(body.scanned).toBe(0);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    expect(mockAdmin.reminderInserts).toHaveLength(0);
  });

  it("unpaid invoice sent 3 days ago → fires day_3 stage exactly once", async () => {
    // 3-days-ago invoice surfaces in the day_3 candidate query;
    // empty for day_7 / day_14 / day_21
    const inv = makeInvoice({ sent_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    mockAdmin.enqueue("candidates", { data: [inv], error: null }); // day_3
    mockAdmin.enqueue("existing", { count: 0 }); // no prior day_3 row
    mockAdmin.enqueue("insertReminder", { data: null, error: null });
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_7
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_14
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_21

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      mockAdmin.client,
      inv.id,
      { kind: "reminder", reminder_stage: "day_3" },
    );

    expect(mockAdmin.reminderInserts).toHaveLength(1);
    expect(mockAdmin.reminderInserts[0]).toMatchObject({
      invoice_id: inv.id,
      org_id: inv.org_id,
      stage: "day_3",
      recipient: "customer@example.com",
    });
  });

  it("unpaid invoice sent 14 days ago → fires day_14 escalation even without prior stages", async () => {
    const inv = makeInvoice({ sent_at: new Date(Date.now() - 14 * 86_400_000).toISOString() });
    // day_3 + day_7 candidates both empty (sent_at outside window).
    mockAdmin.enqueue("candidates", { data: [], error: null });
    mockAdmin.enqueue("candidates", { data: [], error: null });
    // day_14 hits.
    mockAdmin.enqueue("candidates", { data: [inv], error: null });
    mockAdmin.enqueue("existing", { count: 0 });
    mockAdmin.enqueue("insertReminder", { data: null, error: null });
    // day_21 empty
    mockAdmin.enqueue("candidates", { data: [], error: null });

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      mockAdmin.client,
      inv.id,
      { kind: "reminder", reminder_stage: "day_14" },
    );
    expect(mockAdmin.reminderInserts[0]).toMatchObject({ stage: "day_14" });
  });

  it("duplicate reminder prevented: existing row for the stage → skipped, no send", async () => {
    const inv = makeInvoice({ sent_at: new Date(Date.now() - 7 * 86_400_000).toISOString() });
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_3
    mockAdmin.enqueue("candidates", { data: [inv], error: null }); // day_7
    // Existing row found (count=1) → skip
    mockAdmin.enqueue("existing", { count: 1 });
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_14
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_21

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.skipped_already_sent).toBe(1);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    expect(mockAdmin.reminderInserts).toHaveLength(0);
  });
});
