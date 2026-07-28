import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { buildFinanceImportPlan } from "@/lib/imports/vat";

/**
 * Migration OS commit → tables with STORED GENERATED columns, against real
 * Postgres.
 *
 * The regression: `commitImport` handed Postgres values for columns it computes
 * itself, and Postgres refuses that outright — SQLSTATE 428C9, "cannot insert a
 * non-DEFAULT value into column …". Two branches did it, and each failed 100%
 * of its rows:
 *
 *   - cost    → `finances.vat_total`, generated as round(amount*vat_rate/100, 2)
 *               (20260515180000_finances_and_receipts.sql). The writable input
 *               is `vat_rate`, CHECK-constrained to 0/5/20, so an imported VAT
 *               *amount* has to be turned back into a rate first.
 *   - invoice → `invoices.total`, generated as amount + vat_total
 *               (20260515190000_invoices.sql). Both inputs were already being
 *               written; the total just had to stop being sent.
 *
 * No unit test can catch this class of bug: the constraint lives in the
 * database, and a mocked client accepts any column you hand it. So this suite
 * inserts the real payloads — the output of the production builders that
 * insertOne calls — into a real database, and pins the OLD payloads as failing
 * so the shapes cannot quietly come back.
 *
 * Runs on the service-role client: the constraint is the database's, so proving
 * it against the RLS-bypassing client proves it for every app path.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string; code?: string } | null;
        }>;
      };
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;
const TOKEN = `it-import-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("imports · generated columns are never written", () => {
  let orgId = "";
  const svc = () => db(serviceClient());

  /** Insert a mapped `cost` row exactly as the import commit path would. */
  const importCost = async (mapped: Record<string, unknown>) => {
    const plan = buildFinanceImportPlan(mapped, orgId);
    if (plan.status !== "ok") return { plan, result: null };
    const result = await svc()
      .from("finances")
      .insert(plan.row)
      .select("id, amount, vat_rate, vat_total")
      .single();
    return { plan, result };
  };

  /** Insert a mapped `invoice` row exactly as the import commit path would. */
  const importInvoice = async (mapped: Record<string, unknown>) => {
    const plan = buildInvoiceImportPlan(mapped, orgId, "sent");
    if (plan.status !== "ok") return { plan, result: null };
    const result = await svc()
      .from("invoices")
      .insert(plan.row)
      .select("id, amount, vat_total, total")
      .single();
    return { plan, result };
  };

  beforeAll(async () => {
    const o = await svc()
      .from("organizations")
      .insert({ name: "Import VAT Co", slug: TOKEN })
      .select("id")
      .single();
    expect(o.error, JSON.stringify(o.error)).toBeNull();
    orgId = o.data?.id as string;
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });

  // -------------------------------------------------------------------------
  // cost → finances.vat_total
  // -------------------------------------------------------------------------

  it("REJECTS an explicit finances.vat_total — the column is generated (428C9)", async () => {
    // The payload the cost branch used to send, verbatim. Locking the failure
    // in is what stops the old shape quietly coming back.
    const r = await svc()
      .from("finances")
      .insert({ org_id: orgId, amount: 100, vat_total: 20, category: "materials" })
      .select("id")
      .single();
    expect(r.error).not.toBeNull();
    expect(r.error?.code).toBe("428C9");
    expect(r.error?.message).toMatch(/vat_total/);
  });

  it("imports a cost whose VAT is given as an amount, and the DB computes vat_total", async () => {
    const { plan, result } = await importCost({
      amount: 100,
      vat_total: 20,
      category: "materials",
      notes: "Wholesale order",
    });
    expect(plan.status).toBe("ok");
    expect(result?.error, JSON.stringify(result?.error)).toBeNull();
    // The VAT the file stated survives the round-trip — via vat_rate, not by
    // being written directly.
    expect(Number(result?.data?.vat_rate)).toBe(20);
    expect(Number(result?.data?.vat_total)).toBe(20);
    expect(Number(result?.data?.amount)).toBe(100);
  });

  const CASES: Array<{ label: string; mapped: Record<string, unknown>; rate: number; vat: number }> = [
    { label: "20% from a VAT amount", mapped: { amount: 250, vat_total: 50 }, rate: 20, vat: 50 },
    { label: "5% from a VAT amount", mapped: { amount: 250, vat_total: 12.5 }, rate: 5, vat: 12.5 },
    { label: "0% from a zero VAT amount", mapped: { amount: 250, vat_total: 0 }, rate: 0, vat: 0 },
    { label: "20% from an explicit rate column", mapped: { amount: 80, vat_rate: 20 }, rate: 20, vat: 16 },
    { label: "5% from an explicit rate column", mapped: { amount: 80, vat_rate: 5 }, rate: 5, vat: 4 },
    { label: "0% from an explicit rate column", mapped: { amount: 80, vat_rate: 0 }, rate: 0, vat: 0 },
    { label: "5% from a percent-formatted rate cell (0.05)", mapped: { amount: 80, vat_rate: 0.05 }, rate: 5, vat: 4 },
    { label: '20% from a named rate ("Standard")', mapped: { amount: 80, vat_rate: "Standard" }, rate: 20, vat: 16 },
    { label: '0% from a named rate ("Zero rated")', mapped: { amount: 80, vat_rate: "Zero rated" }, rate: 0, vat: 0 },
    // No VAT column at all → 0%, NOT the column's 20% DEFAULT. Inventing
    // reclaimable VAT the operator never stated would corrupt the VAT-quarter
    // figures downstream.
    { label: "0% when the file states no VAT", mapped: { amount: 80 }, rate: 0, vat: 0 },
    // The source rounded its own VAT to 2dp: 20% of 33.33 is 6.666 → 6.67.
    { label: "20% despite the source's 2dp rounding", mapped: { amount: 33.33, vat_total: 6.67 }, rate: 20, vat: 6.67 },
  ];

  for (const c of CASES) {
    it(`imports ${c.label}`, async () => {
      const { plan, result } = await importCost(c.mapped);
      expect(plan.status, JSON.stringify(plan)).toBe("ok");
      expect(result?.error, JSON.stringify(result?.error)).toBeNull();
      expect(Number(result?.data?.vat_rate)).toBe(c.rate);
      expect(Number(result?.data?.vat_total)).toBe(c.vat);
    });
  }

  it("proves the 20% default is a real hazard, not a hypothetical one", async () => {
    // finances.vat_rate DEFAULTS TO 20. If a VAT-less import omitted the column
    // instead of writing 0, the database would invent reclaimable VAT on every
    // such row. This is that default, observed.
    const r = await svc()
      .from("finances")
      .insert({ org_id: orgId, amount: 100, category: TOKEN })
      .select("vat_rate, vat_total")
      .single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(Number(r.data?.vat_rate)).toBe(20);
    expect(Number(r.data?.vat_total)).toBe(20);
  });

  it("rejects a VAT amount that implies an impossible rate, before touching the DB", async () => {
    const { plan, result } = await importCost({ amount: 100, vat_total: 12.5 });
    expect(plan.status).toBe("reject");
    expect(plan.status === "reject" && plan.reason).toMatch(/12\.5%/);
    expect(result).toBeNull();
  });

  it("rejects an explicit rate the CHECK constraint would refuse", async () => {
    const { plan } = await importCost({ amount: 100, vat_rate: 17.5 });
    expect(plan.status).toBe("reject");
    expect(plan.status === "reject" && plan.reason).toMatch(/17\.5%/);
  });

  it("proves that rejection is real: the DB does refuse a non-UK rate", async () => {
    // The resolver's allow-list and the CHECK constraint have to agree. If the
    // constraint ever widened, the resolver would be needlessly strict; if the
    // resolver widened, this is the error the import would hit at runtime.
    const r = await svc()
      .from("finances")
      .insert({ org_id: orgId, amount: 100, vat_rate: 17.5 })
      .select("id")
      .single();
    expect(r.error).not.toBeNull();
    expect(r.error?.code).toBe("23514"); // check_violation
  });

  it("skips a row with no positive amount instead of inserting one", async () => {
    const { plan, result } = await importCost({ amount: 0, vat_total: 20 });
    expect(plan.status).toBe("skip");
    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // invoice → invoices.total
  // -------------------------------------------------------------------------

  it("REJECTS an explicit invoices.total — the column is generated (428C9)", async () => {
    // The payload the invoice branch used to send, verbatim.
    const r = await svc()
      .from("invoices")
      .insert({
        org_id: orgId,
        number: `${TOKEN}-OLD`,
        amount: 80,
        vat_total: 16,
        total: 96,
        status: "sent",
      })
      .select("id")
      .single();
    expect(r.error).not.toBeNull();
    expect(r.error?.code).toBe("428C9");
    expect(r.error?.message).toMatch(/total/);
  });

  it("imports an invoice from amount + vat_total, and the DB computes the total", async () => {
    const { plan, result } = await importInvoice({
      number: `${TOKEN}-NEW`,
      amount: 80,
      vat_total: 16,
      total: 96,
    });
    expect(plan.status).toBe("ok");
    // The builder must not have sent the generated column…
    expect(plan.status === "ok" && Object.keys(plan.row)).not.toContain("total");
    expect(result?.error, JSON.stringify(result?.error)).toBeNull();
    // …and the database computed it back to the figure the file stated.
    expect(Number(result?.data?.total)).toBe(96);
  });

  it("keeps the file's gross when only a total is given (amount derived as total − VAT)", async () => {
    // A sheet with Total + VAT but no Net: the builder derives amount, so the
    // generated total lands back on the gross figure the file stated.
    const { result } = await importInvoice({
      number: `${TOKEN}-DERIVED`,
      total: 120,
      vat_total: 20,
    });
    expect(result?.error, JSON.stringify(result?.error)).toBeNull();
    expect(Number(result?.data?.amount)).toBe(100);
    expect(Number(result?.data?.total)).toBe(120);
  });

  it("skips an invoice with no number or no positive total", async () => {
    expect((await importInvoice({ number: "", total: 120 })).plan.status).toBe("skip");
    expect((await importInvoice({ number: "X", total: 0 })).plan.status).toBe("skip");
  });
});
