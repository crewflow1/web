import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * addInvoicePayment — FAULT INJECTION at the Supabase boundary.
 *
 * record-payment.test.ts pins this action's invariants as a source contract
 * ("there is no Supabase mock harness in this repo"). This file EXECUTES the
 * action against a small in-memory client with switchable faults, so the
 * behaviour under a failing database is observed, not inferred:
 *
 *   • the duplicate-submit probe FAILS CLOSED — when the probe itself errors,
 *     nothing is inserted (it used to discard the error, read `null` as "no
 *     duplicate", and let a browser re-POST record the same money twice);
 *   • a failed insert is an error, never "Payment recorded.";
 *   • a retry after a response lost in transit is suppressed as a duplicate.
 */

const INVOICE = "77777777-7777-4777-8777-777777777777";

const model = {
  payments: [] as Record<string, unknown>[],
  faults: { probe: false, insert: false, invoiceRead: false },
};

function table(name: string) {
  let op: "select" | "insert" = "select";
  let payload: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};
  const exec = async () => {
    if (name === "invoices") {
      if (model.faults.invoiceRead) return { data: null, error: { code: "PGRST000", message: "upstream connect error" } };
      return { data: { id: INVOICE, total: 120, org_id: "org-1" }, error: null };
    }
    if (name === "invoice_payments") {
      if (op === "insert") {
        if (model.faults.insert) return { data: null, error: { code: "53300", message: "too many connections", details: null, hint: null } };
        const row = { id: `pay-${model.payments.length + 1}`, ...payload };
        model.payments.push(row);
        return { data: { id: row.id }, error: null };
      }
      if (model.faults.probe) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      const hit = model.payments.find(
        (p) => p.invoice_id === filters.invoice_id && p.amount === filters.amount && p.paid_at === filters.paid_at,
      );
      return { data: hit ? { id: hit.id } : null, error: null };
    }
    return { data: null, error: null };
  };
  const c: Record<string, unknown> = {};
  for (const m of ["select", "gte", "limit", "is"]) c[m] = () => c;
  c.eq = (k: string, v: unknown) => {
    filters[k] = v;
    return c;
  };
  c.insert = (p: Record<string, unknown>) => {
    op = "insert";
    payload = p;
    return c;
  };
  c.maybeSingle = exec;
  c.single = exec;
  return c;
}

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ from: (t: string) => table(t) })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    ctx: { org: { id: "org-1" }, membership: { org_id: "org-1", role: "owner" } },
    user: { id: "u-1", email: "owner@example.test" },
  })),
}));
vi.mock("@/server/auth/capabilities", () => ({ requireCapabilityFor: vi.fn(async () => undefined) }));
vi.mock("@/server/services/automation-dispatcher", () => ({ dispatchAutomation: vi.fn(async () => ({ ok: true })) }));

const { addInvoicePayment } = await import("@/app/(app)/invoices/[id]/payment-actions");

const submit = () => {
  const fd = new FormData();
  fd.set("amount", "120");
  fd.set("paid_at", "2026-11-01");
  fd.set("reference", "BACS 1");
  return addInvoicePayment(INVOICE, { ok: true, submittedAt: 0 } as never, fd);
};

beforeEach(() => {
  model.payments = [];
  model.faults = { probe: false, insert: false, invoiceRead: false };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("addInvoicePayment — behaviour when the database fails", () => {
  it("records one payment on the happy path", async () => {
    const res = await submit();
    expect(res.ok).toBe(true);
    expect(model.payments).toHaveLength(1);
  });

  it("FAULT: the duplicate probe errors → FAILS CLOSED: no insert, 'nothing was saved', input echoed", async () => {
    model.faults.probe = true;
    const res = await submit();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/nothing was saved/i);
    expect(model.payments, "an unverifiable probe must never fall through to the write").toHaveLength(0);
    expect((res as { values?: Record<string, unknown> }).values?.amount).toBe(120);
  });

  it("LOST RESPONSE: the insert committed but the browser re-POSTs → suppressed, still ONE payment", async () => {
    await submit(); // committed; pretend the response never reached the browser
    const retry = await submit();
    expect(retry.ok).toBe(true);
    expect(model.payments).toHaveLength(1);
  });

  it("LOST RESPONSE during a blip: the retry's probe errors → refused, still ONE payment (was: two)", async () => {
    await submit();
    model.faults.probe = true; // the same outage that swallowed the response
    const retry = await submit();
    expect(retry.ok).toBe(false);
    expect(model.payments).toHaveLength(1);
  });

  it("FAULT: the insert fails (pool exhausted) → error, never 'Payment recorded.'", async () => {
    model.faults.insert = true;
    const res = await submit();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't record payment/i);
    expect(model.payments).toHaveLength(0);
  });

  it("FAULT: the invoice lookup fails → 'try again', not 'Invoice not found', and no write", async () => {
    model.faults.invoiceRead = true;
    const res = await submit();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/couldn't load the invoice/i);
    expect(model.payments).toHaveLength(0);
  });
});
