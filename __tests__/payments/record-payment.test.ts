import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * C1 — invoice payment recording hardening.
 *
 * The QA audit hit an HTTP 503 when recording an invoice payment and, worse,
 * saw the UI report success on a write that hadn't landed. The fix lives in
 * the `addInvoicePayment` server action, which is tightly coupled to Supabase
 * (createClient), requireOrgContext, revalidatePath and redirect — there is no
 * Supabase mock harness in this repo, so the action can't be executed in a
 * unit test. We instead pin the regression-critical INVARIANTS as a
 * source-contract test, the same approach the AI layer uses in
 * __tests__/ai/phase5.test.ts. If a future refactor drops one of these
 * guarantees, this test fails loudly.
 */

const ROOT = resolve(__dirname, "..", "..");
const SRC = readFileSync(
  resolve(ROOT, "app/(app)/invoices/[id]/payment-actions.ts"),
  "utf8",
);

describe("C1 — addInvoicePayment hardening contract", () => {
  it("never reports a false success: the insert-error branch returns formError, not formSuccess", () => {
    // Isolate the insert block (between the insert call and the final success).
    const insertIdx = SRC.indexOf('.from("invoice_payments").insert');
    expect(insertIdx).toBeGreaterThan(-1);
    const afterInsert = SRC.slice(insertIdx);
    const errorBranch = afterInsert.indexOf("if (error)");
    expect(errorBranch).toBeGreaterThan(-1);
    // The error branch must return formError BEFORE any formSuccess is reached.
    const branch = afterInsert.slice(errorBranch);
    const firstError = branch.indexOf("formError");
    const firstSuccess = branch.indexOf("formSuccess");
    expect(firstError).toBeGreaterThan(-1);
    expect(firstError).toBeLessThan(firstSuccess);
  });

  it("logs the full Postgres error shape so a recurrence is diagnosable", () => {
    // code/message/details/hint must all be logged on insert failure.
    expect(SRC).toMatch(/code:\s*error\.code/);
    expect(SRC).toMatch(/details:\s*error\.details/);
    expect(SRC).toMatch(/hint:\s*error\.hint/);
  });

  it("has a double-submit / idempotency guard before inserting", () => {
    // It looks up a recent identical payment and treats a hit as a no-op success.
    expect(SRC).toContain("DEDUPE_WINDOW_MS");
    expect(SRC).toMatch(/duplicate submit suppressed/i);
    // The guard keys on the natural identity of the payment.
    expect(SRC).toMatch(/\.eq\("invoice_id", invoiceId\)/);
    expect(SRC).toMatch(/\.eq\("amount", result\.data\.amount\)/);
    expect(SRC).toMatch(/\.eq\("created_by", user\.id\)/);
  });

  it("distinguishes a transient lookup failure from a genuinely missing invoice", () => {
    // The transient-error branch must exist and run BEFORE the not-found branch
    // so a brief SELECT failure isn't misreported as "Invoice not found".
    const invErrBranch = SRC.indexOf("if (invErr)");
    const notFoundBranch = SRC.indexOf("if (!inv)");
    expect(invErrBranch).toBeGreaterThan(-1);
    expect(notFoundBranch).toBeGreaterThan(-1);
    expect(invErrBranch).toBeLessThan(notFoundBranch);
    // The distinct user-facing message lives inside the invErr branch (i.e.
    // between `if (invErr)` and the `if (!inv)` branch). NB we can't index on
    // the literal "Invoice not found" because it also appears in a comment.
    const lookupFailIdx = SRC.indexOf("Couldn't load the invoice");
    expect(lookupFailIdx).toBeGreaterThan(invErrBranch);
    expect(lookupFailIdx).toBeLessThan(notFoundBranch);
  });

  it("validates the invoice id and the payload before touching the DB", () => {
    expect(SRC).toMatch(/uuid\.safeParse\(invoiceId\)/);
    expect(SRC).toMatch(/validateFormData\(formData, addPaymentSchema\)/);
  });
});
