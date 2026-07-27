import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Overdue-invoice automation scheduler — proved against real Postgres.
 *
 * The scheduler finds invoices overdue by the canonical authority
 * (lib/invoices/overdue.ts) and fires the existing tenant `invoice.overdue`
 * automation through the concurrency-safe dispatcher. This exercises the whole
 * chain — real query, real dispatch, real automation_runs claim, real
 * notification side effect — because the guarantees that matter (eligibility,
 * once-ever, concurrency-safety, and NOT touching the billing/reminder domains)
 * are all database behaviour a mock cannot prove.
 *
 * Eligibility is asserted by fixtures spanning every branch of the predicate:
 * paid, draft, future-due, missing-due-date are all present and must be
 * ignored; sent/partially_paid/awaiting_payment past due must qualify.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    } & Promise<{ error: { message: string } | null }>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{
        data: unknown[] | null;
        error: { message: string } | null;
      }> & {
        eq: (k: string, v: unknown) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-odsched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("overdue-invoice scheduler", () => {
  let orgA = "";
  let orgB = "";
  let runOverdueScan: typeof import("@/lib/invoices/overdue-scheduler").runOverdueScan;

  // Eligible + ineligible fixtures, keyed by a label we can assert on.
  const invoiceIds: Record<string, string> = {};

  const YESTERDAY = "2026-07-15";
  const LONG_AGO = "2026-01-01";
  const TOMORROW = "2026-07-17";
  const NOW = new Date("2026-07-16T09:30:00Z");

  async function makeInvoice(
    label: string,
    org: string,
    status: string,
    due_date: string | null,
    n: number,
  ) {
    const res = await db(serviceClient())
      .from("invoices")
      .insert({
        org_id: org,
        number: `${TOKEN}-${label}-${n}`,
        amount: 100,
        vat_total: 0,
        status,
        due_date,
      })
      .select("id")
      .single();
    expect(res.error, `${label}: ${res.error?.message}`).toBeNull();
    invoiceIds[label] = res.data?.id as string;
  }

  const runsFor = async (invoiceId: string) => {
    const res = await db(serviceClient())
      .from("automation_runs")
      .select("id, status, completed_at")
      .eq("rule_id", "invoice_overdue_alert")
      .eq("correlation_id", `invoice.overdue:invoices:${invoiceId}`);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  const notifsFor = async (invoiceId: string, org: string) => {
    const res = await db(serviceClient())
      .from("notifications")
      .select("id, type, category, audience")
      .eq("source_id", invoiceId)
      .eq("org_id", org);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const res = await svc
        .from("organizations")
        .insert({ name: `OD Sched ${label}`, slug })
        .select("id")
        .single();
      expect(res.error, res.error?.message).toBeNull();
      if (label === "A") orgA = res.data?.id as string;
      else orgB = res.data?.id as string;
    }

    // Eligible (org A)
    await makeInvoice("sent_overdue", orgA, "sent", YESTERDAY, 1);
    await makeInvoice("partial_overdue", orgA, "partially_paid", LONG_AGO, 2);
    await makeInvoice("awaiting_overdue", orgA, "awaiting_payment", YESTERDAY, 3);
    // Ineligible (org A)
    await makeInvoice("paid", orgA, "paid", LONG_AGO, 4);
    await makeInvoice("draft", orgA, "draft", LONG_AGO, 5);
    await makeInvoice("future", orgA, "sent", TOMORROW, 6);
    await makeInvoice("no_due", orgA, "sent", null, 7);
    // Eligible (org B) — isolation probe
    await makeInvoice("b_overdue", orgB, "sent", YESTERDAY, 8);

    runOverdueScan = (await import("@/lib/invoices/overdue-scheduler")).runOverdueScan;
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      if (id) await db(serviceClient()).from("organizations").delete().eq("id", id);
    }
  });

  // -------------------------------------------------------------------

  it("first scan dispatches exactly the eligible invoices", async () => {
    const summary = await runOverdueScan(NOW);
    // Our 4 overdue rows (3 in A + 1 in B) plus possibly others from parallel
    // suites — assert on OUR invoices rather than the global counts.
    expect(summary.eligible).toBeGreaterThanOrEqual(4);

    for (const label of ["sent_overdue", "partial_overdue", "awaiting_overdue", "b_overdue"]) {
      const runs = await runsFor(invoiceIds[label]!);
      expect(runs, `${label} should have dispatched`).toHaveLength(1);
      expect(runs[0]?.status).toBe("ok");
      expect(runs[0]?.completed_at).toBeTruthy();
    }
  });

  it("skips paid, draft, future-due and missing-due-date invoices", async () => {
    // Scan already ran in the test above; assert nothing was created for these.
    for (const label of ["paid", "draft", "future", "no_due"]) {
      expect(await runsFor(invoiceIds[label]!), `${label} must be ignored`).toHaveLength(0);
    }
  });

  it("emits the TENANT automation notification, not a billing-domain one", async () => {
    const notifs = await notifsFor(invoiceIds["sent_overdue"]!, orgA);
    expect(notifs.length).toBeGreaterThanOrEqual(1);
    const n = notifs[0]!;
    // The tenant automation notification: automation.* + system + customer.
    expect(n.type).toBe("automation.invoice.overdue");
    expect(n.category).toBe("system");
    expect(n.audience).toBe("customer");
    // NEVER the CrewFlow subscription-billing shape.
    expect(n.type).not.toBe("billing.invoice_overdue");
    expect(n.category).not.toBe("billing");
  });

  it("creates NO invoice_reminders row (that domain is untouched)", async () => {
    const res = await db(serviceClient())
      .from("invoice_reminders")
      .select("id")
      .eq("invoice_id", invoiceIds["sent_overdue"]!)
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("repeated scans do not duplicate — once-ever per invoice", async () => {
    const before = await notifsFor(invoiceIds["sent_overdue"]!, orgA);
    await runOverdueScan(NOW);
    await runOverdueScan(NOW);
    const after = await notifsFor(invoiceIds["sent_overdue"]!, orgA);
    // No new notifications, and still exactly one run row.
    expect(after.length).toBe(before.length);
    expect(await runsFor(invoiceIds["sent_overdue"]!)).toHaveLength(1);
  });

  it("CONCURRENT scans do not duplicate", async () => {
    // A fresh eligible invoice, hit by three overlapping scans at once.
    await makeInvoice("concurrent", orgA, "sent", YESTERDAY, 99);
    const results = await Promise.all([
      runOverdueScan(NOW),
      runOverdueScan(NOW),
      runOverdueScan(NOW),
    ]);
    expect(results.every((r) => typeof r.eligible === "number")).toBe(true);

    // Exactly one run, exactly one notification, despite three racing scans.
    expect(await runsFor(invoiceIds["concurrent"]!)).toHaveLength(1);
    expect(await notifsFor(invoiceIds["concurrent"]!, orgA)).toHaveLength(1);
  });

  it("preserves organisation isolation — each run row carries its own org", async () => {
    // org B's overdue invoice dispatched under org B, not org A.
    const bNotifs = await notifsFor(invoiceIds["b_overdue"]!, orgB);
    expect(bNotifs.length).toBeGreaterThanOrEqual(1);
    // And nothing for org B's invoice leaked under org A.
    expect(await notifsFor(invoiceIds["b_overdue"]!, orgA)).toHaveLength(0);
  });

  it("payment BEFORE a scan prevents the event", async () => {
    // A brand-new invoice that is immediately fully paid → status flips to
    // 'paid' via the trigger → never selected by the scan.
    await makeInvoice("paid_before", orgA, "sent", YESTERDAY, 100);
    const pay = await db(serviceClient())
      .from("invoice_payments")
      .insert({
        org_id: orgA,
        invoice_id: invoiceIds["paid_before"]!,
        amount: 100, // full
        paid_at: "2026-07-16",
        source: "manual",
      });
    expect(pay.error, pay.error?.message).toBeNull();

    await runOverdueScan(NOW);
    expect(await runsFor(invoiceIds["paid_before"]!)).toHaveLength(0);
  });

  it("payment AFTER dispatch does not corrupt invoice lifecycle state", async () => {
    // sent_overdue already dispatched. Now record a partial payment: the
    // payment trigger owns status, the scheduler never wrote it, so the invoice
    // simply becomes partially_paid and its automation row is untouched.
    const pay = await db(serviceClient())
      .from("invoice_payments")
      .insert({
        org_id: orgA,
        invoice_id: invoiceIds["sent_overdue"]!,
        amount: 30, // partial
        paid_at: "2026-07-16",
        source: "manual",
      });
    expect(pay.error, pay.error?.message).toBeNull();

    const inv = await db(serviceClient())
      .from("invoices")
      .select("status")
      .eq("id", invoiceIds["sent_overdue"]!);
    expect(inv.error, inv.error?.message).toBeNull();
    // Trigger-owned: partial payment → partially_paid, NOT anything the
    // scheduler wrote (it never writes status, least of all 'overdue').
    expect((inv.data as Array<{ status: string }>)[0]?.status).toBe("partially_paid");
    // The automation run is still the single completed row.
    const runs = await runsFor(invoiceIds["sent_overdue"]!);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.completed_at).toBeTruthy();
  });
});
