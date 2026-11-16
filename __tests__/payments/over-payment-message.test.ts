import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isOverPaymentRefusal, overPaymentMessage } from "@/lib/payments/over-payment";

/**
 * The over-payment guard's refusal (migration 20261350000000) reaches a person as something
 * they can act on — and the text the application parses is the text the migration raises.
 */
describe("over-payment refusal → operator message", () => {
  const refusal = (owed: string) => ({ code: "23514", message: `payment of 60.00 exceeds the ${owed} still owed on this invoice` });

  it("names what is still owed", () => {
    expect(isOverPaymentRefusal(refusal("40.00"))).toBe(true);
    expect(overPaymentMessage(refusal("40.00"))).toMatch(/more than the £40\.00 still owed/);
  });
  it("an invoice with nothing left to pay says so", () => {
    expect(overPaymentMessage(refusal("0.00"))).toMatch(/already paid in full/);
  });
  it("any other database error is left to the caller's own message", () => {
    for (const e of [null, undefined, { code: "23505", message: "duplicate key value violates unique constraint" }, { code: "23514", message: "new row violates check constraint \"invoice_payments_amount_check\"" }, { message: "payment 123 over-allocated: 10 of 5 already allocated" }]) {
      expect(isOverPaymentRefusal(e)).toBe(false);
      expect(overPaymentMessage(e)).toBeNull();
    }
  });
  it("the migration raises exactly the text this parses (they cannot drift apart silently)", () => {
    const sql = readFileSync(resolve(__dirname, "../../supabase/migrations/20261350000000_invoice_payments_no_over_pay.sql"), "utf8");
    expect(sql).toContain("'payment of % exceeds the % still owed on this invoice'");
    expect(sql).toMatch(/errcode = 'check_violation'/);
  });
  it("every payment writer translates the refusal", () => {
    for (const f of ["app/(app)/invoices/[id]/payment-actions.ts", "app/(app)/payments/allocate-actions.ts", "app/(app)/payments/actions.ts"]) {
      expect(readFileSync(resolve(__dirname, "../..", f), "utf8"), f).toContain("overPaymentMessage(");
    }
  });
});
