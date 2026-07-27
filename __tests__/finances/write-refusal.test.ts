import { describe, it, expect } from "vitest";
import { financeWriteRefusal } from "@/lib/finances/errors";

/**
 * PATCH /api/finances/[id] used to answer 500 "Failed to update" for every DB
 * error. Once `tg_finances_bill_value_guard` (20261053000000, extended by
 * 20261054000000) exists, the most likely error on that route is a LEGITIMATE
 * refusal — the bill is part-paid under CIS, or is being cut below what has been
 * settled against it — and a 500 with no detail leaves the user with no idea
 * which of those it was, or what to do about it.
 *
 * The guard raises the SAME errcode (23514) for both, so the message is the only
 * thing that distinguishes them, and getting that wrong sends a user through a
 * void-and-re-post ceremony they did not need. Hence the tests below pin the two
 * apart in both directions.
 */
describe("financeWriteRefusal", () => {
  const CIS_MESSAGE =
    'bill 7f3a has been part-paid under CIS — its value and VAT rate are frozen because a ' +
    "deduction has already been calculated and reported from them. Void the CIS payments " +
    "against this bill to change it, then re-post them";

  it("maps the CIS freeze to a 409 that names the recovery path", () => {
    const r = financeWriteRefusal("23514", CIS_MESSAGE);
    expect(r?.status).toBe(409);
    expect(r?.error).toMatch(/part-paid under CIS/i);
    expect(r?.error).toMatch(/void the CIS payments/i);
  });

  it("recognises the symbolic errcode as well as the numeric one", () => {
    expect(financeWriteRefusal("check_violation", CIS_MESSAGE)?.status).toBe(409);
  });

  it("never echoes the raw Postgres message, which can carry row contents", () => {
    const r = financeWriteRefusal("23514", CIS_MESSAGE);
    expect(r?.error).not.toContain("7f3a");
    expect(r?.error).not.toContain("bill 7f3a");
  });

  const FLOOR_MESSAGE =
    "bill 7f3a has 900.00 already settled against it by supplier payments, so its value " +
    "cannot be reduced to 100.00 — bill it for at least what has been paid, or void the " +
    "payments that no longer fit and record them again";

  it("maps the settlement floor to a 409 with its OWN recovery path", () => {
    const r = financeWriteRefusal("23514", FLOOR_MESSAGE);
    expect(r?.status).toBe(409);
    expect(r?.error).toMatch(/already paid more than that/i);
    expect(r?.error).toMatch(/reduce it to at least/i);
  });

  it("never sends a non-CIS bill through the CIS void-and-repost ceremony", () => {
    // The two guards live in one trigger and raise the same errcode. Confusing
    // them would tell a user to void a payment that was never wrong.
    const r = financeWriteRefusal("23514", FLOOR_MESSAGE);
    expect(r?.error).not.toMatch(/CIS/i);
    expect(financeWriteRefusal("23514", CIS_MESSAGE)?.error).not.toMatch(
      /already paid more than that/i,
    );
  });

  it("does not echo the raw figures or the bill id from the floor message either", () => {
    const r = financeWriteRefusal("23514", FLOOR_MESSAGE);
    expect(r?.error).not.toContain("7f3a");
    expect(r?.error).not.toContain("900.00");
  });

  it("still answers 409 for an unrecognised check violation, not 500", () => {
    const r = financeWriteRefusal("23514", "some other guard fired");
    expect(r?.status).toBe(409);
    expect(r?.error).toBe("That change isn't allowed on this bill.");
  });

  it("returns null for errors the caller should keep handling generically", () => {
    expect(financeWriteRefusal("23505", "duplicate key")).toBeNull();
    expect(financeWriteRefusal(undefined, undefined)).toBeNull();
    expect(financeWriteRefusal("42501", "permission denied")).toBeNull();
  });
});
