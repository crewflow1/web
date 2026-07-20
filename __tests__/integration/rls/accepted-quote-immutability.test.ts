import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Commercial integrity — accepted-quote immutability, against real Postgres
 * (migration 20261004000000).
 *
 * Once a quote/variation is ACCEPTED it is a firm commercial agreement. Two DB
 * triggers make that a database invariant, not an app convention:
 *   - quotes_freeze_accepted           → its money figures can't change
 *   - quote_line_items_freeze_accepted → its scope can't be added to / edited
 *
 * These are guarantees a mock cannot establish (they must hold for EVERY
 * writer), so the whole suite runs on the service-role client — the most
 * privileged, RLS-bypassing writer. If the invariant holds against it, it holds
 * for every app path. The suite also proves the freeze is NARROW: it never
 * touches non-accepted quotes, never blocks the accept transition itself, never
 * blocks non-money column writes (the accept flow's job_id), and never blocks
 * the invoice snapshot that READS the frozen lines.
 */

type Res = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };
type ListRes = { data: unknown[] | null; error: { message: string; code?: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string; code?: string } | null }> & {
      select: (c: string) => { single: () => Promise<Res> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<ListRes> & { single: () => Promise<Res>; maybeSingle: () => Promise<Res> };
    };
    update: (v: unknown) => { eq: (k: string, v: unknown) => Promise<{ error: { message: string; code?: string } | null }> };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string; code?: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-qimm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("quotes · accepted-quote immutability (20261004)", () => {
  let orgA = "";
  let custA = "";
  let n = 0;
  const svc = () => db(serviceClient());

  /** A quote in org A. `status` and `total` default to the caller's wishes. */
  const mkQuote = async (status: string, total = 120) => {
    n += 1;
    const q = await svc()
      .from("quotes")
      .insert({
        org_id: orgA,
        customer_id: custA,
        number: `${TOKEN}-Q-${n}`,
        status,
        subtotal: 100,
        vat_total: 20,
        total,
      })
      .select("id")
      .single();
    expect(q.error, q.error?.message).toBeNull();
    return q.data?.id as string;
  };

  const mkLine = async (quoteId: string) => {
    n += 1;
    const li = await svc()
      .from("quote_line_items")
      .insert({
        org_id: orgA,
        quote_id: quoteId,
        description: `Line ${n}`,
        qty: 2,
        unit_price: 50,
        vat_rate: 20,
        line_total: 100,
        sort_order: 0,
      })
      .select("id")
      .single();
    return li;
  };

  beforeAll(async () => {
    const o = await svc().from("organizations").insert({ name: "QImm A", slug: `${TOKEN}-a` }).select("id").single();
    expect(o.error, o.error?.message).toBeNull();
    orgA = o.data?.id as string;
    const c = await svc().from("customers").insert({ org_id: orgA, name: "Cust A" }).select("id").single();
    custA = c.data?.id as string;
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
  });

  // ── The freeze is narrow: non-accepted quotes are fully editable ───────────
  it("a DRAFT quote's amounts and lines are freely editable (freeze is narrow)", async () => {
    const q = await mkQuote("draft");
    const line = await mkLine(q);
    expect(line.error, line.error?.message).toBeNull();

    const upT = await svc().from("quotes").update({ total: 999, subtotal: 800, vat_total: 199 }).eq("id", q);
    expect(upT.error, upT.error?.message).toBeNull();

    const upL = await svc().from("quote_line_items").update({ line_total: 250 }).eq("quote_id", q);
    expect(upL.error, upL.error?.message).toBeNull();
  });

  // ── The accept TRANSITION itself is never blocked ──────────────────────────
  it("sent → accepted transition succeeds (the freeze does not block accepting)", async () => {
    const q = await mkQuote("sent");
    const accept = await svc().from("quotes").update({ status: "accepted" }).eq("id", q);
    expect(accept.error, accept.error?.message).toBeNull();
  });

  // ── Money is frozen once accepted ──────────────────────────────────────────
  it("REJECTS changing an accepted quote's total", async () => {
    const q = await mkQuote("sent");
    await svc().from("quotes").update({ status: "accepted" }).eq("id", q);

    const bad = await svc().from("quotes").update({ total: 5000 }).eq("id", q);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("REJECTS changing an accepted quote's subtotal / vat_total", async () => {
    const q = await mkQuote("accepted");
    const bad = await svc().from("quotes").update({ subtotal: 1, vat_total: 2 }).eq("id", q);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  // ── But non-money columns stay writable (the accept flow writes job_id/notes)
  it("ALLOWS non-money edits on an accepted quote (idempotent-total update)", async () => {
    const q = await mkQuote("accepted", 120);
    // notes is a free-text, no-FK column the accept/edit paths legitimately touch;
    // total is re-sent UNCHANGED to prove same-value writes never trip the guard.
    const ok = await svc().from("quotes").update({ notes: "post-accept note", total: 120 }).eq("id", q);
    expect(ok.error, ok.error?.message).toBeNull();
  });

  // ── Scope (line items) is frozen once accepted ─────────────────────────────
  it("REJECTS adding a line item to an accepted quote", async () => {
    const q = await mkQuote("accepted");
    const bad = await mkLine(q);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  it("REJECTS editing a line item of an accepted quote", async () => {
    const q = await mkQuote("sent");
    const line = await mkLine(q); // added while still 'sent' → allowed
    expect(line.error, line.error?.message).toBeNull();
    await svc().from("quotes").update({ status: "accepted" }).eq("id", q);

    const bad = await svc().from("quote_line_items").update({ line_total: 777 }).eq("quote_id", q);
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/frozen/i);
  });

  // ── DELETE is left open so the quote's ON DELETE CASCADE still works ────────
  it("ALLOWS deleting an accepted quote (cascade removes its frozen lines)", async () => {
    const q = await mkQuote("sent");
    await mkLine(q);
    await svc().from("quotes").update({ status: "accepted" }).eq("id", q);

    const del = await svc().from("quotes").delete().eq("id", q);
    expect(del.error, del.error?.message).toBeNull();

    const gone = await svc().from("quote_line_items").select("id").eq("quote_id", q);
    expect(gone.error, gone.error?.message).toBeNull();
    expect(gone.data ?? []).toHaveLength(0);
  });

  // ── Regression: the invoice snapshot still READS the frozen lines ──────────
  it("still snapshots an accepted quote's lines onto a new invoice (accept→invoice)", async () => {
    const q = await mkQuote("sent");
    await mkLine(q);
    await mkLine(q);
    await svc().from("quotes").update({ status: "accepted" }).eq("id", q);

    n += 1;
    const inv = await svc()
      .from("invoices")
      .insert({ org_id: orgA, number: `${TOKEN}-INV-${n}`, amount: 100, vat_total: 20, status: "sent", quote_id: q, customer_id: custA })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();

    const lines = await svc().from("invoice_line_items").select("id").eq("invoice_id", inv.data?.id as string);
    expect(lines.error, lines.error?.message).toBeNull();
    expect(lines.data ?? []).toHaveLength(2); // freeze blocks WRITES, never the snapshot's READ
  });
});
