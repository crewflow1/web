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
 *      (duplicate prevented — via the BATCHED existence check, not an N+1)
 *   5. insert losing the unique-index race (23505) → counted as already-sent,
 *      never a hard failure
 *   6. a stage with mixed candidates → already-sent ones are partitioned out
 *      before any send; only the fresh one is emailed + inserted
 *
 * The existence check is one query per stage (select invoice_id ... in
 * (...candidate ids)), so the mock returns a *row list* for the
 * `existing` queue, not a count.
 */

// -- Mock factory --------------------------------------------------------

type QueueEntry = { data?: unknown; error?: unknown };
type Queues = {
  // Per-stage candidate query (invoices to consider for a stage)
  candidates: QueueEntry[];
  // Per-stage batched "which of these already have a row?" query.
  // data = array of { invoice_id } already recorded for the stage.
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
    // The candidate scan now pages via fetchAllRows, so the terminal method is
    // `.range(from, to)` (returns the chain; awaiting it resolves the page). Test
    // data is a handful of rows — a single short page — so one `then` per stage.
    "range",
  ]);

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};

    for (const m of passthrough) {
      chain[m] = () => chain;
    }
    chain.limit = () => chain;

    // Awaiting a select chain. Discriminate purely by table:
    //   invoices           → the per-stage candidate list
    //   invoice_reminders  → the batched existence query (row list)
    Object.defineProperty(chain, "then", {
      value: (resolve: (v: QueueEntry) => unknown) => {
        if (table === "invoices") {
          return resolve(pop("candidates"));
        }
        if (table === "invoice_reminders") {
          const entry = pop("existing");
          return resolve({ data: entry.data ?? [], error: entry.error ?? null });
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

function makeInvoice(
  opts: { sent_at: string; status?: string; id?: string; email?: string | null } = {
    sent_at: "2026-05-17T09:00:00Z",
  },
) {
  return {
    id: opts.id ?? "invoice-uuid-1",
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
    quote: { customer: { email: opts.email === undefined ? "customer@example.com" : opts.email } },
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
    // .neq('status', 'paid') filter is doing the work. No existence
    // query fires because the candidate set is empty.
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
    const inv = makeInvoice({ sent_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    mockAdmin.enqueue("candidates", { data: [inv], error: null }); // day_3
    mockAdmin.enqueue("existing", { data: [] }); // no prior day_3 row
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
    mockAdmin.enqueue("existing", { data: [] });
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
    // Batched existence check returns this invoice → skip.
    mockAdmin.enqueue("existing", { data: [{ invoice_id: inv.id }] });
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_14
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_21

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.sent).toBe(0);
    expect(body.skipped_already_sent).toBe(1);
    expect(sendInvoiceEmailMock).not.toHaveBeenCalled();
    expect(mockAdmin.reminderInserts).toHaveLength(0);
  });

  it("insert losing the unique-index race (23505) is treated as already-sent, not a failure", async () => {
    const inv = makeInvoice({ sent_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    mockAdmin.enqueue("candidates", { data: [inv], error: null }); // day_3
    mockAdmin.enqueue("existing", { data: [] }); // batch check says fresh
    // ...but the insert hits the partial unique index (another run beat us).
    mockAdmin.enqueue("insertReminder", { data: null, error: { code: "23505" } });
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_7
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_14
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_21

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.failed).toBe(0);
    expect(body.sent).toBe(0);
    expect(body.skipped_already_sent).toBe(1);
    // The email DID go out before the insert — the unique index only
    // guards the row, not the network call.
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
  });

  it("mixed stage: already-sent candidate is partitioned out before any send", async () => {
    const done = makeInvoice({
      id: "invoice-done",
      sent_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    const fresh = makeInvoice({
      id: "invoice-fresh",
      sent_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    mockAdmin.enqueue("candidates", { data: [done, fresh], error: null }); // day_3
    mockAdmin.enqueue("existing", { data: [{ invoice_id: done.id }] }); // done already recorded
    mockAdmin.enqueue("insertReminder", { data: null, error: null }); // for fresh
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_7
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_14
    mockAdmin.enqueue("candidates", { data: [], error: null }); // day_21

    const res = await GET(fakeRequest);
    const body = await res.json();

    expect(body.scanned).toBe(2);
    expect(body.skipped_already_sent).toBe(1);
    expect(body.sent).toBe(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledTimes(1);
    expect(sendInvoiceEmailMock).toHaveBeenCalledWith(
      mockAdmin.client,
      fresh.id,
      { kind: "reminder", reminder_stage: "day_3" },
    );
    expect(mockAdmin.reminderInserts).toHaveLength(1);
    expect(mockAdmin.reminderInserts[0]).toMatchObject({ invoice_id: fresh.id });
  });
});
