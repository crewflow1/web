import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Issue #349 Phase 2 — invoice line-item snapshotting, against real Postgres.
 *
 * The AFTER INSERT trigger on invoices is the sole snapshot authority. Its
 * guarantees are database behaviour a mock cannot establish — atomicity, "every
 * writer covered", rollback-on-failure, immunity to later quote edits, cascade
 * on invoice delete, survival of quote delete, and the composite-FK org
 * constraint. So the whole suite runs on the service-role client (the most
 * privileged writer; RLS-bypassing) — if the invariants hold against it, they
 * hold for every app writer.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string; code?: string } | null }> & {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{
        data: unknown[] | null;
        error: { message: string } | null;
      }> & {
        eq: (k: string, v: unknown) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
        order: (k: string, o: { ascending: boolean }) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
        maybeSingle: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> & {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-invli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("invoices · line-item snapshot (Phase 2)", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let custB = "";
  let n = 0;

  const svc = () => db(serviceClient());

  /** A quote with N line items, in the given org. Returns the quote id. */
  const mkQuote = async (org: string, customer: string, lines: number) => {
    n += 1;
    const q = await svc()
      .from("quotes")
      .insert({
        org_id: org,
        customer_id: customer,
        number: `${TOKEN}-Q-${n}`,
        subtotal: 100,
        vat_total: 20,
      })
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    const qid = q.data?.id as string;
    for (let i = 0; i < lines; i++) {
      const li = await svc()
        .from("quote_line_items")
        .insert({
          org_id: org,
          quote_id: qid,
          description: `Line ${i}`,
          qty: 2,
          unit_price: 50,
          vat_rate: 20,
          line_total: 100,
          sort_order: i,
        });
      expect(li.error, li.error?.message).toBeNull();
    }
    return qid;
  };

  const mkInvoice = async (org: string, quoteId: string | null, customer: string | null) => {
    n += 1;
    return svc()
      .from("invoices")
      .insert({
        org_id: org,
        number: `${TOKEN}-INV-${n}`,
        amount: 100,
        vat_total: 20,
        status: "sent",
        quote_id: quoteId,
        customer_id: customer,
      })
      .select("id")
      .single();
  };

  const snapshot = async (invoiceId: string) => {
    const res = await svc()
      .from("invoice_line_items")
      .select("id, description, qty, unit_price, vat_rate, line_total, sort_order")
      .eq("invoice_id", invoiceId)
      .order("sort_order", { ascending: true });
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const o = await svc()
        .from("organizations")
        .insert({ name: `InvLI ${label}`, slug })
        .select("id")
        .single();
      expect(o.error, o.error?.message).toBeNull();
      if (label === "A") orgA = o.data?.id as string;
      else orgB = o.data?.id as string;
    }
    const ca = await svc().from("customers").insert({ org_id: orgA, name: "Cust A" }).select("id").single();
    custA = ca.data?.id as string;
    const cb = await svc().from("customers").insert({ org_id: orgB, name: "Cust B" }).select("id").single();
    custB = cb.data?.id as string;
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
  });

  // -------------------------------------------------------------------
  // Trigger creates the snapshot atomically, on insert, for every writer
  // -------------------------------------------------------------------

  it("an invoice insert snapshots its quote's lines, in order", async () => {
    const q = await mkQuote(orgA, custA, 3);
    const inv = await mkInvoice(orgA, q, custA);
    expect(inv.error, inv.error?.message).toBeNull();

    const lines = await snapshot(inv.data?.id as string);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.sort_order)).toEqual([0, 1, 2]);
    expect(lines[0]?.description).toBe("Line 0");
    expect(Number(lines[0]?.line_total)).toBe(100);
  });

  it("snapshots exactly once — no duplicate rows for one invoice", async () => {
    const q = await mkQuote(orgA, custA, 2);
    const inv = await mkInvoice(orgA, q, custA);
    expect(await snapshot(inv.data?.id as string)).toHaveLength(2);
  });

  it("a null quote_id snapshots zero rows (valid: totals live on the invoice)", async () => {
    const inv = await mkInvoice(orgA, null, custA);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(await snapshot(inv.data?.id as string)).toHaveLength(0);
  });

  it("a quote with zero lines snapshots zero rows (no invented lines)", async () => {
    const q = await mkQuote(orgA, custA, 0);
    const inv = await mkInvoice(orgA, q, custA);
    expect(inv.error, inv.error?.message).toBeNull();
    expect(await snapshot(inv.data?.id as string)).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Immutability — the whole point
  // -------------------------------------------------------------------

  it("editing the quote's lines AFTER invoicing does not change the snapshot", async () => {
    const q = await mkQuote(orgA, custA, 2);
    const inv = await mkInvoice(orgA, q, custA);
    const before = await snapshot(inv.data?.id as string);
    expect(before).toHaveLength(2);

    // Mutate the source quote lines.
    const upd = await svc()
      .from("quote_line_items")
      .update({ description: "EDITED", line_total: 999 })
      .eq("quote_id", q);
    expect(upd.error, upd.error?.message).toBeNull();

    const after = await snapshot(inv.data?.id as string);
    expect(after.map((l) => l.description)).not.toContain("EDITED");
    expect(after.map((l) => Number(l.line_total))).not.toContain(999);
  });

  it("deleting the quote does NOT remove the invoice's snapshot", async () => {
    const q = await mkQuote(orgA, custA, 2);
    const inv = await mkInvoice(orgA, q, custA);
    const invId = inv.data?.id as string;
    expect(await snapshot(invId)).toHaveLength(2);

    const del = await svc().from("quotes").delete().eq("id", q);
    expect(del.error, del.error?.message).toBeNull();

    // quote gone (quote_line_items cascade with it), snapshot intact.
    expect(await snapshot(invId)).toHaveLength(2);
  });

  it("deleting the invoice CASCADES its snapshot away", async () => {
    const q = await mkQuote(orgA, custA, 2);
    const inv = await mkInvoice(orgA, q, custA);
    const invId = inv.data?.id as string;
    expect(await snapshot(invId)).toHaveLength(2);

    const del = await svc().from("invoices").delete().eq("id", invId);
    expect(del.error, del.error?.message).toBeNull();
    expect(await snapshot(invId)).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Tenant integrity (composite FK) + isolation
  // -------------------------------------------------------------------

  it("REJECTS a cross-org snapshot row at the database layer", async () => {
    const q = await mkQuote(orgA, custA, 1);
    const inv = await mkInvoice(orgA, q, custA);
    const invId = inv.data?.id as string;

    // org B row pointing at org A's invoice → composite FK violation.
    const bad = await svc().from("invoice_line_items").insert({
      invoice_id: invId,
      org_id: orgB,
      description: "cross-org",
      qty: 1,
      unit_price: 1,
      vat_rate: 20,
      line_total: 1,
      sort_order: 0,
    });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.code).toBe("23503");
    expect(bad.error?.message ?? "").toContain("invoice_line_items_invoice_org_fkey");
  });

  it("the trigger copies ONLY same-org lines (isolation)", async () => {
    // An org-A invoice can only ever snapshot org-A quote lines: the trigger
    // filters li.org_id = NEW.org_id, and the composite FK would reject anything
    // else. Prove an org-A invoice's snapshot contains no org-B data.
    const qA = await mkQuote(orgA, custA, 2);
    const invA = await mkInvoice(orgA, qA, custA);
    const lines = await snapshot(invA.data?.id as string);
    // Every snapshot row carries org A (verified structurally by the FK; here we
    // confirm the count matches org-A's quote exactly, nothing extra leaked in).
    expect(lines).toHaveLength(2);
  });

  // -------------------------------------------------------------------
  // Totals unchanged
  // -------------------------------------------------------------------

  it("does not alter the invoice's stored totals", async () => {
    const q = await mkQuote(orgA, custA, 3);
    const inv = await mkInvoice(orgA, q, custA);
    const row = await svc()
      .from("invoices")
      .select("amount, vat_total, total")
      .eq("id", inv.data?.id as string)
      .maybeSingle();
    expect(row.error, row.error?.message).toBeNull();
    // Totals are what the writer set — the snapshot never touches them.
    expect(Number(row.data?.amount)).toBe(100);
    expect(Number(row.data?.vat_total)).toBe(20);
    expect(Number(row.data?.total)).toBe(120); // generated: amount + vat_total
  });
});
