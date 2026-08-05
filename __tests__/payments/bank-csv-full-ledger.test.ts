import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * F-1 — the bank-CSV auto-matcher must score against the COMPLETE outstanding
 * ledger, not the first PostgREST page.
 *
 * THE BUG. `uploadBankCsv` pulls the org's outstanding invoices and, for every
 * incoming statement line, scores it against ALL of them (schema.scoreInvoiceMatch),
 * writing a `suggested` match at score >= 70. The read was a bare `.select()`.
 * PostgREST clamps every response to `max_rows` (1000), so the moment an org
 * crosses 1000 open invoices the matcher silently stopped seeing invoices 1001+:
 * an incoming payment for one of them scored 0 against the truncated set and
 * persisted as `unmatched`, with no error anywhere. The fix pages the read via
 * fetchAllRows so the whole ledger is scored.
 *
 * THE TEST. A hermetic, cap-emulating Supabase mock (no realtime client, no DB):
 * the `invoices` query builder faithfully clamps a single response to 1000 rows,
 * and honours `.range(from,to)` so a paged reader can walk past the clamp. We seed
 * 1500 outstanding invoices with the ONLY viable match at index 1200 — beyond the
 * clamp — and upload a CSV line for it. If the read pages, the line is matched to
 * that invoice; if it were still a bare truncated read, it would persist unmatched.
 *
 * The first test proves the mock has teeth: a bare (un-ranged) read of the very
 * same dataset returns exactly 1000 rows and does NOT contain the target — i.e.
 * the clamp the fix defends against is real in this harness.
 */

/** PostgREST project cap — supabase/config.toml `max_rows`. */
const CAP = 1000;
const LEDGER_SIZE = 1500;
const TARGET_INDEX = 1200; // deliberately beyond the clamp

type Invoice = {
  id: string;
  number: string;
  total: number;
  sent_at: string | null;
  status: string;
  org_id: string;
  quote: { customer: { name: string } | null } | null;
};

/** Build the seeded outstanding ledger: 1500 rows, one viable match at 1200. */
function buildLedger(): Invoice[] {
  const rows: Invoice[] = [];
  for (let i = 0; i < LEDGER_SIZE; i++) {
    rows.push({
      // Zero-padded so ascending string-id order == insertion order (the paging
      // order the fix uses is `.order("id", { ascending: true })`).
      id: `inv-${String(i).padStart(5, "0")}`,
      number: `INV-${String(i).padStart(5, "0")}`,
      // Small, distinct totals nowhere near the target — none scores against the
      // target's amount (scoreInvoiceMatch returns 0 once the delta exceeds 5%).
      total: (i + 1) * 7,
      sent_at: "2026-04-01",
      status: "sent",
      org_id: "org-1",
      quote: { customer: { name: `Customer ${i}` } },
    });
  }
  const target = rows[TARGET_INDEX]!;
  target.number = "INV-TARGET-1200";
  target.total = 424242.42; // distinctive amount — only this invoice can match
  return rows;
}

let ledger: Invoice[] = [];
let insertedLines: Array<Record<string, unknown>> = [];

/**
 * A cap-emulating `invoices` query builder. Chainable + thenable; applies the
 * org/status filters and the id ordering, then:
 *   - with `.range(from,to)` → returns rows[from..to] (a paged reader's page),
 *   - without a range (a bare read) → clamps to the first CAP rows,
 * and NEVER returns more than CAP rows in a single response either way.
 */
function invoicesBuilder() {
  const state: { orgId?: string; statuses?: string[]; from?: number; to?: number } = {};
  // Typed `any`: this is a hand-rolled chainable/thenable test double, not the
  // real PostgrestFilterBuilder — precise typing would only obscure the harness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select: () => builder,
    order: () => builder,
    eq: (col: string, val: string) => {
      if (col === "org_id") state.orgId = val;
      return builder;
    },
    in: (col: string, vals: string[]) => {
      if (col === "status") state.statuses = vals;
      return builder;
    },
    range: (from: number, to: number) => {
      state.from = from;
      state.to = to;
      return builder;
    },
    then: (resolve: (v: { data: Invoice[]; error: null }) => void) => {
      let rows = ledger.filter(
        (i) =>
          (state.orgId === undefined || i.org_id === state.orgId) &&
          (state.statuses === undefined || state.statuses.includes(i.status)),
      );
      rows = rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      let out =
        state.from !== undefined
          ? rows.slice(state.from, (state.to ?? state.from) + 1)
          : rows;
      // The PostgREST clamp: a single response never exceeds CAP rows.
      if (out.length > CAP) out = out.slice(0, CAP);
      resolve({ data: out, error: null });
    },
  };
  return builder;
}

const fakeClient = {
  from: (table: string) => {
    if (table === "invoices") return invoicesBuilder();
    if (table === "bank_statements") {
      return {
        insert: () => ({
          select: () => ({
            single: async () => ({ data: { id: "stmt-1" }, error: null }),
          }),
        }),
      };
    }
    if (table === "bank_statement_lines") {
      return {
        insert: (rows: Array<Record<string, unknown>>) => ({
          then: (resolve: (v: { error: null }) => void) => {
            insertedLines = rows;
            resolve({ error: null });
          },
        }),
      };
    }
    throw new Error(`unexpected table in test: ${table}`);
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => fakeClient),
}));

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { membership: { role: "owner" }, org: { id: "org-1" } },
    user: { id: "user-1", email: "owner@org-1.test" },
  })),
}));

// Not exercised by the upload path, but the action imports it at module load.
vi.mock("@/server/services/automation-dispatcher", () => ({
  dispatchAutomation: vi.fn(async () => undefined),
}));

const { uploadBankCsv } = await import("@/app/(app)/payments/actions");

function csvFor(target: Invoice): File {
  const csv = [
    "date,amount,description,reference",
    // Incoming payment for the beyond-clamp target: exact amount (+60), the
    // invoice number in the reference (+30) and a posted date within 60 days of
    // sent_at (+5) → score 95, well over the 70 gate.
    `2026-05-01,${target.total},Client payment received,PAYMENT ${target.number}`,
  ].join("\n");
  return new File([csv], "statement.csv", { type: "text/csv" });
}

beforeEach(() => {
  ledger = buildLedger();
  insertedLines = [];
});

describe("bank-CSV auto-match scores the COMPLETE outstanding ledger (F-1)", () => {
  it("harness teeth: a bare (un-ranged) read is clamped to 1000 and excludes the beyond-cap target", async () => {
    const bare: { data: Invoice[] } = await invoicesBuilder()
      .select()
      .eq("org_id", "org-1")
      .in("status", ["sent"]);
    expect(bare.data).toHaveLength(CAP);
    expect(bare.data.some((i) => i.number === "INV-TARGET-1200")).toBe(false);
  });

  it("matches an incoming line to an outstanding invoice sitting beyond the 1000-row clamp", async () => {
    const target = ledger[TARGET_INDEX]!;
    const form = new FormData();
    form.set("file", csvFor(target));

    const result = await uploadBankCsv(
      { ok: false, error: null, fieldErrors: {}, values: {} },
      form,
    );

    // Success path: navigates to the reconcile screen for the new statement.
    expect(result).toMatchObject({
      ok: true,
      redirectTo: `/payments/reconcile/stmt-1?saved=uploaded`,
    });

    // Exactly one line was inserted, and it was matched to the beyond-clamp
    // invoice — only reachable if the invoice read paged the full ledger.
    expect(insertedLines).toHaveLength(1);
    const line = insertedLines[0]!;
    expect(line.matched_invoice_id).toBe(target.id);
    expect(line.match_status).toBe("suggested");
    expect(line.match_confidence).toBe(95);
  });
});
