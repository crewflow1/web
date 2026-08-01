import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { collectPortalDocumentPdfs } from "@/lib/customers/portal-bulk-download";
import type { PortalCustomer, PortalOrg } from "@/app/customer-portal/_helpers";

/**
 * Customer-portal BULK download, driven against real Postgres.
 *
 * The bulk collector runs on the RLS-BYPASSING service-role client — the token
 * (already resolved to a customer by the caller) is the whole auth surface. This
 * proves end-to-end, through the real function that renders the real PDFs, that
 * a customer's zip contains ONLY their own documents:
 *   • customer A1's set is exactly their own quote + invoice (+ nothing of A2/B);
 *   • a second customer in the SAME org gets only their own;
 *   • DUAL-ORG — the same customer id read against the OTHER org yields nothing;
 *   • the `type` filter narrows to one category;
 *   • the count is bounded.
 *
 * We assert on the SET (file count + total), not decoded PDF bytes: the security
 * property is which documents get into the archive, and that is decided entirely
 * by the collector's scoped reads.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      insert(r: Record<string, unknown>): {
        select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: { message: string } | null }> };
      };
      delete(): { eq(c: string, v: unknown): PromiseLike<Res> };
    };
  };

const T = `it-bulk-portal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const asOrg = (id: string, name: string): PortalOrg => ({
  id,
  name,
  phone: null,
  logo_url: null,
  address: null,
});
const asCustomer = (id: string, orgId: string, name: string): PortalCustomer => ({
  id,
  org_id: orgId,
  name,
  email: null,
  phone: null,
});

describeIntegration("Customer portal · bulk download isolation (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let custA1 = "";
  let custA2 = "";
  let custB = "";
  const svc = () => db(serviceClient());

  const mk = async (table: string, row: Record<string, unknown>) => {
    const r = await svc().from(table).insert(row).select("id").single();
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    return String(r.data?.id ?? "");
  };

  beforeAll(async () => {
    orgA = await mk("organizations", { name: "Bulk A", slug: `${T}-a` });
    orgB = await mk("organizations", { name: "Bulk B", slug: `${T}-b` });
    custA1 = await mk("customers", { org_id: orgA, name: "A One" });
    custA2 = await mk("customers", { org_id: orgA, name: "A Two" });
    custB = await mk("customers", { org_id: orgB, name: "B One" });

    // A1: one portal-eligible quote (has a public_token) + one invoice.
    await mk("quotes", {
      org_id: orgA, customer_id: custA1, number: `${T}-QA1`, status: "accepted",
      subtotal: 100, vat_total: 20, total: 120, public_token: `${T}-ptA1`,
    });
    await mk("invoices", {
      org_id: orgA, customer_id: custA1, number: `${T}-IA1`, status: "sent",
      amount: 100, vat_total: 20,
    });

    // A2: one invoice only.
    await mk("invoices", {
      org_id: orgA, customer_id: custA2, number: `${T}-IA2`, status: "sent",
      amount: 50, vat_total: 10,
    });

    // A1 also has a quote with NO public_token — never cleared the portal gate.
    await mk("quotes", {
      org_id: orgA, customer_id: custA1, number: `${T}-QA1DRAFT`, status: "draft",
      subtotal: 5, vat_total: 1, total: 6, public_token: null,
    });

    // B: one invoice + one portal quote in the OTHER org.
    await mk("invoices", {
      org_id: orgB, customer_id: custB, number: `${T}-IB`, status: "sent",
      amount: 999, vat_total: 0,
    });
    await mk("quotes", {
      org_id: orgB, customer_id: custB, number: `${T}-QB`, status: "accepted",
      subtotal: 999, vat_total: 0, total: 999, public_token: `${T}-ptB`,
    });
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) {
      if (org) await svc().from("organizations").delete().eq("id", org);
    }
  });

  it("A1's zip contains exactly their own quote + invoice", async () => {
    const res = await collectPortalDocumentPdfs({
      customer: asCustomer(custA1, orgA, "A One"),
      org: asOrg(orgA, "Bulk A"),
    });
    expect(res.total).toBe(2); // the published quote + the invoice, not the draft quote
    expect(res.files).toHaveLength(2);
    expect(res.capped).toBe(false);
    // Every file is a rendered PDF with content.
    for (const f of res.files) expect(f.bytes.length).toBeGreaterThan(0);
  });

  it("a second customer in the SAME org gets ONLY their own document", async () => {
    const res = await collectPortalDocumentPdfs({
      customer: asCustomer(custA2, orgA, "A Two"),
      org: asOrg(orgA, "Bulk A"),
    });
    expect(res.total).toBe(1); // just A2's invoice — nothing of A1's
    expect(res.files).toHaveLength(1);
  });

  it("DUAL-ORG: the same customer id read against the OTHER org yields nothing", async () => {
    const res = await collectPortalDocumentPdfs({
      customer: asCustomer(custA1, orgB, "A One"),
      org: asOrg(orgB, "Bulk B"),
    });
    expect(res.total).toBe(0);
    expect(res.files).toHaveLength(0);
  });

  it("customer B never receives org A's documents", async () => {
    const res = await collectPortalDocumentPdfs({
      customer: asCustomer(custB, orgB, "B One"),
      org: asOrg(orgB, "Bulk B"),
    });
    // Exactly B's own invoice + quote — A's larger set never bleeds across.
    expect(res.total).toBe(2);
  });

  it("the type filter narrows to a single category", async () => {
    const res = await collectPortalDocumentPdfs({
      customer: asCustomer(custA1, orgA, "A One"),
      org: asOrg(orgA, "Bulk A"),
      filter: "invoice",
    });
    expect(res.total).toBe(1);
    expect(res.files).toHaveLength(1);
  });
});
