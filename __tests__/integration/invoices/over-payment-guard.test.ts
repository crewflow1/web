/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see ../adversarial/_fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { as, createWorld, destroyWorld, svc, type World } from "../adversarial/_fixture";

/**
 * An invoice cannot be paid for more than it is worth — enforced ATOMICALLY by the database
 * (migration 20261350000000), proven with real concurrent sessions against real Postgres.
 *
 * The application check in `addInvoicePayment` reads the balance and then inserts; two payments
 * submitted at the same instant both read the same balance and both insert. The trigger takes
 * the invoice's row lock first, so writers to ONE invoice queue up and each sees the payments
 * committed before it. Covered here:
 *   • N simultaneous payments that each fit but together overshoot → exactly the ones that fit;
 *   • simultaneous part-payments that add up to the total exactly → all accepted, status paid;
 *   • the allocation RPC (`allocate_payment`) is bound by the same rule, also concurrently;
 *   • a re-posted (duplicate) full payment is refused instead of doubling the money;
 *   • a Stripe settlement recorded by the SERVER is never refused (the money has been taken —
 *     losing its record would be worse than an over-collection), but a CLIENT cannot claim
 *     that exemption by labelling its own row `stripe`;
 *   • existing rows: raising an amount past the balance is refused; editing a note on a row of
 *     an already over-collected invoice is not blocked; deleting always works;
 *   • another company's invoice stays out of reach (RLS unchanged).
 */
describeIntegration("invoice payments · atomic over-payment guard", () => {
  let w: World | null = null;
  let customerId = "";
  let seq = 0;
  const today = new Date().toISOString().slice(0, 10);

  const mkInvoice = async (net: number, vat: number, orgId = w!.A.id, customer = customerId) => {
    seq += 1;
    const r = await svc().from("invoices").insert({ org_id: orgId, customer_id: customer, number: `OP-${w!.tag}-${seq}`, status: "sent", amount: net, vat_total: vat, due_date: today }).select("id, total").single();
    if (r.error) throw new Error(`invoice: ${r.error.message}`);
    return r.data!.id as string;
  };
  const payAs = (token: string, invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
    as(token).from("invoice_payments").insert({ org_id: w!.A.id, invoice_id: invoiceId, amount, paid_at: today, source: "manual", ...extra }).select("id").maybeSingle();
  const paid = async (invoiceId: string) => {
    const rows = ((await svc().from("invoice_payments").select("amount").eq("invoice_id", invoiceId)).data ?? []) as any[];
    return { count: rows.length, pence: rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0) };
  };
  const statusOf = async (invoiceId: string) => ((await svc().from("invoices").select("status").eq("id", invoiceId).single()).data as any).status as string;

  beforeAll(async () => {
    const world = await createWorld("overpay");
    w = world;
    const c = await svc().from("customers").insert({ org_id: world.A.id, name: `Payer ${world.tag}` }).select("id").single();
    if (c.error) throw new Error(`customer: ${c.error.message}`);
    customerId = c.data!.id;
  }, 120_000);
  afterAll(async () => { await destroyWorld(w); }, 120_000);

  it("five simultaneous £60 payments on a £100 invoice: exactly one is accepted", async () => {
    const inv = await mkInvoice(100, 0);
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => payAs(n % 2 ? w!.A.owner.token : w!.A.admin.token, inv, 60, { reference: `race-${n}` })));
    expect(results.filter((r) => !r.error), "accepted").toHaveLength(1);
    expect(results.filter((r) => r.error).every((r) => /still owed|exceeds/i.test(r.error!.message)), "the rest are refused for the balance").toBe(true);
    expect(await paid(inv)).toEqual({ count: 1, pence: 6_000 });
    expect(await statusOf(inv)).toBe("partially_paid");
  }, 120_000);

  it("simultaneous part-payments that add up exactly to the total are all accepted (4 × £30 on £120)", async () => {
    const inv = await mkInvoice(100, 20);
    const results = await Promise.all([1, 2, 3, 4].map((n) => payAs(w!.A.owner.token, inv, 30, { reference: `part-${n}` })));
    expect(results.every((r) => !r.error), results.map((r) => r.error?.message).join(" | ")).toBe(true);
    expect(await paid(inv)).toEqual({ count: 4, pence: 12_000 });
    expect(await statusOf(inv)).toBe("paid");
    // …and one penny more is refused
    const extra = await payAs(w!.A.owner.token, inv, 0.01);
    expect(extra.error?.message).toMatch(/still owed|exceeds/i);
  }, 120_000);

  it("a re-posted duplicate of a full payment is refused instead of doubling the money", async () => {
    const inv = await mkInvoice(250, 50);
    const [a, b] = await Promise.all([payAs(w!.A.owner.token, inv, 300, { reference: "BACS 77" }), payAs(w!.A.owner.token, inv, 300, { reference: "BACS 77" })]);
    expect([a, b].filter((r) => !r.error)).toHaveLength(1);
    expect(await paid(inv)).toEqual({ count: 1, pence: 30_000 });
    expect(await statusOf(inv)).toBe("paid");
  }, 120_000);

  it("the allocation RPC is bound by the same rule — sequentially and concurrently", async () => {
    const inv = await mkInvoice(200, 0);
    const allocate = (amount: number, ref: string) =>
      as(w!.A.owner.token).rpc("allocate_payment", { p_org_id: w!.A.id, p_amount: amount, p_paid_at: today, p_method: "bank_transfer", p_reference: ref, p_source: "manual", p_notes: null, p_allocations: [{ invoice_id: inv, amount }] });
    const over = await allocate(200.01, "alloc-over");
    expect(over.error?.message).toMatch(/still owed|exceeds/i);
    expect(await paid(inv)).toEqual({ count: 0, pence: 0 });
    // the refused allocation rolled its parent payment back too (all-or-nothing)
    expect(((await svc().from("payments").select("id").eq("org_id", w!.A.id).eq("reference", "alloc-over")).data ?? []).length).toBe(0);
    const race = await Promise.all([allocate(150, "alloc-1"), allocate(150, "alloc-2"), allocate(150, "alloc-3")]);
    expect(race.filter((r) => !r.error)).toHaveLength(1);
    expect(await paid(inv)).toEqual({ count: 1, pence: 15_000 });
  }, 120_000);

  it("a Stripe settlement recorded by the server is never refused; a client cannot claim that exemption", async () => {
    const inv = await mkInvoice(100, 0);
    expect((await payAs(w!.A.owner.token, inv, 100)).error).toBeNull();
    // the customer's card payment for the same invoice lands by webhook a moment later
    const settled = await svc().from("invoice_payments").insert({ org_id: w!.A.id, invoice_id: inv, amount: 100, paid_at: today, source: "stripe", notes: "Online card payment (test)" }).select("id").single();
    expect(settled.error, "money already taken by the provider must be recorded").toBeNull();
    expect(await paid(inv)).toEqual({ count: 2, pence: 20_000 });
    // a signed-in admin labelling their own row `stripe` is still bound by the balance
    const inv2 = await mkInvoice(100, 0);
    const spoof = await payAs(w!.A.owner.token, inv2, 500, { source: "stripe" });
    expect(spoof.error?.message).toMatch(/still owed|exceeds/i);
    expect(await paid(inv2)).toEqual({ count: 0, pence: 0 });
    // a server write that is NOT a provider settlement is bound too
    const serverManual = await svc().from("invoice_payments").insert({ org_id: w!.A.id, invoice_id: inv2, amount: 500, paid_at: today, source: "manual" }).select("id").maybeSingle();
    expect(serverManual.error?.message).toMatch(/still owed|exceeds/i);
  }, 120_000);

  it("existing rows: raising an amount past the balance is refused; notes on an over-collected invoice stay editable; delete works", async () => {
    const inv = await mkInvoice(100, 0);
    const first = await payAs(w!.A.owner.token, inv, 40);
    const id = (first.data as any).id as string;
    const raise = await as(w!.A.owner.token).from("invoice_payments").update({ amount: 100.01 }).eq("id", id).select("id");
    expect(raise.error?.message).toMatch(/still owed|exceeds/i);
    expect((await as(w!.A.owner.token).from("invoice_payments").update({ amount: 100 }).eq("id", id).select("id")).error).toBeNull();
    // over-collect it by card, then edit a note on the manual row — must not be blocked
    await svc().from("invoice_payments").insert({ org_id: w!.A.id, invoice_id: inv, amount: 25, paid_at: today, source: "stripe" });
    const note = await as(w!.A.owner.token).from("invoice_payments").update({ notes: "cheque no. 12" }).eq("id", id).select("id");
    expect(note.error).toBeNull();
    expect((note.data ?? []).length).toBe(1);
    // lowering is always allowed, and so is removing
    expect((await as(w!.A.owner.token).from("invoice_payments").update({ amount: 10 }).eq("id", id).select("id")).error).toBeNull();
    expect((await as(w!.A.owner.token).from("invoice_payments").delete().eq("id", id).select("id")).error).toBeNull();
  }, 120_000);

  it("another company's invoice stays out of reach, and its balance cannot be probed through the error", async () => {
    const cB = await svc().from("customers").insert({ org_id: w!.B.id, name: `B payer ${w!.tag}` }).select("id").single();
    const invB = await mkInvoice(100, 0, w!.B.id, cB.data!.id);
    const r = await as(w!.A.owner.token).from("invoice_payments").insert({ org_id: w!.A.id, invoice_id: invB, amount: 5000, paid_at: today, source: "manual" }).select("id").maybeSingle();
    expect(r.error).toBeTruthy();
    expect(r.error!.message).not.toMatch(/still owed/);
    const r2 = await as(w!.A.owner.token).from("invoice_payments").insert({ org_id: w!.B.id, invoice_id: invB, amount: 5000, paid_at: today, source: "manual" }).select("id").maybeSingle();
    expect(r2.error).toBeTruthy();
    expect(r2.error!.message).not.toMatch(/still owed/);
    expect(await paid(invB)).toEqual({ count: 0, pence: 0 });
  }, 120_000);
});
