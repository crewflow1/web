import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * G-7 — duplicate-as-new-draft unit tests.
 *
 * The locked-quote banner used to promise "duplicate it as a new draft (not yet
 * implemented)". This suite pins the real implementation
 * (`duplicateQuoteAsDraft` in app/(app)/quotes/actions.ts), hermetically
 * (mocked Supabase + org context, mirroring approval-workflow.test.ts):
 *
 *   1. Clone correctness — every line item copied (description/qty/unit/price/
 *      VAT, re-sorted 0..n), totals recomputed, status=draft, a FRESH number
 *      from next_quote_number, a FRESH public_token (never the source's), and
 *      NO lifecycle carry (valid_until reset — the clone-default lesson).
 *   2. Org isolation — the source read is ACTIVE-org pinned, so another org's
 *      quote id resolves to nothing and NOTHING is written.
 *   3. Audit row — `_record_activity` records quote.duplicated naming both the
 *      new draft and the source.
 *   4. Role gate — staff are refused exactly like the sibling quote actions.
 */

type QueueEntry = { data?: unknown; error?: unknown };

function makeMockSupabase() {
  const queues = {
    quoteLookup: [] as QueueEntry[], // quotes select … maybeSingle
    lines: [] as QueueEntry[], // quote_line_items select … range (one page)
    quoteInsert: [] as QueueEntry[], // quotes insert … single
    lineInsert: [] as QueueEntry[], // quote_line_items insert (thenable)
  };
  const inserts: Array<{ table: string; payload: unknown }> = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  const eqFilters: Array<{ table: string; col: string; val: unknown }> = [];

  function pop(key: keyof typeof queues): QueueEntry {
    const entry = queues[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

  function makeChain(table: string): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    for (const m of ["in", "is", "order", "limit"]) chain[m] = () => chain;
    chain.eq = (col: string, val: unknown) => {
      eqFilters.push({ table, col, val });
      return chain;
    };
    chain.maybeSingle = async () => {
      if (table === "quotes") return pop("quoteLookup");
      return { data: null, error: null };
    };
    chain.single = chain.maybeSingle;
    // fetchAllRows drives `.range(from, to)` and awaits the thenable.
    chain.range = () => ({
      then: (resolve: (v: QueueEntry) => unknown) => resolve(pop("lines")),
    });
    chain.insert = (payload: unknown) => {
      inserts.push({ table, payload });
      const insChain: Record<string, unknown> = {};
      insChain.select = () => insChain;
      insChain.single = async () => pop("quoteInsert");
      Object.defineProperty(insChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("lineInsert")),
      });
      return insChain;
    };
    return chain;
  }

  const client = {
    from: (t: string) => makeChain(t),
    rpc: async (
      fn: string,
      args: unknown,
    ): Promise<{ data: unknown; error: { message: string } | null }> => {
      rpcs.push({ fn, args });
      if (fn === "next_quote_number") return { data: "Q-0042", error: null };
      return { data: null, error: null };
    },
  };

  return { client, queues, inserts, rpcs, eqFilters };
}

const mockSb = makeMockSupabase();
const caller = { role: "owner" };

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockSb.client),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockSb.client,
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: {
      org: { id: "org-1" },
      membership: { org_id: "org-1", role: caller.role },
    },
    user: { id: "user-owner" },
  })),
  requireManagementRole: (ctx?: { membership?: { role?: string } }) => {
    const role = ctx?.membership?.role;
    if (role !== "owner" && role !== "admin") {
      redirectMock("/dashboard?error=forbidden");
    }
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const redirectMock = vi.fn((path: string) => {
  throw new Error(`__redirect:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: vi.fn(async () => ({ sent: false, reason: "no_resend_key" })),
}));

const actions = await import("@/app/(app)/quotes/actions");
const { INITIAL_FORM_STATE } = await import("@/lib/forms/state");

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

const SOURCE_QUOTE = {
  id: SOURCE_ID,
  number: "Q-0007",
  customer_id: "cust-1",
  property_id: "prop-1",
  lead_id: null,
  notes: "Original notes",
  terms: "50% deposit",
};

const SOURCE_LINES = [
  { description: "Strip out", qty: 1, unit: "ea", unit_price: 250, vat_rate: 20, sort_order: 0 },
  { description: "First fix", qty: 3, unit: "day", unit_price: 400, vat_rate: 20, sort_order: 1 },
];

function run() {
  return actions.duplicateQuoteAsDraft(SOURCE_ID, INITIAL_FORM_STATE, new FormData());
}

beforeEach(() => {
  caller.role = "owner";
  for (const k of Object.keys(mockSb.queues) as Array<keyof typeof mockSb.queues>) {
    mockSb.queues[k].length = 0;
  }
  mockSb.inserts.length = 0;
  mockSb.rpcs.length = 0;
  mockSb.eqFilters.length = 0;
  redirectMock.mockClear();
});

describe("duplicateQuoteAsDraft — clone correctness", () => {
  beforeEach(() => {
    mockSb.queues.quoteLookup.push({ data: SOURCE_QUOTE, error: null });
    mockSb.queues.lines.push({ data: SOURCE_LINES, error: null });
    mockSb.queues.quoteInsert.push({ data: { id: "q-new" }, error: null });
    mockSb.queues.lineInsert.push({ error: null });
  });

  it("creates a DRAFT with a fresh number, fresh token, recomputed totals and NO lifecycle carry", async () => {
    const state = await run();
    expect(state.ok).toBe(true);
    expect(state.redirectTo).toBe("/quotes/q-new?saved=duplicated");

    const quoteInsert = mockSb.inserts.find((i) => i.table === "quotes")!;
    const row = quoteInsert.payload as Record<string, unknown>;
    expect(row.org_id).toBe("org-1");
    expect(row.status).toBe("draft");
    expect(row.number).toBe("Q-0042"); // the fresh allocation, never the source's
    expect(row.number).not.toBe(SOURCE_QUOTE.number);
    expect(row.customer_id).toBe("cust-1");
    expect(row.property_id).toBe("prop-1");
    expect(row.notes).toBe("Original notes");
    expect(row.terms).toBe("50% deposit");
    // Clone-default lesson: validity anchors to the ORIGINAL's send — reset it.
    expect(row.valid_until).toBeNull();
    // Fresh share token — the source's public link must never open the copy.
    expect(typeof row.public_token).toBe("string");
    expect((row.public_token as string).length).toBeGreaterThan(0);
    expect(row.created_by).toBe("user-owner");
    // Totals recomputed from the cloned lines: 250 + 1200 = 1450 net, 20% VAT.
    expect(row.subtotal).toBe(1450);
    expect(row.vat_total).toBe(290);
    expect(row.total).toBe(1740);
    // The number came from the canonical allocation RPC.
    expect(mockSb.rpcs.some((r) => r.fn === "next_quote_number")).toBe(true);
  });

  it("copies every line item onto the NEW quote id with fresh sort order", async () => {
    await run();
    const lineInsert = mockSb.inserts.find((i) => i.table === "quote_line_items")!;
    const rows = lineInsert.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.description)).toEqual(["Strip out", "First fix"]);
    for (const [idx, r] of rows.entries()) {
      expect(r.quote_id).toBe("q-new"); // the copy, never the source
      expect(r.org_id).toBe("org-1");
      expect(r.sort_order).toBe(idx);
    }
    expect(rows[1]).toMatchObject({ qty: 3, unit: "day", unit_price: 400, vat_rate: 20, line_total: 1200 });
  });

  it("records the quote.duplicated audit row naming both the draft and its source", async () => {
    await run();
    const audit = mockSb.rpcs.find((r) => r.fn === "_record_activity");
    expect(audit).toBeTruthy();
    expect(audit!.args).toMatchObject({
      p_org_id: "org-1",
      p_action: "quote.duplicated",
      p_target_table: "quotes",
      p_target_id: "q-new",
      p_metadata: {
        source_quote_id: SOURCE_ID,
        source_number: "Q-0007",
        actor_id: "user-owner",
        line_items: 2,
      },
    });
  });

  it("the source read is ACTIVE-org pinned (both id and org_id filters applied)", async () => {
    await run();
    const quoteFilters = mockSb.eqFilters.filter((f) => f.table === "quotes");
    expect(quoteFilters).toContainEqual({ table: "quotes", col: "id", val: SOURCE_ID });
    expect(quoteFilters).toContainEqual({ table: "quotes", col: "org_id", val: "org-1" });
  });
});

describe("duplicateQuoteAsDraft — isolation + gates", () => {
  it("another org's quote id resolves to NOTHING and NOTHING is written", async () => {
    // The org-pinned read returns no row (RLS/world where the id belongs elsewhere).
    mockSb.queues.quoteLookup.push({ data: null, error: null });
    const state = await run();
    expect(state.ok).toBe(false);
    expect(state.error).toMatch(/not found/i);
    expect(mockSb.inserts).toHaveLength(0);
    expect(mockSb.rpcs.filter((r) => r.fn === "_record_activity")).toHaveLength(0);
  });

  it("staff are refused before any read or write", async () => {
    caller.role = "staff";
    await expect(run()).rejects.toThrow(/__redirect:.*forbidden/);
    expect(mockSb.inserts).toHaveLength(0);
  });

  it("a failed number allocation returns a form error and writes NO quote", async () => {
    mockSb.queues.quoteLookup.push({ data: SOURCE_QUOTE, error: null });
    mockSb.queues.lines.push({ data: SOURCE_LINES, error: null });
    const failingRpc = vi
      .spyOn(mockSb.client, "rpc")
      .mockImplementation(async (fn: string) =>
        fn === "next_quote_number"
          ? { data: null, error: { message: "allocation failed" } }
          : { data: null, error: null },
      );
    const state = await run();
    failingRpc.mockRestore();
    expect(state.ok).toBe(false);
    expect(mockSb.inserts).toHaveLength(0);
  });
});
