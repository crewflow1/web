import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * Payment allocation — DB invariants against REAL Postgres (20261010000000).
 *
 * Proves the money invariants live in the database, not the app:
 *   1. A member can record a payment and allocate it across several invoices
 *      via the `allocate_payment` RPC; each invoice's status syncs from the
 *      existing per-invoice trigger (allocations ARE invoice_payments rows).
 *   2. Over-allocating a payment is rejected (guard trigger) and the whole
 *      atomic RPC rolls back — no partial payment, no orphan allocations.
 *   3. Allocating to another org's invoice is rejected (composite org FK).
 *   4. A non-member cannot allocate into an org (RLS + explicit tenant check).
 *   5. CONCURRENCY: two simultaneous allocations to the SAME payment can never
 *      push the allocated total past the payment amount — the FOR UPDATE row
 *      lock serialises them (this is the race the milestone exists to prevent).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res<unknown>>;
const db = (client: unknown) =>
  client as unknown as { from(t: string): Table; rpc: Rpc };

const TOKEN = `it-payalloc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("payment allocation · DB invariants", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let invA1 = ""; // total 600
  let invA2 = ""; // total 400
  let invB1 = ""; // org B, total 100
  let memberToken = "";
  let memberUserId = "";
  let outsiderToken = "";
  let outsiderUserId = "";

  async function makeInvoice(org: string, number: string, amount: number, vat: number) {
    const r = await db(serviceClient())
      .from("invoices")
      .insert({ org_id: org, number, amount, vat_total: vat, status: "sent" })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function mintUser(): Promise<{ id: string; token: string; email: string }> {
    const email = `${TOKEN}-${Math.random().toString(36).slice(2, 7)}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    // No auth.users → public.users trigger in this schema, so mirror the row
    // ourselves (the memberships.user_id FK points at public.users).
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: "Alloc Tester" })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "", email };
  }

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc.from("organizations").insert({ name: "Alloc Org A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "Alloc Org B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const c = await svc.from("customers").insert({ org_id: orgA, name: "Alloc Customer" }).select("id").single();
    custA = String(c.data?.id ?? "");

    invA1 = await makeInvoice(orgA, `${TOKEN}-A1`, 500, 100); // total 600
    invA2 = await makeInvoice(orgA, `${TOKEN}-A2`, 400, 0); // total 400
    invB1 = await makeInvoice(orgB, `${TOKEN}-B1`, 100, 0); // total 100 (other org)

    const member = await mintUser();
    memberUserId = member.id;
    memberToken = member.token;
    const mem = await svc.from("memberships").insert({ org_id: orgA, user_id: memberUserId, role: "owner" });
    expect(mem.error, mem.error?.message).toBeNull();

    const outsider = await mintUser();
    outsiderUserId = outsider.id;
    outsiderToken = outsider.token;
    if (!memberToken || !outsiderToken) throw new Error("failed to mint tokens");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (memberUserId) await serviceClient().auth.admin.deleteUser(memberUserId);
    if (outsiderUserId) await serviceClient().auth.admin.deleteUser(outsiderUserId);
  });

  it("member records a payment allocated across two invoices; statuses sync", async () => {
    const res = await db(userClient(memberToken)).rpc("allocate_payment", {
      p_org_id: orgA,
      p_amount: 1000,
      p_paid_at: "2026-07-21",
      p_method: "bank_transfer",
      p_reference: "TT-ALLOC-1",
      p_source: "manual",
      p_notes: null,
      p_allocations: [
        { invoice_id: invA1, amount: 600 },
        { invoice_id: invA2, amount: 400 },
      ],
    });
    expect(res.error, res.error?.message).toBeNull();
    const paymentId = String(res.data ?? "");
    expect(paymentId).toMatch(/[0-9a-f-]{36}/);

    // The payment persisted with the right amount.
    const pay = await db(serviceClient()).from("payments").select("amount, org_id").eq("id", paymentId);
    expect(Number((pay.data?.[0]?.amount as number) ?? 0)).toBe(1000);
    expect(pay.data?.[0]?.org_id).toBe(orgA);

    // Two allocations landed, tagged with the payment.
    const allocs = await db(serviceClient()).from("invoice_payments").select("amount").eq("payment_id", paymentId);
    expect(allocs.data?.length).toBe(2);

    // Existing per-invoice status trigger fired off the allocation rows.
    const i1 = await db(serviceClient()).from("invoices").select("status").eq("id", invA1);
    const i2 = await db(serviceClient()).from("invoices").select("status").eq("id", invA2);
    expect(i1.data?.[0]?.status).toBe("paid"); // 600 == total 600
    expect(i2.data?.[0]?.status).toBe("paid"); // 400 == total 400
  });

  it("rejects over-allocation and rolls the whole payment back (atomic)", async () => {
    const before = await db(serviceClient()).from("payments").select("id").eq("org_id", orgA);
    const beforeCount = before.data?.length ?? 0;

    const res = await db(userClient(memberToken)).rpc("allocate_payment", {
      p_org_id: orgA,
      p_amount: 1000,
      p_paid_at: "2026-07-21",
      p_method: "cash",
      p_reference: "OVER",
      p_source: "manual",
      p_notes: null,
      p_allocations: [
        { invoice_id: invA1, amount: 700 },
        { invoice_id: invA2, amount: 400 }, // 1100 > 1000
      ],
    });
    expect(res.error).not.toBeNull();
    expect(res.error?.message ?? "").toMatch(/over-allocated/i);

    // Nothing persisted — the payment row rolled back with its allocations.
    const after = await db(serviceClient()).from("payments").select("id").eq("org_id", orgA);
    expect(after.data?.length ?? 0).toBe(beforeCount);
  });

  it("rejects allocating to another org's invoice (composite org FK)", async () => {
    const res = await db(userClient(memberToken)).rpc("allocate_payment", {
      p_org_id: orgA,
      p_amount: 100,
      p_paid_at: "2026-07-21",
      p_method: "bank_transfer",
      p_reference: "XORG",
      p_source: "manual",
      p_notes: null,
      p_allocations: [{ invoice_id: invB1, amount: 100 }], // invoice belongs to org B
    });
    expect(res.error, "cross-org allocation must be rejected").not.toBeNull();
  });

  it("rejects a non-member allocating into the org (tenant check / RLS)", async () => {
    const res = await db(userClient(outsiderToken)).rpc("allocate_payment", {
      p_org_id: orgA,
      p_amount: 100,
      p_paid_at: "2026-07-21",
      p_method: "bank_transfer",
      p_reference: "NOPE",
      p_source: "manual",
      p_notes: null,
      p_allocations: [{ invoice_id: invA1, amount: 100 }],
    });
    expect(res.error, "non-member must be denied").not.toBeNull();
  });

  it("CONCURRENCY: two simultaneous allocations to one payment never exceed it", async () => {
    // A £100 payment with a fresh invoice to receive allocations.
    const inv = await makeInvoice(orgA, `${TOKEN}-CC`, 1000, 0); // total 1000, room to spare
    const pay = await db(serviceClient())
      .from("payments")
      .insert({ org_id: orgA, amount: 100, paid_at: "2026-07-21", method: "bank_transfer" })
      .select("id")
      .single();
    const paymentId = String(pay.data?.id ?? "");
    expect(paymentId).toBeTruthy();

    // Fire two £60 allocations at the SAME payment at the same time. Together
    // they are £120 > £100 — exactly one must win. Without the FOR UPDATE lock
    // both would read "0 allocated" and both insert, corrupting the ledger.
    const alloc = () =>
      db(serviceClient())
        .from("invoice_payments")
        .insert({
          org_id: orgA,
          invoice_id: inv,
          amount: 60,
          paid_at: "2026-07-21",
          source: "manual",
          payment_id: paymentId,
        })
        .select("id")
        .single();

    const results = await Promise.allSettled([alloc(), alloc()]);
    const ok = results.filter(
      (r) => r.status === "fulfilled" && !(r.value as Res<Row>).error,
    ).length;
    const failed = results.length - ok;

    expect(ok, "exactly one allocation should succeed").toBe(1);
    expect(failed, "exactly one allocation should be rejected").toBe(1);

    // Ground truth: the ledger never exceeded the payment.
    const allocs = await db(serviceClient())
      .from("invoice_payments")
      .select("amount")
      .eq("payment_id", paymentId);
    const total = (allocs.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(total).toBe(60);
  });
});
