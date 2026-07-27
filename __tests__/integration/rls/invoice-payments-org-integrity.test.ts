import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Tenant integrity — invoice_payments may only reference an invoice in the
 * SAME organisation. Proved against real Postgres.
 *
 * `invoice_payments` carries both `org_id` and `invoice_id`, and nothing tied
 * them together: the plain FK checks only that invoice_id names SOME invoice,
 * and the RLS INSERT policy — `with check (is_org_member(org_id))` — constrains
 * only the org_id column the CALLER supplies, never the invoice the row points
 * at. So an insert naming another org's invoice satisfied the policy, and the
 * SECURITY DEFINER status trigger then moved that foreign invoice's status.
 *
 * #343 fixed the one vulnerable writer in application code. This proves the
 * class is now closed at the database.
 *
 * The whole suite runs on the SERVICE-ROLE client, deliberately. That client
 * BYPASSES RLS — it is the most privileged writer the application has, and it
 * is what the portal and every admin path use. If the constraint holds against
 * it, no application writer can bypass the invariant, because none of them has
 * more authority than this. A test that proved it only for a tenant-JWT client
 * would prove the easy half.
 *
 * Fixtures are created and torn down per-run; org deletion cascades to invoices
 * and payments.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{ data: Record<string, unknown> | null; error: { message: string; code?: string } | null }>;
      };
    } & Promise<{ error: { message: string; code?: string } | null }>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => {
        maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
        eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-ipoi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("invoice_payments · organisation integrity (composite FK)", () => {
  let orgA = "";
  let orgB = "";
  let invoiceB = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const res = await svc
        .from("organizations")
        .insert({ name: `IPOI Org ${label}`, slug })
        .select("id")
        .single();
      expect(res.error, res.error?.message).toBeNull();
      const id = res.data?.id as string;
      if (!id) throw new Error(`failed to create org ${label}`);
      if (label === "A") orgA = id;
      else orgB = id;
    }

    // One invoice, owned by org B. £100 net, no VAT → total 100 (generated).
    const inv = await svc
      .from("invoices")
      .insert({
        org_id: orgB,
        number: `${TOKEN}-INV-1`,
        amount: 100,
        vat_total: 0,
        status: "sent",
      })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();
    invoiceB = inv.data?.id as string;
    if (!invoiceB) throw new Error("failed to create org B invoice");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    // Cascades to invoices → invoice_payments. ASSERTED, not fire-and-forget:
    // until 20261052 this delete silently failed (activity_log_org_id_fkey —
    // invoice_payments carries an AFTER-DELETE activity trigger) and leaked
    // every fixture row into the shared database. Swallowing the error is what
    // hid a P1 for so long, so now a failed teardown fails the suite.
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc.from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
    }
  });

  // -------------------------------------------------------------------
  // The invariant
  // -------------------------------------------------------------------

  it("REJECTS a cross-org payment — even on the RLS-bypassing service role", async () => {
    const res = await db(serviceClient())
      .from("invoice_payments")
      .insert({
        org_id: orgA, // caller's own org…
        invoice_id: invoiceB, // …but org B's invoice
        amount: 50,
        paid_at: "2026-07-16",
        source: "manual",
      });
    // 23503 = foreign_key_violation. Postgres refuses; no application code ran.
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("23503");
    expect(res.error?.message ?? "").toContain("invoice_payments_invoice_org_fkey");
  });

  it("leaves the victim org's invoice untouched after a rejected write", async () => {
    // The old bug's real damage: the SECURITY DEFINER trigger moved the foreign
    // invoice's status. A rejected insert must never reach it.
    const res = await db(serviceClient())
      .from("invoices")
      .select("status, paid_at")
      .eq("id", invoiceB)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("sent");
    expect(res.data?.paid_at).toBeNull();
  });

  it("ACCEPTS a same-org payment — ordinary inserts are unchanged", async () => {
    const res = await db(serviceClient())
      .from("invoice_payments")
      .insert({
        org_id: orgB,
        invoice_id: invoiceB,
        amount: 40,
        paid_at: "2026-07-16",
        source: "manual",
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });

  // -------------------------------------------------------------------
  // Existing behaviour must survive the new constraint
  // -------------------------------------------------------------------

  it("partial payment still drives the status trigger → partially_paid", async () => {
    const res = await db(serviceClient())
      .from("invoices")
      .select("status")
      .eq("id", invoiceB)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    // 40 of 100 recorded above.
    expect(res.data?.status).toBe("partially_paid");
  });

  it("full payment still drives the status trigger → paid", async () => {
    const svc = db(serviceClient());
    const add = await svc.from("invoice_payments").insert({
      org_id: orgB,
      invoice_id: invoiceB,
      amount: 60, // 40 + 60 = 100
      paid_at: "2026-07-16",
      source: "manual",
    });
    expect(add.error, add.error?.message).toBeNull();

    const res = await svc
      .from("invoices")
      .select("status")
      .eq("id", invoiceB)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.status).toBe("paid");
  });

  it("payment deletion still recalculates the status back down", async () => {
    const svc = db(serviceClient());
    const rows = await svc
      .from("invoice_payments")
      .select("id, amount")
      .eq("invoice_id", invoiceB)
      .eq("org_id", orgB);
    expect(rows.error, rows.error?.message).toBeNull();
    const sixty = (rows.data as Array<{ id: string; amount: number }> | null)?.find(
      (r) => Number(r.amount) === 60,
    );
    expect(sixty).toBeDefined();

    const del = await svc.from("invoice_payments").delete().eq("id", sixty!.id);
    expect(del.error, del.error?.message).toBeNull();

    const res = await svc
      .from("invoices")
      .select("status")
      .eq("id", invoiceB)
      .maybeSingle();
    expect(res.error, res.error?.message).toBeNull();
    // Back to 40 of 100.
    expect(res.data?.status).toBe("partially_paid");
  });

  it("deleting the invoice still cascades its payments away", async () => {
    const svc = db(serviceClient());
    const inv = await svc
      .from("invoices")
      .insert({
        org_id: orgB,
        number: `${TOKEN}-INV-2`,
        amount: 10,
        vat_total: 0,
        status: "sent",
      })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();
    const id = inv.data?.id as string;

    const pay = await svc.from("invoice_payments").insert({
      org_id: orgB,
      invoice_id: id,
      amount: 5,
      paid_at: "2026-07-16",
      source: "manual",
    });
    expect(pay.error, pay.error?.message).toBeNull();

    // The composite FK carries ON DELETE CASCADE, mirroring the original FK.
    const del = await svc.from("invoices").delete().eq("id", id);
    expect(del.error, del.error?.message).toBeNull();

    const left = await svc
      .from("invoice_payments")
      .select("id")
      .eq("invoice_id", id)
      .eq("org_id", orgB);
    expect(left.error, left.error?.message).toBeNull();
    expect(left.data ?? []).toHaveLength(0);
  });

  it("the candidate key grants no new uniqueness — two invoices coexist in one org", async () => {
    // invoices_id_org_key is (id, org_id) where id is already the PK, so it
    // cannot reject anything the PK already admits. Prove it isn't over-tight.
    const svc = db(serviceClient());
    const res = await svc
      .from("invoices")
      .insert({
        org_id: orgB,
        number: `${TOKEN}-INV-3`,
        amount: 1,
        vat_total: 0,
        status: "draft",
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data?.id).toBeTruthy();
  });
});
