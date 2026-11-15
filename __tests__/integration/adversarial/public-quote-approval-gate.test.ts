/* eslint-disable @typescript-eslint/no-explicit-any -- raw PostgREST rows; see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import { createWorld, destroyWorld, svc, type World } from "./_fixture";
import { acceptQuoteByToken, declineQuoteByToken } from "@/app/(app)/quotes/actions";

/**
 * The public quote link cannot get round the approval gate.
 *
 * `/q/<token>` hides a quote that has not cleared approval (draft / awaiting approval /
 * rejected), but the accept and decline SERVER FUNCTIONS behind it did not check: a customer
 * with the page still open — or anyone holding the link — could accept a quote that had been
 * edited after sending (editing sends it back for approval) and the acceptance created the job
 * and the invoice at the unapproved price. Real server functions, real Postgres.
 */
const NOT_PUBLIC = ["draft", "pending_approval", "rejected"] as const;

describeIntegration("public quote link · accept / decline respect the approval gate", () => {
  let w: World | null = null;
  let customerId = "";
  let seq = 0;

  const count = async (table: string) =>
    (await svc().from(table).select("id", { count: "exact", head: true }).eq("org_id", w!.A.id)).count ?? 0;
  const makeQuote = async (status: string) => {
    seq += 1;
    const token = `tok_gate_${w!.tag}_${seq}`;
    const q = await svc().from("quotes").insert({
      org_id: w!.A.id, customer_id: customerId, number: `QG-${w!.tag}-${seq}`, status, subtotal: 1000, vat_total: 200, public_token: token,
    }).select("id").single();
    if (q.error) throw new Error(`quote: ${q.error.message}`);
    await svc().from("quote_line_items").insert({ quote_id: q.data!.id, org_id: w!.A.id, description: "Works", qty: 1, unit: "ea", unit_price: 1000, vat_rate: 20, line_total: 1000, sort_order: 0 });
    return { id: q.data!.id as string, token };
  };
  const statusOf = async (id: string) => ((await svc().from("quotes").select("status").eq("id", id).single()).data as any)?.status as string;

  beforeAll(async () => {
    const world = await createWorld("quote-gate");
    w = world;
    const c = await svc().from("customers").insert({ org_id: world.A.id, name: `Gate customer ${world.tag}` }).select("id").single();
    if (c.error) throw new Error(`customer: ${c.error.message}`);
    customerId = c.data!.id;
  }, 120_000);
  afterAll(async () => { await destroyWorld(w); }, 120_000);

  it.each(NOT_PUBLIC)("a %s quote cannot be ACCEPTED by its link: no job, no invoice, status unchanged", async (status) => {
    const q = await makeQuote(status);
    const [jobs, invoices] = [await count("jobs"), await count("invoices")];
    const res = await acceptQuoteByToken(q.token, "Pat Customer", null);
    expect(res.ok, `accepting a ${status} quote must be refused`).toBe(false);
    expect(await statusOf(q.id)).toBe(status);
    expect(await count("jobs")).toBe(jobs);
    expect(await count("invoices")).toBe(invoices);
  }, 120_000);

  it.each(NOT_PUBLIC)("a %s quote cannot be DECLINED by its link: status unchanged", async (status) => {
    const q = await makeQuote(status);
    const res = await declineQuoteByToken(q.token, "Too expensive");
    expect(res.ok, `declining a ${status} quote must be refused`).toBe(false);
    expect(await statusOf(q.id)).toBe(status);
  }, 120_000);

  it.each(["approved", "sent", "viewed"] as const)("control · a %s quote is accepted exactly once: one job, one invoice, and a repeat accept adds nothing", async (status) => {
    const q = await makeQuote(status);
    const [jobs, invoices] = [await count("jobs"), await count("invoices")];
    expect((await acceptQuoteByToken(q.token, "Pat Customer", null)).ok).toBe(true);
    expect(await statusOf(q.id)).toBe("accepted");
    expect(await count("jobs")).toBe(jobs + 1);
    expect(await count("invoices")).toBe(invoices + 1);
    expect((await acceptQuoteByToken(q.token, "Pat Customer", null)).ok, "re-accept is idempotent").toBe(true);
    expect(await count("jobs")).toBe(jobs + 1);
    expect(await count("invoices")).toBe(invoices + 1);
  }, 120_000);

  it("accept and decline cannot overwrite each other: an accepted quote stays accepted, a declined quote stays declined", async () => {
    const a = await makeQuote("sent");
    expect((await acceptQuoteByToken(a.token, "Pat Customer", null)).ok).toBe(true);
    expect((await declineQuoteByToken(a.token, "Changed my mind")).ok).toBe(false);
    expect(await statusOf(a.id)).toBe("accepted");
    const d = await makeQuote("sent");
    const [jobs, invoices] = [await count("jobs"), await count("invoices")];
    expect((await declineQuoteByToken(d.token, "No thanks")).ok).toBe(true);
    expect((await acceptQuoteByToken(d.token, "Pat Customer", null)).ok).toBe(false);
    expect(await statusOf(d.id)).toBe("declined");
    expect(await count("jobs")).toBe(jobs);
    expect(await count("invoices")).toBe(invoices);
  }, 120_000);

  it("a simultaneous accept and decline settle on ONE outcome (the status write is conditional)", async () => {
    const q = await makeQuote("sent");
    const [acc, dec] = await Promise.all([
      acceptQuoteByToken(q.token, "Pat Customer", null),
      declineQuoteByToken(q.token, "Race"),
    ]);
    const final = await statusOf(q.id);
    expect(["accepted", "declined"]).toContain(final);
    expect(acc.ok && dec.ok, "both cannot win").toBe(false);
    if (final === "declined") expect(acc.ok).toBe(false);
    if (final === "accepted") expect(dec.ok).toBe(false);
  }, 120_000);
});
