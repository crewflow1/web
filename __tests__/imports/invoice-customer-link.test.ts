import { describe, it, expect } from "vitest";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";

/**
 * Migration G1 — imported invoices link to their customer.
 *
 * The detector already captures the invoice's customer name into
 * `mapped.customer_name` (lib/imports/detect.ts, INVOICE_FIELDS.customer_name),
 * but the commit path dropped it: every imported invoice landed with
 * `customer_id` NULL. The fix resolves that name to a same-org customer id and
 * threads it through `buildInvoiceImportPlan`.
 *
 * This file pins the BUILDER half (a pure function a test can hold): a resolved
 * id lands on the row; an unresolved one (null) leaves the invoice valid and
 * unlinked — never skipped, never thrown. The RESOLVER half — case-insensitive,
 * org-scoped, cross-tenant-safe — is proved against real Postgres in
 * __tests__/integration/rls/import-invoice-customer-link.test.ts, because org
 * scoping is a database fact a unit test cannot establish.
 */

describe("buildInvoiceImportPlan — customer linking", () => {
  const base = { number: "INV-1", total: 120, vat_total: 20, amount: 100 };

  it("writes a resolved customer_id onto the invoice row", () => {
    const plan = buildInvoiceImportPlan(base, "org-1", "sent", "cust-123");
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && plan.row.customer_id).toBe("cust-123");
  });

  it("OMITS customer_id when the customer could not be resolved (null)", () => {
    // Unmatched name → NULL → the invoice still imports (historical AR). The key
    // is absent rather than `null` only to keep the payload tight; the column is
    // nullable either way. The row must NOT be skipped or rejected.
    const plan = buildInvoiceImportPlan(base, "org-1", "sent", null);
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && "customer_id" in plan.row).toBe(false);
  });

  it("OMITS customer_id when no id argument is passed at all (default)", () => {
    // The 4th param defaults to null, so an old call site that never linked
    // keeps its exact prior behaviour — no regression to the unlinked path.
    const plan = buildInvoiceImportPlan(base, "org-1", "sent");
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && "customer_id" in plan.row).toBe(false);
  });

  it("still omits the generated total column when a customer is linked", () => {
    // Linking must not disturb the generated-column invariant: `total` stays
    // absent (it is STORED GENERATED; supplying it is SQLSTATE 428C9).
    const plan = buildInvoiceImportPlan(base, "org-1", "sent", "cust-123");
    expect(plan.status === "ok" && Object.keys(plan.row)).not.toContain("total");
    expect(plan.status === "ok" && plan.row).toMatchObject({
      org_id: "org-1",
      customer_id: "cust-123",
      number: "INV-1",
      amount: 100,
      vat_total: 20,
    });
  });

  it("an unresolvable customer never turns an otherwise-valid invoice into a skip", () => {
    // Guards the behavioural contract directly: a row that would import today
    // (number + positive total) still imports with a null customer id.
    const plan = buildInvoiceImportPlan(
      { number: "INV-9", total: 240 },
      "org-1",
      "sent",
      null,
    );
    expect(plan.status).toBe("ok");
  });
});
