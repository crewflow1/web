import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * confirmBankMatch — FAULT INJECTION at the Supabase boundary.
 *
 * Confirming a bank match is two statements (insert the payment, mark the line
 * confirmed) and supabase-js cannot wrap them in a transaction. The contract
 * that makes that safe is IDEMPOTENT REPAIR: however the sequence is
 * interrupted, confirming again must complete the match — never record the same
 * bank transfer a second time.
 *
 * The mock is a tiny in-memory model of the two tables with switchable faults,
 * so each test drives the REAL action through a real failure and then through
 * the operator's retry. The database half (the unique index that refuses a
 * second payment for one bank line under true concurrency) is proved on real
 * Postgres: __tests__/integration/resilience/bank-match-idempotency.test.ts.
 */

type Payment = { id: string; invoice_id: string; bank_line_id: string; org_id: string; amount: number };
const LINE_ID = "33333333-3333-4333-8333-333333333333";
const INV_A = "44444444-4444-4444-8444-444444444444";
const INV_B = "55555555-5555-4555-8555-555555555555";
const STMT = "66666666-6666-4666-8666-666666666666";

const model = {
  line: {} as Record<string, unknown>,
  payments: [] as Payment[],
  faults: { lineUpdate: false, probe: false, insertUniqueViolation: false },
  dispatches: 0,
};

function table(name: string) {
  const filters: Record<string, unknown> = {};
  let op: "select" | "insert" | "update" = "select";
  let payload: Record<string, unknown> = {};
  const exec = async (): Promise<{ data: unknown; error: unknown; count?: number }> => {
    if (name === "bank_statement_lines") {
      if (op === "update") {
        if (model.faults.lineUpdate) return { data: null, error: { code: "57014", message: "statement timeout" } };
        Object.assign(model.line, payload);
        return { data: null, error: null };
      }
      return { data: { ...model.line }, error: null, count: 0 };
    }
    if (name === "invoices") {
      return { data: { id: filters.id, org_id: "org-1" }, error: null };
    }
    if (name === "invoice_payments") {
      if (op === "insert") {
        if (model.faults.insertUniqueViolation) {
          // A concurrent confirm won between our probe and our insert.
          model.payments.push({ id: "pay-winner", invoice_id: INV_A, bank_line_id: LINE_ID, org_id: "org-1", amount: 120 });
          model.faults.insertUniqueViolation = false;
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"invoice_payments_bank_line_uniq\"" } };
        }
        if (model.payments.some((p) => p.bank_line_id === payload.bank_line_id)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        const row: Payment = {
          id: `pay-${model.payments.length + 1}`,
          invoice_id: String(payload.invoice_id),
          bank_line_id: String(payload.bank_line_id),
          org_id: String(payload.org_id),
          amount: Number(payload.amount),
        };
        model.payments.push(row);
        return { data: { id: row.id, invoice_id: row.invoice_id }, error: null };
      }
      if (model.faults.probe) return { data: null, error: { code: "PGRST000", message: "connection refused" } };
      const hit = model.payments.find((p) => p.bank_line_id === filters.bank_line_id && p.org_id === filters.org_id);
      return { data: hit ? { id: hit.id, invoice_id: hit.invoice_id } : null, error: null };
    }
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.eq = (k: string, v: unknown) => {
    filters[k] = v;
    return c;
  };
  c.limit = () => c;
  c.insert = (p: Record<string, unknown>) => {
    op = "insert";
    payload = p;
    return c;
  };
  c.update = (p: Record<string, unknown>) => {
    op = "update";
    payload = p;
    return c;
  };
  c.maybeSingle = exec;
  c.single = exec;
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej);
  return c;
}

const client = { from: (t: string) => table(t) };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: "owner" } },
    user: { id: "u-1", email: "owner@example.test" },
  })),
}));
vi.mock("@/server/auth/capabilities", () => ({ requireCapabilityFor: vi.fn(async () => undefined) }));
vi.mock("@/server/services/automation-dispatcher", () => ({
  dispatchAutomation: vi.fn(async () => {
    model.dispatches += 1;
    return { ok: true };
  }),
}));

const { confirmBankMatch } = await import("@/app/(app)/payments/actions");

const submit = (invoiceId: string) => {
  const fd = new FormData();
  fd.set("invoice_id", invoiceId);
  return confirmBankMatch(LINE_ID, { ok: true, submittedAt: 0 } as never, fd);
};

beforeEach(() => {
  model.line = {
    id: LINE_ID,
    org_id: "org-1",
    bank_statement_id: STMT,
    amount: 120,
    posted_at: "2026-11-01",
    reference: "REF",
    description: "FASTER PAYMENT",
    match_status: "suggested",
    matched_payment_id: null,
  };
  model.payments = [];
  model.faults = { lineUpdate: false, probe: false, insertUniqueViolation: false };
  model.dispatches = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("confirmBankMatch — interrupted matches are REPAIRED, never repeated", () => {
  it("happy path: one payment, line confirmed and linked to it, one automation event", async () => {
    const res = await submit(INV_A);
    expect(res).toMatchObject({ ok: true, redirectTo: `/payments/reconcile/${STMT}?saved=matched` });
    expect(model.payments).toHaveLength(1);
    expect(model.line).toMatchObject({ match_status: "confirmed", matched_payment_id: "pay-1", matched_invoice_id: INV_A });
    expect(model.dispatches).toBe(1);
  });

  it("FAULT: the line update fails after the payment committed → honest flag; the RETRY records NO second payment and completes the link", async () => {
    model.faults.lineUpdate = true;
    const first = await submit(INV_A);
    // Told the truth: the payment exists but the match is not finished.
    expect(first).toMatchObject({ redirectTo: `/payments/reconcile/${STMT}?error=match_partially_failed` });
    expect(model.payments).toHaveLength(1);
    expect(model.line.match_status, "the line still looks unmatched — the operator WILL confirm again").toBe("suggested");

    // The operator confirms again once the database is back.
    model.faults.lineUpdate = false;
    const retry = await submit(INV_A);

    expect(retry).toMatchObject({ ok: true, redirectTo: `/payments/reconcile/${STMT}?saved=matched` });
    expect(model.payments, "the SAME bank transfer must not be recorded twice").toHaveLength(1);
    expect(model.line).toMatchObject({ match_status: "confirmed", matched_payment_id: "pay-1", matched_invoice_id: INV_A });
    // Announced once, by the call that created it.
    expect(model.dispatches).toBe(1);
  });

  it("a retry that picks a DIFFERENT invoice keeps the recorded match and says so (no silent re-homing, no second payment)", async () => {
    model.faults.lineUpdate = true;
    await submit(INV_A);
    model.faults.lineUpdate = false;

    const retry = await submit(INV_B);

    expect(retry.ok).toBe(false);
    expect(retry.error).toMatch(/already matched to another invoice/i);
    expect(model.payments).toHaveLength(1);
    expect(model.payments[0]!.invoice_id).toBe(INV_A);
    // The line now points at where the money ACTUALLY went.
    expect(model.line).toMatchObject({ match_status: "confirmed", matched_invoice_id: INV_A, matched_payment_id: "pay-1" });
  });

  it("an already-confirmed line is a clean no-op (stale tab / double submit)", async () => {
    await submit(INV_A);
    const again = await submit(INV_A);
    expect(again).toMatchObject({ ok: true, redirectTo: `/payments/reconcile/${STMT}?saved=matched` });
    expect(model.payments).toHaveLength(1);
    expect(model.dispatches).toBe(1);
  });

  it("RACE: a concurrent confirm wins between probe and insert (23505) → adopt the winner's payment, record nothing extra", async () => {
    model.faults.insertUniqueViolation = true;
    const res = await submit(INV_A);
    expect(res).toMatchObject({ ok: true, redirectTo: `/payments/reconcile/${STMT}?saved=matched` });
    expect(model.payments).toHaveLength(1);
    expect(model.line).toMatchObject({ match_status: "confirmed", matched_payment_id: "pay-winner" });
    // Not ours to announce.
    expect(model.dispatches).toBe(0);
  });

  it("FAULT: the 'already paid?' probe fails → FAILS CLOSED: nothing is written, the user is told nothing was saved", async () => {
    model.faults.probe = true;
    const res = await submit(INV_A);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing was saved/i);
    expect(model.payments).toHaveLength(0);
    expect(model.line.match_status).toBe("suggested");
  });
});
