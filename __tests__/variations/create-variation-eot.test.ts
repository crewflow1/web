import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression proofs for `createVariation` in app/(app)/quotes/actions.ts.
 *
 * TWO defects are pinned here.
 *
 * 1. THE SEMANTIC DEFECT (live before 20261073). The variation form captures a
 *    completion date — an extension-of-time REQUEST — and the action wrote it
 *    into `quotes.valid_until`, the QUOTE EXPIRY column. That is not a cosmetic
 *    mislabel: `acceptQuoteByToken` force-writes status='expired' once
 *    valid_until is past, so a variation asking "please let us finish by 30
 *    Sept" became un-acceptable by the customer on 1 Oct, with no operator
 *    action and no warning. The PDF and the portal also printed the date under
 *    "Valid until".
 *
 * 2. THE DISCARDED COST BASIS. computeVariation() derives revenue from cost +
 *    target margin, then used the cost only to apportion revenue across
 *    line-item unit_price. Because the apportionment preserves only the RATIOS,
 *    the absolute cost — and so the margin the business priced the work at —
 *    was unrecoverable the instant the variation saved.
 *
 * Mocked Supabase + navigation: what matters is the exact INSERT payload, which
 * is the thing that regressed.
 */

type QueueEntry = { data: unknown; error: unknown };
type Queues = { maybeSingle: QueueEntry[]; single: QueueEntry[]; insert: QueueEntry[]; rpc: QueueEntry[] };

function makeMockSupabase() {
  const queue: Queues = { maybeSingle: [], single: [], insert: [], rpc: [] };
  const inserts: unknown[] = [];

  function pop(key: keyof Queues): QueueEntry {
    const entry = queue[key].shift();
    if (!entry) throw new Error(`no queued response for ${key}`);
    return entry;
  }

  const passthrough = new Set(["from", "select", "eq", "in", "is", "not", "order", "limit", "match"]);

  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    for (const m of passthrough) chain[m] = () => chain;
    chain.maybeSingle = async () => pop("maybeSingle");
    chain.single = async () => pop("single");
    chain.insert = (payload: unknown) => {
      inserts.push(payload);
      const insertChain: Record<string, unknown> = {
        select: () => insertChain,
        single: async () => pop("insert"),
      };
      Object.defineProperty(insertChain, "then", {
        value: (resolve: (v: QueueEntry) => unknown) => resolve(pop("insert")),
      });
      return insertChain;
    };
    return chain;
  }

  return {
    client: { from: () => makeChain(), rpc: async () => pop("rpc") },
    queue,
    inserts,
    enqueue(key: keyof Queues, entry: QueueEntry) {
      queue[key].push(entry);
    },
  };
}

const mock = makeMockSupabase();

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => mock.client) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mock.client }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// redirect() throws in Next so control never falls through it; emulate that or
// the action would keep running past its terminal branch.
class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    user: { id: USER_ID, email: "op@example.com" },
    ctx: { org: { id: ORG_ID }, membership: { role: "owner" } },
  })),
}));

// The job load is the active-org chokepoint; return a job in the active org.
vi.mock("@/lib/jobs/load", () => ({
  loadJobForOrg: vi.fn(async () => ({ id: JOB_ID, customer_id: CUSTOMER_ID })),
}));

vi.mock("@/lib/email/send-invoice", () => ({
  sendInvoiceEmail: vi.fn(async () => ({ sent: false, reason: "no_resend_key" as const })),
}));
vi.mock("@/server/services/automation-dispatcher", () => ({
  dispatchAutomation: vi.fn(async () => ({ ok: true })),
}));

const actions = await import("@/app/(app)/quotes/actions");

/** The form the operator submits, with an EoT request on it. */
function variationForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  const values: Record<string, string> = {
    title: "Additional bathroom tiling",
    description: "Client added the second bathroom",
    labour_cost: "400",
    materials_cost: "300",
    subcontractor_cost: "200",
    misc_cost: "100",
    margin_pct: "25",
    vat_rate: "20",
    note: "",
    eot_requested_completion_date: "2026-09-30",
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

type QuoteInsert = Record<string, unknown> & { variation_number?: number };

/** Run createVariation and return the quotes INSERT payload it built. */
async function runAndCaptureQuoteInsert(fd: FormData): Promise<QuoteInsert> {
  mock.enqueue("rpc", { data: "Q-0007", error: null }); // next_quote_number
  mock.enqueue("rpc", { data: 3, error: null }); // next_variation_number
  mock.enqueue("insert", { data: { id: "variation-uuid-1" }, error: null }); // quotes insert
  mock.enqueue("insert", { data: null, error: null }); // quote_line_items insert

  await expect(actions.createVariation(JOB_ID, fd)).rejects.toThrow(/^REDIRECT:/);

  const quoteInsert = mock.inserts.find(
    (p): p is QuoteInsert =>
      typeof p === "object" && p !== null && "variation_number" in (p as object),
  );
  if (!quoteInsert) throw new Error("no quotes INSERT captured");
  return quoteInsert;
}

beforeEach(() => {
  mock.queue.maybeSingle.length = 0;
  mock.queue.single.length = 0;
  mock.queue.insert.length = 0;
  mock.queue.rpc.length = 0;
  mock.inserts.length = 0;
});

describe("createVariation · extension of time is not a quote expiry", () => {
  it("NEVER writes the requested completion date into valid_until", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());

    // The defect, stated as an assertion: the EoT date must not appear as an
    // expiry. If this fails, variations self-expire on the date the customer
    // was asked to agree as a completion date.
    expect(row.valid_until).not.toBe("2026-09-30");
    expect(row.valid_until).toBeNull();
  });

  it("stores it as eot_requested_completion_date instead", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect(row.eot_requested_completion_date).toBe("2026-09-30");
  });

  it("leaves both date columns null when no completion date is requested", async () => {
    const row = await runAndCaptureQuoteInsert(
      variationForm({ eot_requested_completion_date: "" }),
    );
    expect(row.eot_requested_completion_date).toBeNull();
    expect(row.valid_until).toBeNull();
  });

  it("accepts a PAST requested date — retrospective EoT claims are normal", async () => {
    // Deliberately not validated as future-only: in construction you routinely
    // claim an extension after the delay has already happened.
    const row = await runAndCaptureQuoteInsert(
      variationForm({ eot_requested_completion_date: "2020-01-15" }),
    );
    expect(row.eot_requested_completion_date).toBe("2020-01-15");
    expect(row.valid_until).toBeNull();
  });

  it("records no agreed date on creation — an EoT is agreed later, never assumed", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect(row.eot_agreed_completion_date).toBeUndefined();
    expect(row.eot_agreed_at).toBeUndefined();
  });

  it("writes NOTHING to the job — an accepted EoT never auto-moves the programme", async () => {
    await runAndCaptureQuoteInsert(variationForm());
    // Only two inserts happen, and neither is a job/date write.
    const jobWrites = mock.inserts.filter(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        ("target_completion_date" in (p as object) ||
          "scheduled_end" in (p as object) ||
          "end_date" in (p as object)),
    );
    expect(jobWrites).toHaveLength(0);
  });
});

describe("createVariation · the priced cost basis is persisted", () => {
  it("stores each cost bucket on the variation row", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect(row.cost_labour).toBe(400);
    expect(row.cost_materials).toBe(300);
    expect(row.cost_subcontractors).toBe(200);
    expect(row.cost_misc).toBe(100);
  });

  it("does NOT write cost_total — it is a generated column, so it cannot diverge", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect("cost_total" in row).toBe(false);
  });

  it("does NOT store a margin — margin stays derived from subtotal and cost", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect("margin_pct" in row).toBe(false);
    // Everything a margin needs is on the row: 1333.33 revenue over 1000 cost.
    const cost =
      Number(row.cost_labour) +
      Number(row.cost_materials) +
      Number(row.cost_subcontractors) +
      Number(row.cost_misc);
    expect(cost).toBe(1000);
    expect(row.subtotal).toBe(1333.33);
    expect(Math.round(((1333.33 - cost) / 1333.33) * 100)).toBe(25);
  });

  it("the persisted cost is the SAME figure the line-item split was derived from", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    const lineItems = mock.inserts.find(
      (p): p is Array<{ description: string; unit_price: number }> => Array.isArray(p),
    );
    if (!lineItems) throw new Error("no line-item INSERT captured");

    // The lines carry revenue apportioned by cost share; the row carries the
    // costs those shares came from. Same source, so they can't disagree.
    const revenue = lineItems.reduce((s, l) => s + Number(l.unit_price), 0);
    expect(revenue).toBeCloseTo(Number(row.subtotal), 2);
    const labourShare =
      Number(lineItems.find((l) => l.description === "Labour")?.unit_price ?? 0) / revenue;
    expect(labourShare).toBeCloseTo(400 / 1000, 4);
  });

  it("records a zero cost basis as zero, not as absent", async () => {
    const row = await runAndCaptureQuoteInsert(
      variationForm({
        labour_cost: "0",
        materials_cost: "0",
        subcontractor_cost: "0",
        misc_cost: "0",
        margin_pct: "0",
      }),
    );
    // 0 and NULL mean different things: "priced at no cost" vs "never priced".
    expect(row.cost_labour).toBe(0);
    expect(row.cost_materials).toBe(0);
    expect(row.cost_subcontractors).toBe(0);
    expect(row.cost_misc).toBe(0);
  });
});

describe("createVariation · accepted-quote money maths unchanged", () => {
  it("still writes subtotal / vat_total / total exactly as computeVariation derived them", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    // Guards the revised-contract-value chain: /jobs/[id] sums accepted
    // variations' `total` into the revised value, so these three must not move.
    expect(row.subtotal).toBe(1333.33);
    expect(row.vat_total).toBe(266.67);
    expect(row.total).toBe(1600);
  });

  it("stamps org_id from the ACTIVE org context, not from the job row", async () => {
    const row = await runAndCaptureQuoteInsert(variationForm());
    expect(row.org_id).toBe(ORG_ID);
    expect(row.job_id).toBe(JOB_ID);
    expect(row.customer_id).toBe(CUSTOMER_ID);
  });
});
