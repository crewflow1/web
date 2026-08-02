import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";
import {
  toCanonicalRows,
  type CanonicalInvoiceInput,
  type CanonicalPaymentInput,
} from "@/lib/integrations/accounting/canonical";
import { toAccountingCsv } from "@/lib/integrations/accounting/csv";

/**
 * ACCOUNTING EXPORT (20261093) — against real Postgres RLS.
 *
 *   1. accounting_export_log is member-read / admin-write, org-isolated,
 *      append-only. A plain member may READ history but may not INSERT; an
 *      admin can; an outsider sees nothing.
 *   2. A GENERATED CSV's row count MATCHES the org's finance rows read under a
 *      user JWT: seed N invoices + M payments in org A (plus a decoy in org B),
 *      read pinned to org A, map to canonical, serialise — the CSV has exactly
 *      N + M data lines (header excluded) and no org-B row bleeds in.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  neq(column: string, value: unknown): Sel;
  order(column: string, opts?: Record<string, unknown>): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]> & { count: number | null }> {
  select(columns?: string): Ins;
  single(): PromiseLike<Res<Row>>;
}
interface Del extends PromiseLike<Res<null> & { count: number | null }> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string, opts?: Record<string, unknown>): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(opts?: Record<string, unknown>): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const INV_SELECT =
  "number, status, amount, vat_total, total, due_date, sent_at, created_at, " +
  "customer:customers(name), quote:quotes(customer:customers(name))";

describeIntegration("accounting export · RLS + row-count parity", () => {
  let orgA = "";
  let orgB = "";
  let ownerId = "";
  let ownerToken = "";
  let memberToken = "";
  let outsiderToken = "";

  async function mintUser(label: string): Promise<{ id: string; token: string }> {
    const email = `${TOKEN}-${label}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    expect(created.error, created.error?.message).toBeNull();
    const id = created.data.user?.id ?? "";
    const mirrored = await db(serviceClient())
      .from("users")
      .insert({ id, email, full_name: `Accounting ${label}` })
      .select("id")
      .single();
    expect(mirrored.error, mirrored.error?.message).toBeNull();
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    return { id, token: signedIn.data.session?.access_token ?? "" };
  }

  async function seedInvoice(
    org: string,
    customerId: string,
    number: string,
    amount: number,
    vat: number,
    sentAt: string,
  ): Promise<string> {
    const res = await db(serviceClient())
      .from("invoices")
      .insert({
        org_id: org,
        customer_id: customerId,
        number,
        amount,
        vat_total: vat,
        status: "sent",
        sent_at: sentAt,
      })
      .select("id")
      .single();
    expect(res.error, res.error?.message).toBeNull();
    return String(res.data?.id ?? "");
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc
      .from("organizations")
      .insert({ name: "Accounting A", slug: `${TOKEN}-a` })
      .select("id")
      .single();
    const b = await svc
      .from("organizations")
      .insert({ name: "Accounting B", slug: `${TOKEN}-b` })
      .select("id")
      .single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const custA = await svc
      .from("customers")
      .insert({ org_id: orgA, name: "Acme Ltd" })
      .select("id")
      .single();
    const custB = await svc
      .from("customers")
      .insert({ org_id: orgB, name: "Decoy Co" })
      .select("id")
      .single();
    const custAId = String(custA.data?.id ?? "");
    const custBId = String(custB.data?.id ?? "");

    // Org A: 2 invoices + 1 payment. Org B: 1 decoy invoice.
    const invA1 = await seedInvoice(orgA, custAId, "INV-0001", 100, 20, "2026-07-01T09:00:00Z");
    await seedInvoice(orgA, custAId, "INV-0002", 200, 40, "2026-07-02T09:00:00Z");
    await seedInvoice(orgB, custBId, "INV-9001", 999, 0, "2026-07-01T09:00:00Z");

    const pay = await svc
      .from("invoice_payments")
      .insert({ org_id: orgA, invoice_id: invA1, amount: 50, paid_at: "2026-07-10" })
      .select("id")
      .single();
    expect(pay.error, pay.error?.message).toBeNull();

    const owner = await mintUser("owner");
    ownerId = owner.id;
    ownerToken = owner.token;
    for (const org of [orgA, orgB]) {
      const m = await svc
        .from("memberships")
        .insert({ org_id: org, user_id: ownerId, role: "owner" });
      expect(m.error, m.error?.message).toBeNull();
    }
    const member = await mintUser("member");
    memberToken = member.token;
    const mm = await svc
      .from("memberships")
      .insert({ org_id: orgA, user_id: member.id, role: "staff" });
    expect(mm.error, mm.error?.message).toBeNull();
    outsiderToken = (await mintUser("outsider")).token;

    if (!ownerToken || !memberToken || !outsiderToken) {
      throw new Error("failed to mint tokens");
    }
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ── 1. export-log RLS ────────────────────────────────────────────────────

  it("an ADMIN (owner) can insert an export-log row", async () => {
    const res = await db(userClient(ownerToken))
      .from("accounting_export_log")
      .insert({
        org_id: orgA,
        created_by: ownerId,
        format: "csv",
        status: "generated",
        row_count: 3,
      })
      .select("id");
    expect(res.error, res.error?.message).toBeNull();
    expect((res.data ?? []).length).toBe(1);
  });

  it("a plain MEMBER may READ history but may NOT insert", async () => {
    const asMember = db(userClient(memberToken));
    const readRes = await asMember
      .from("accounting_export_log")
      .select("id")
      .eq("org_id", orgA);
    expect(readRes.error, readRes.error?.message).toBeNull();
    expect((readRes.data ?? []).length).toBeGreaterThanOrEqual(1);

    const ins = await asMember
      .from("accounting_export_log")
      .insert({ org_id: orgA, format: "csv", status: "generated", row_count: 1 })
      .select("id");
    expect(ins.error, "member insert must be refused by RLS").not.toBeNull();
  });

  it("an OUTSIDER sees no export-log rows at all", async () => {
    const res = await db(userClient(outsiderToken))
      .from("accounting_export_log")
      .select("id")
      .eq("org_id", orgA);
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });

  it("records the dark provider outcome (skipped_dark) for an admin", async () => {
    const res = await db(userClient(ownerToken))
      .from("accounting_export_log")
      .insert({
        org_id: orgA,
        created_by: ownerId,
        format: "xero",
        status: "skipped_dark",
        row_count: 0,
      })
      .select("id, status, format");
    expect(res.error, res.error?.message).toBeNull();
    expect(String(res.data?.[0]?.status)).toBe("skipped_dark");
    expect(String(res.data?.[0]?.format)).toBe("xero");
  });

  // ── 2. generated CSV row count matches the org's finance rows ─────────────

  it("a generated CSV has exactly N invoices + M payments for org A (no B bleed)", async () => {
    const asOwner = db(userClient(ownerToken));

    const invRes = await asOwner
      .from("invoices")
      .select(INV_SELECT)
      .eq("org_id", orgA)
      .order("created_at", { ascending: true });
    expect(invRes.error, invRes.error?.message).toBeNull();

    const payRes = await asOwner
      .from("invoice_payments")
      .select(
        "amount, paid_at, invoice:invoices!invoice_payments_invoice_org_fkey(number, customer:customers(name))",
      )
      .eq("org_id", orgA)
      .order("paid_at", { ascending: true });
    expect(payRes.error, payRes.error?.message).toBeNull();

    const invoices: CanonicalInvoiceInput[] = (invRes.data ?? []).map((r) => {
      const row = r as unknown as CanonicalInvoiceInput & {
        customer?: { name?: string | null } | null;
      };
      return {
        number: row.number,
        status: row.status,
        amount: row.amount,
        vat_total: row.vat_total,
        total: row.total,
        due_date: row.due_date,
        sent_at: row.sent_at,
        created_at: row.created_at,
        customer_name: row.customer?.name ?? null,
      };
    });
    const payments: CanonicalPaymentInput[] = (payRes.data ?? []).map((r) => {
      const row = r as unknown as {
        amount: number | string | null;
        paid_at: string | null;
        invoice?: { number?: string | null; customer?: { name?: string | null } | null } | null;
      };
      return {
        invoice_number: row.invoice?.number ?? null,
        customer_name: row.invoice?.customer?.name ?? null,
        amount: row.amount,
        paid_at: row.paid_at,
      };
    });

    expect(invoices).toHaveLength(2);
    expect(payments).toHaveLength(1);

    const rows = toCanonicalRows(invoices, payments, { todayIso: "2026-08-01" });
    const csv = toAccountingCsv(rows);
    const lines = csv.split("\r\n");
    // header + 2 invoices + 1 payment.
    expect(lines).toHaveLength(4);
    expect(rows.length).toBe(invoices.length + payments.length);
    // No org-B invoice number leaked in.
    expect(csv).not.toContain("INV-9001");
    expect(csv).toContain("Acme Ltd");
  });

  // ── 3. draft invoices are NOT accounting rows ─────────────────────────────

  it("EXCLUDES draft invoices from the export while keeping real statuses", async () => {
    const svc = db(serviceClient());
    const cust = await svc
      .from("customers")
      .insert({ org_id: orgA, name: "Draft Co" })
      .select("id")
      .single();
    const custId = String(cust.data?.id ?? "");

    // A DRAFT invoice (a work in progress, not a real sale) alongside the org's
    // existing real (sent) invoices.
    const draft = await svc
      .from("invoices")
      .insert({
        org_id: orgA,
        customer_id: custId,
        number: "INV-DRAFT",
        amount: 500,
        vat_total: 100,
        status: "draft",
        created_at: "2026-07-20T09:00:00Z",
      })
      .select("id");
    expect(draft.error, draft.error?.message).toBeNull();

    const asOwner = db(userClient(ownerToken));

    // Mirror the service read EXACTLY: org-pinned + draft-excluded.
    const invRes = await asOwner
      .from("invoices")
      .select(INV_SELECT)
      .eq("org_id", orgA)
      .neq("status", "draft")
      .order("created_at", { ascending: true });
    expect(invRes.error, invRes.error?.message).toBeNull();
    const numbers = (invRes.data ?? []).map((r) => String((r as Row).number));
    expect(numbers).not.toContain("INV-DRAFT");
    // The real (sent) invoices are still exported.
    expect(numbers).toContain("INV-0001");
    expect(numbers).toContain("INV-0002");

    // Control read WITHOUT the draft filter proves the draft EXISTS and the
    // filter is what removes it — so the assertion above can't pass vacuously.
    const unfiltered = await asOwner
      .from("invoices")
      .select("number")
      .eq("org_id", orgA)
      .order("created_at", { ascending: true });
    const allNumbers = (unfiltered.data ?? []).map((r) => String((r as Row).number));
    expect(allNumbers).toContain("INV-DRAFT");

    // And the draft never reaches the CSV bytes.
    const invoices: CanonicalInvoiceInput[] = (invRes.data ?? []).map((r) => {
      const row = r as unknown as CanonicalInvoiceInput;
      return {
        number: row.number,
        status: row.status,
        amount: row.amount,
        vat_total: row.vat_total,
        total: row.total,
        due_date: row.due_date,
        sent_at: row.sent_at,
        created_at: row.created_at,
        customer_name: null,
      };
    });
    const csv = toAccountingCsv(toCanonicalRows(invoices, [], { todayIso: "2026-08-01" }));
    expect(csv).not.toContain("INV-DRAFT");
  });
});
