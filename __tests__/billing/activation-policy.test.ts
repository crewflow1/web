import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SETUP_FEE_SATISFIED, setupFeeSatisfied } from "@/lib/billing/activation-policy";

/** The "setup fee satisfied" rule is the same in the HQ checkout and in the database. */
describe("billing activation policy", () => {
  it("only a paid or waived fee satisfies the policy", () => {
    expect(SETUP_FEE_SATISFIED).toEqual(["paid", "waived"]);
    for (const s of ["paid", "waived"]) expect(setupFeeSatisfied(s)).toBe(true);
    for (const s of ["pending", "sent", "refunded", "", null, undefined]) expect(setupFeeSatisfied(s)).toBe(false);
  });
  it("the database function holds activation on exactly the same values", () => {
    const sql = readFileSync(resolve(__dirname, "../../supabase/migrations/20261356000000_subscription_cancellation_state_functions.sql"), "utf8");
    expect(sql).toMatch(/not in \('paid', 'waived'\)/);
    expect(sql).toContain("return 'held_setup_fee_unpaid'");
  });
  it("the HQ checkout reads the fee status through its company loader (it used to be dropped there)", () => {
    const src = readFileSync(resolve(__dirname, "../../app/admin/customers/[id]/_stripe-actions.ts"), "utf8");
    expect(src).toMatch(/setup_fee_status: o\.setup_fee_status \?\? "pending"/);
    expect(src).toContain("setupFeeSatisfied(fee)");
  });
});
