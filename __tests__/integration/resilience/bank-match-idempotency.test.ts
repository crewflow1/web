import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * BANK RECONCILIATION — one bank statement line settles AT MOST ONE invoice
 * payment (migration 20261326000000, invoice_payments_bank_line_uniq).
 *
 * confirmBankMatch is INSERT payment → UPDATE bank line. Before this index,
 * nothing stopped the INSERT running twice for the same line: a retry after the
 * UPDATE failed ("match partially failed" — the line still looked unmatched), a
 * second tab, or a re-POST each recorded the same bank transfer again, and the
 * invoice's receipts were overstated. This proves the database now refuses the
 * second payment under real concurrency, and that the invoice ends up paid ONCE.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TOKEN = `resilience-bank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = "";
let invoiceId = "";
let statementId = "";
let seq = 0;

async function makeLine(amount = 120): Promise<string> {
  seq += 1;
  const r = await svc()
    .from("bank_statement_lines")
    .insert({
      org_id: orgId,
      bank_statement_id: statementId,
      posted_at: "2026-11-01",
      amount,
      description: `FASTER PAYMENT ${seq}`,
      reference: `REF-${TOKEN}-${seq}`,
    })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data.id as string;
}

async function makeInvoice(): Promise<string> {
  seq += 1;
  const r = await svc()
    .from("invoices")
    .insert({ org_id: orgId, number: `INV-${TOKEN}-${seq}`, amount: 100, vat_total: 20, status: "sent" })
    .select("id")
    .single();
  expect(r.error, r.error?.message).toBeNull();
  return r.data.id as string;
}

const payFromLine = (lineId: string, invoice: string) =>
  svc()
    .from("invoice_payments")
    .insert({
      org_id: orgId,
      invoice_id: invoice,
      amount: 120,
      paid_at: "2026-11-01",
      source: "bank_csv",
      bank_line_id: lineId,
    })
    .select("id")
    .single() as PromiseLike<Res<{ id: string }>>;

async function paymentsFor(invoice: string): Promise<{ id: string; amount: number }[]> {
  const r = await svc().from("invoice_payments").select("id, amount").eq("invoice_id", invoice);
  expect(r.error, r.error?.message).toBeNull();
  return r.data ?? [];
}

beforeAll(async () => {
  const org = await svc()
    .from("organizations")
    .insert({ name: `Resilience Bank ${TOKEN}`, slug: `${TOKEN}-org` })
    .select("id")
    .single();
  expect(org.error, org.error?.message).toBeNull();
  orgId = org.data.id as string;
  const stmt = await svc()
    .from("bank_statements")
    .insert({ org_id: orgId, filename: "resilience.csv", line_count: 3, matched_count: 0 })
    .select("id")
    .single();
  expect(stmt.error, stmt.error?.message).toBeNull();
  statementId = stmt.data.id as string;
  invoiceId = await makeInvoice();
});

afterAll(async () => {
  if (orgId) {
    await svc().from("invoices").delete().eq("org_id", orgId);
    await svc().from("organizations").delete().eq("id", orgId);
  }
});

describeIntegration("bank reconciliation · a bank line pays an invoice exactly once", () => {
  it("RETRY: a second payment for the SAME bank line is refused (23505); the invoice is paid once", async () => {
    const line = await makeLine();
    const first = await payFromLine(line, invoiceId);
    expect(first.error, first.error?.message).toBeNull();

    // The retry after "match partially failed" — the line still looked unmatched.
    const second = await payFromLine(line, invoiceId);
    expect(second.error?.code, "the same bank transfer must not be recorded twice").toBe("23505");

    const payments = await paymentsFor(invoiceId);
    expect(payments).toHaveLength(1);
    const inv = await svc().from("invoices").select("status").eq("id", invoiceId).single();
    expect(inv.data.status).toBe("paid");
  });

  it("CONCURRENCY: five simultaneous confirms of one bank line record exactly ONE payment", async () => {
    const invoice = await makeInvoice();
    const line = await makeLine();
    const results = await Promise.all(Array.from({ length: 5 }, () => payFromLine(line, invoice)));
    const ok = results.filter((r) => !r.error);
    const refused = results.filter((r) => r.error);
    expect(ok, "exactly one writer wins").toHaveLength(1);
    // Every loser is REFUSED WITH AN ERROR (never a silent second row), and the
    // refusal is the unique index, deterministically: payment inserts on one
    // invoice queue on the invoice row (migration 20261327000000 — FOR NO KEY
    // UPDATE in tg_invoice_payments_refuse_void), so there is no lock-upgrade
    // deadlock left to produce a 40P01. A 40P01 here means that ordering regressed.
    expect(refused).toHaveLength(4);
    for (const r of refused) expect(r.error?.code).toBe("23505");
    expect(await paymentsFor(invoice), "one bank transfer, one payment").toHaveLength(1);
  });

  it("even against a DIFFERENT invoice: one bank transfer cannot settle two invoices", async () => {
    const a = await makeInvoice();
    const b = await makeInvoice();
    const line = await makeLine();
    expect((await payFromLine(line, a)).error).toBeNull();
    expect((await payFromLine(line, b)).error?.code).toBe("23505");
    expect(await paymentsFor(b)).toHaveLength(0);
  });

  it("does not over-reach: manual payments (no bank line) are unaffected, and distinct lines each pay once", async () => {
    const invoice = await makeInvoice();
    const manual = () =>
      svc()
        .from("invoice_payments")
        .insert({ org_id: orgId, invoice_id: invoice, amount: 10, paid_at: "2026-11-02", source: "manual" });
    expect((await manual()).error).toBeNull();
    expect((await manual()).error, "two genuine part-payments are legitimate").toBeNull();
    const l1 = await makeLine(10);
    const l2 = await makeLine(10);
    expect((await payFromLine(l1, invoice)).error).toBeNull();
    expect((await payFromLine(l2, invoice)).error).toBeNull();
    expect(await paymentsFor(invoice)).toHaveLength(4);
  });

  it("CONCURRENCY: simultaneous genuine part-payments on one invoice ALL land — no deadlock (CC-05)", async () => {
    // Before migration 20261327000000 these inserts took FOR SHARE on the invoice
    // and then upgraded for the status sync: all but one died with 40P01 and the
    // user was told to try again. They now queue on the invoice row.
    const invoice = await makeInvoice();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        svc()
          .from("invoice_payments")
          .insert({ org_id: orgId, invoice_id: invoice, amount: 10, paid_at: "2026-11-02", source: "manual" }),
      ),
    );
    for (const r of results) expect(r.error, r.error?.message).toBeNull();
    expect(await paymentsFor(invoice)).toHaveLength(5);
  });
});
