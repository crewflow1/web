/**
 * Invoice VOID (20261219) + Job CANCELLED (20261220) — the DB triggers are the
 * authority; these tests prove them against real Postgres.
 *
 * The defects they would have caught: no operational correction state existed,
 * so voiding an issued invoice / cancelling a job took a direct DB edit — and a
 * naive implementation could have (a) voided a paid invoice (destroying the
 * payment audit chain), (b) let money land on a void invoice, (c) cancelled
 * completed work, or (d) let void/cancel silently rewrite financial history.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

describeIntegration("invoice void + job cancel — DB authority", () => {
  const admin = serviceClient();
  let orgId: string;
  let customerId: string;

  beforeAll(async () => {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .insert({
        name: "Void Cancel Test Org",
        slug: `void-cancel-${Date.now()}`,
        status: "active",
      } as never)
      .select("id")
      .single();
    if (orgErr || !org) throw new Error(`org fixture: ${orgErr?.message}`);
    orgId = (org as { id: string }).id;

    const { data: c, error } = await admin
      .from("customers")
      .insert({ org_id: orgId, name: "Void Test Customer" } as never)
      .select("id")
      .single();
    if (error || !c) throw new Error(`customer fixture: ${error?.message}`);
    customerId = (c as { id: string }).id;
  });

  afterAll(async () => {
    // FK-ordered teardown; invoices/jobs cascade from the org delete where
    // configured — remove children explicitly to be safe.
    await admin.from("invoice_payments").delete().eq("org_id", orgId);
    await admin.from("invoices").delete().eq("org_id", orgId);
    await admin.from("jobs").delete().eq("org_id", orgId);
    await admin.from("customers").delete().eq("org_id", orgId);
    await admin.from("organizations").delete().eq("id", orgId);
  });

  async function mkInvoice(number: string, status = "sent") {
    const { data, error } = await admin
      .from("invoices")
      .insert({
        org_id: orgId,
        customer_id: customerId,
        number,
        status,
        amount: 100,
        vat_total: 20,
        due_date: "2027-01-01",
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`invoice fixture: ${error?.message}`);
    return data.id as string;
  }

  it("voids a sent invoice WITH a reason; trigger stamps voided_at; void is terminal", async () => {
    const id = await mkInvoice("VOID-1");

    // No reason → refused.
    const noReason = await admin
      .from("invoices")
      .update({ status: "void" } as never)
      .eq("id", id);
    expect(noReason.error?.message ?? "").toContain("requires a reason");

    // With reason → lands, stamped by the trigger.
    const ok = await admin
      .from("invoices")
      .update({ status: "void", void_reason: "raised in error" } as never)
      .eq("id", id)
      .select("status, voided_at, void_reason")
      .single();
    expect(ok.error).toBeNull();
    expect((ok.data as unknown as { status: string }).status).toBe("void");
    expect((ok.data as unknown as { voided_at: string | null }).voided_at).not.toBeNull();

    // Terminal — cannot un-void.
    const unvoid = await admin
      .from("invoices")
      .update({ status: "sent" } as never)
      .eq("id", id);
    expect(unvoid.error?.message ?? "").toContain("final");

    // No money can land on it.
    const pay = await admin.from("invoice_payments").insert({
      invoice_id: id,
      org_id: orgId,
      amount: 50,
      paid_at: new Date().toISOString(),
    } as never);
    expect(pay.error?.message ?? "").toContain("void invoice");
  });

  it("REFUSES to void once a payment exists (credit-note territory), even from a stale status", async () => {
    const id = await mkInvoice("VOID-2");
    const pay = await admin.from("invoice_payments").insert({
      invoice_id: id,
      org_id: orgId,
      amount: 40,
      paid_at: new Date().toISOString(),
    } as never);
    expect(pay.error).toBeNull();

    const res = await admin
      .from("invoices")
      .update({ status: "void", void_reason: "nope" } as never)
      .eq("id", id);
    expect(res.error?.message ?? "").toContain("recorded payments");

    // The payment-sync trigger owns the status — proof the ledger is intact.
    const { data } = await admin
      .from("invoices")
      .select("status")
      .eq("id", id)
      .single();
    expect((data as unknown as { status: string }).status).toBe("partially_paid");
  });

  it("a voided invoice leaves every collectable/issued allowlist (schema authority)", async () => {
    // Pure app-side confirmation that the DB state maps out of the money sets.
    const { OVERDUE_COLLECTABLE_STATUSES } = await import(
      "@/lib/invoices/overdue"
    );
    const { ISSUED_INVOICE_STATUSES, OUTSTANDING_STATUSES } = await import(
      "@/lib/invoices/schema"
    );
    expect(OVERDUE_COLLECTABLE_STATUSES).not.toContain("void");
    expect(ISSUED_INVOICE_STATUSES).not.toContain("void");
    expect(OUTSTANDING_STATUSES).not.toContain("void");
  });

  it("cancels an in-progress job (stamped), refuses completed→cancelled, reopens only to new", async () => {
    const mk = async (status: string) => {
      const { data, error } = await admin
        .from("jobs")
        .insert({ org_id: orgId, customer_id: customerId, status } as never)
        .select("id")
        .single();
      if (error || !data) throw new Error(`job fixture: ${error?.message}`);
      return data.id as string;
    };

    const live = await mk("in-progress");
    const done = await mk("completed");

    // in-progress → cancelled: allowed + stamped.
    const cancel = await admin
      .from("jobs")
      .update({ status: "cancelled", cancel_reason: "customer pulled out" } as never)
      .eq("id", live)
      .select("status, cancelled_at")
      .single();
    expect(cancel.error).toBeNull();
    expect((cancel.data as unknown as { cancelled_at: string | null }).cancelled_at).not.toBeNull();

    // completed → cancelled: refused.
    const bad = await admin
      .from("jobs")
      .update({ status: "cancelled" } as never)
      .eq("id", done);
    expect(bad.error?.message ?? "").toContain("completed job cannot be cancelled");

    // cancelled → in-progress: refused; cancelled → new: allowed + audit cleared.
    const sideways = await admin
      .from("jobs")
      .update({ status: "in-progress" } as never)
      .eq("id", live);
    expect(sideways.error?.message ?? "").toContain('reopened to "new"');

    const reopen = await admin
      .from("jobs")
      .update({ status: "new" } as never)
      .eq("id", live)
      .select("status, cancelled_at, cancel_reason")
      .single();
    expect(reopen.error).toBeNull();
    expect((reopen.data as unknown as { cancelled_at: string | null }).cancelled_at).toBeNull();
    expect((reopen.data as unknown as { cancel_reason: string | null }).cancel_reason).toBeNull();
  });
});
