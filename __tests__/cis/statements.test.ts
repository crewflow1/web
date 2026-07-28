import { describe, expect, it } from "vitest";

import {
  assessStatementFreshness,
  buildMonthlyReturnDataset,
  CIS_NO_FILING_NOTICE,
  CIS_RETURN_STATUSES,
  daysUntil,
  describeVerificationNumber,
  isHigherRateStatus,
  resolveRateProvenance,
  summariseStatement,
  verificationNumberRequired,
  type CisPaymentSnapshotRow,
} from "@/lib/cis/statements";
import { cisReturnDueDate, cisStatementDueDate, cisTaxMonthEnd } from "@/lib/cis/tax-month";
import { assessContractorReadiness, canonicalisePayeReference } from "@/lib/cis/contractor";

/**
 * H2-CIS M4 — the pure layer.
 *
 * These are the cases that actually bite in a CIS month-end: a payment on the
 * 5th versus the 6th, one subcontractor paid twice, gross status, an unmatched
 * 30% subcontractor with no verification number, materials swallowing the
 * payment, a voided payment, and a month with nothing in it at all.
 *
 * The arithmetic under test is SUMMATION ONLY. M4 computes no deduction — every
 * money figure it touches was frozen by M3 at posting time — so these tests
 * assert that the frozen figures are aggregated faithfully, never that a
 * deduction was recalculated correctly. That belongs to __tests__/cis/deduction.test.ts.
 */

const TAX_MONTH_END = "2026-08-05"; // the 6 Jul – 5 Aug 2026 tax month

function snap(over: Partial<CisPaymentSnapshotRow> = {}): CisPaymentSnapshotRow {
  return {
    payment_id: "p1",
    supplier_id: "s1",
    paid_at: "2026-07-10",
    voided_at: null,
    cis_status: "standard_20",
    deduction_rate: 20,
    verification_reference: "V1234567890",
    legal_name: "Groundworks Ltd",
    utr_masked: "••••••7890",
    cis_gross_payment: 1000,
    materials_total: 200,
    cis_deduction: 160,
    tax_month_start: "2026-07-06",
    tax_month_end: TAX_MONTH_END,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tax month boundaries — the single easiest thing in this domain to get wrong
// ---------------------------------------------------------------------------

describe("tax month boundaries around the 5th and 6th", () => {
  it("puts a payment on the 5th and one on the 6th in ADJACENT tax months", () => {
    // A CIS tax month runs 6th → 5th (CIS340 3.15/4.2). One day apart here is a
    // different return, a different statement and a different deadline.
    expect(cisTaxMonthEnd("2026-07-05")).toBe("2026-07-05");
    expect(cisTaxMonthEnd("2026-07-06")).toBe("2026-08-05");
    expect(cisTaxMonthEnd("2026-07-05")).not.toBe(cisTaxMonthEnd("2026-07-06"));
  });

  it("gives the statement deadline as 14 days after the tax month end", () => {
    // CISR12160: "within 14 days after the end of the tax month".
    expect(cisStatementDueDate("2026-05-20")).toBe("2026-06-19"); // month ends 5 Jun
    expect(cisStatementDueDate("2026-07-06")).toBe("2026-08-19"); // month ends 5 Aug
  });

  it("gives the return deadline as the 19th of the month following the tax month", () => {
    // GOV.UK: "by the 19th of every month following the last tax month".
    expect(cisReturnDueDate("2026-05-20")).toBe("2026-06-19");
    expect(cisReturnDueDate("2026-12-20")).toBe("2027-01-19"); // across a year boundary
  });

  it("derives the two deadlines independently even though they coincide", () => {
    // They always land on the same day because a tax month ends on the 5th and
    // 5 + 14 = 19. That is a coincidence of the calendar, not a shared rule, so
    // both are computed from their own definition.
    for (const iso of ["2026-01-20", "2026-02-28", "2026-06-06", "2026-11-30"]) {
      expect(cisStatementDueDate(iso)).toBe(cisReturnDueDate(iso));
    }
  });
});

// ---------------------------------------------------------------------------
// Verification numbers — never invented
// ---------------------------------------------------------------------------

describe("verification numbers", () => {
  it("requires one only for the higher-rate unmatched cases", () => {
    // CISR12160: "only if the subcontractor could not be verified and a
    // deduction at the higher rate has been applied".
    expect(isHigherRateStatus("higher_30")).toBe(true);
    expect(isHigherRateStatus("failed")).toBe(true);
    expect(isHigherRateStatus("standard_20")).toBe(false);
    expect(isHigherRateStatus("gross")).toBe(false);

    expect(verificationNumberRequired(["standard_20", "gross"])).toBe(false);
    expect(verificationNumberRequired(["standard_20", "higher_30"])).toBe(true);
  });

  it("states the absence in words when one is required and not held — never fabricates", () => {
    const missing = describeVerificationNumber({ required: true, number: null });
    expect(missing.kind).toBe("missing");
    expect(missing.text).toMatch(/obtain the verification number from HMRC/i);
    // The critical property: nothing that could be mistaken for a real number.
    expect(missing.text).not.toMatch(/^V?\d/);

    expect(describeVerificationNumber({ required: true, number: "   " }).kind).toBe("missing");
    expect(describeVerificationNumber({ required: false, number: null })).toEqual({
      kind: "not_required",
      text: null,
    });
    expect(describeVerificationNumber({ required: true, number: " V1234567890 " })).toEqual({
      kind: "present",
      text: "V1234567890",
    });
  });

  it("takes the number only from a HIGHER-RATE payment, never from a 20% one", () => {
    const summary = summariseStatement([
      snap({ payment_id: "a", cis_status: "standard_20", deduction_rate: 20, verification_reference: "V0000000001" }),
      snap({
        payment_id: "b",
        paid_at: "2026-07-20",
        cis_status: "higher_30",
        deduction_rate: 30,
        verification_reference: "V9999999999",
        cis_deduction: 240,
      }),
    ])!;
    expect(summary.verificationNumberRequired).toBe(true);
    expect(summary.verificationNumber).toBe("V9999999999");
  });

  it("reports required-but-absent rather than borrowing a number from elsewhere", () => {
    const summary = summariseStatement([
      snap({ payment_id: "a", cis_status: "standard_20", verification_reference: "V0000000001" }),
      snap({
        payment_id: "b",
        paid_at: "2026-07-20",
        cis_status: "higher_30",
        deduction_rate: 30,
        verification_reference: null,
        cis_deduction: 240,
      }),
    ])!;
    expect(summary.verificationNumberRequired).toBe(true);
    expect(summary.verificationNumber).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

describe("summariseStatement", () => {
  it("returns null for a month with no payments — no statement is due", () => {
    expect(summariseStatement([])).toBeNull();
  });

  it("sums a subcontractor paid TWICE in one tax month into one statement", () => {
    const summary = summariseStatement([
      snap({ payment_id: "a", paid_at: "2026-07-10", cis_gross_payment: 1000, materials_total: 200, cis_deduction: 160 }),
      snap({ payment_id: "b", paid_at: "2026-07-24", cis_gross_payment: 500, materials_total: 100, cis_deduction: 80 }),
    ])!;

    expect(summary.paymentCount).toBe(2);
    expect(summary.grossAmount).toBe(1500);
    expect(summary.materialsAmount).toBe(300);
    expect(summary.deductionAmount).toBe(240);
    expect(summary.isStatutory).toBe(true);
    // HMRC wants ONE statement per subcontractor per month, not one per payment.
    expect(summary.payments).toHaveLength(2);
  });

  it("excludes a VOIDED payment from the statement entirely", () => {
    const summary = summariseStatement([
      snap({ payment_id: "a", cis_gross_payment: 1000, materials_total: 0, cis_deduction: 200 }),
      snap({
        payment_id: "b",
        paid_at: "2026-07-20",
        voided_at: "2026-07-25T00:00:00Z",
        cis_gross_payment: 500,
        materials_total: 0,
        cis_deduction: 100,
      }),
    ])!;
    expect(summary.paymentCount).toBe(1);
    expect(summary.grossAmount).toBe(1000);
    expect(summary.deductionAmount).toBe(200);
  });

  it("returns null when EVERY payment in the month has been voided", () => {
    // There is then nothing to state, which is why reissue is impossible and
    // withdrawal is the honest close-out.
    expect(
      summariseStatement([
        snap({ payment_id: "a", voided_at: "2026-07-25T00:00:00Z" }),
        snap({ payment_id: "b", voided_at: "2026-07-25T00:00:00Z" }),
      ]),
    ).toBeNull();
  });

  it("marks a GROSS-status (0%) subcontractor's statement as non-statutory", () => {
    // CIS340 3.15: giving a statement for a gross payment is "good practice ...
    // but there is no obligation to do so".
    const summary = summariseStatement([
      snap({ cis_status: "gross", deduction_rate: 0, cis_deduction: 0, materials_total: 0, verification_reference: null }),
    ])!;
    expect(summary.deductionAmount).toBe(0);
    expect(summary.isStatutory).toBe(false);
    expect(summary.verificationNumberRequired).toBe(false);
  });

  it("handles an UNMATCHED 30% subcontractor", () => {
    const summary = summariseStatement([
      snap({ cis_status: "higher_30", deduction_rate: 30, cis_gross_payment: 1000, materials_total: 0, cis_deduction: 300 }),
    ])!;
    expect(summary.deductionAmount).toBe(300);
    expect(summary.rate).toEqual({ uniform: true, rate: 30, status: "higher_30" });
    expect(summary.verificationNumberRequired).toBe(true);
  });

  it("carries materials that swallowed the whole payment, with a zero deduction", () => {
    // M3 clamps the basis at zero (it never goes negative), so the statement's
    // job is simply to report what was frozen: gross == materials, nothing
    // deducted. It must NOT recompute or 'correct' either figure.
    const summary = summariseStatement([
      snap({ cis_gross_payment: 800, materials_total: 800, cis_deduction: 0 }),
    ])!;
    expect(summary.grossAmount).toBe(800);
    expect(summary.materialsAmount).toBe(800);
    expect(summary.deductionAmount).toBe(0);
    expect(summary.isStatutory).toBe(false);
  });

  it("reports a MIXED rate honestly instead of picking or averaging one", () => {
    const summary = summariseStatement([
      snap({ payment_id: "a", cis_status: "standard_20", deduction_rate: 20 }),
      snap({ payment_id: "b", paid_at: "2026-07-20", cis_status: "higher_30", deduction_rate: 30, cis_deduction: 240 }),
    ])!;
    expect(summary.rate).toEqual({ uniform: false, rate: null, status: null });
  });

  it("takes the identity from the LATEST payment, independent of input order", () => {
    const rows = [
      snap({ payment_id: "b", paid_at: "2026-07-24", legal_name: "Renamed Ltd", utr_masked: "••••••1111" }),
      snap({ payment_id: "a", paid_at: "2026-07-10", legal_name: "Old Name Ltd", utr_masked: "••••••2222" }),
    ];
    expect(summariseStatement(rows)!.subcontractorName).toBe("Renamed Ltd");
    expect(summariseStatement([...rows].reverse())!.subcontractorName).toBe("Renamed Ltd");
  });

  it("carries the tax month end and the 14-day deadline", () => {
    const summary = summariseStatement([snap()])!;
    expect(summary.taxMonthEnd).toBe(TAX_MONTH_END);
    expect(summary.dueOn).toBe("2026-08-19");
    expect(summary.taxMonthLabel).toBe("6 July 2026 to 5 August 2026");
  });
});

describe("resolveRateProvenance", () => {
  it("is uniform only when both the rate AND the status agree across payments", () => {
    expect(resolveRateProvenance([{ deduction_rate: 20, cis_status: "standard_20" }])).toEqual({
      uniform: true,
      rate: 20,
      status: "standard_20",
    });
    // 30% reached two different ways is still not one status.
    expect(
      resolveRateProvenance([
        { deduction_rate: 30, cis_status: "higher_30" },
        { deduction_rate: 30, cis_status: "failed" },
      ]).uniform,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The monthly return dataset
// ---------------------------------------------------------------------------

describe("buildMonthlyReturnDataset", () => {
  it("models an empty month as a NIL RETURN, not as an absent dataset", () => {
    // GOV.UK requires "a return showing your payments were 0". The obligation
    // exists; representing it as nothing to do would hide it.
    const ds = buildMonthlyReturnDataset([], TAX_MONTH_END);
    expect(ds.isNil).toBe(true);
    expect(ds.subcontractorCount).toBe(0);
    expect(ds.paymentCount).toBe(0);
    expect(ds.totalGross).toBe(0);
    expect(ds.totalDeduction).toBe(0);
    expect(ds.lines).toEqual([]);
    // Tax month 6 Jul – 5 Aug ends on 5 August, so the return is due 19 August:
    // "the 19th of every month following the last tax month".
    expect(ds.dueOn).toBe("2026-08-19");
  });

  it("emits ONE line per subcontractor with combined totals", () => {
    const ds = buildMonthlyReturnDataset(
      [
        snap({ payment_id: "a", supplier_id: "s1", cis_gross_payment: 1000, materials_total: 200, cis_deduction: 160 }),
        snap({ payment_id: "b", supplier_id: "s1", paid_at: "2026-07-20", cis_gross_payment: 500, materials_total: 0, cis_deduction: 100 }),
        snap({ payment_id: "c", supplier_id: "s2", legal_name: "Roofing Ltd", cis_gross_payment: 400, materials_total: 0, cis_deduction: 80 }),
      ],
      TAX_MONTH_END,
    );
    expect(ds.isNil).toBe(false);
    expect(ds.subcontractorCount).toBe(2);
    expect(ds.paymentCount).toBe(3);
    expect(ds.lines.find((l) => l.supplierId === "s1")!.grossAmount).toBe(1500);
    expect(ds.lines.find((l) => l.supplierId === "s1")!.paymentCount).toBe(2);
    expect(ds.totalGross).toBe(1900);
    expect(ds.totalDeduction).toBe(340);
  });

  it("INCLUDES gross-status subcontractors — the return reports them too", () => {
    // The return covers payments to all subcontractors, gross or under
    // deduction, which is why its population is wider than the set owed a
    // statement.
    const ds = buildMonthlyReturnDataset(
      [snap({ supplier_id: "sg", cis_status: "gross", deduction_rate: 0, cis_deduction: 0, materials_total: 0 })],
      TAX_MONTH_END,
    );
    expect(ds.isNil).toBe(false);
    expect(ds.subcontractorCount).toBe(1);
    expect(ds.totalDeduction).toBe(0);
  });

  it("drops voided payments and reverts to NIL when they were the only ones", () => {
    const ds = buildMonthlyReturnDataset(
      [snap({ voided_at: "2026-07-30T00:00:00Z" })],
      TAX_MONTH_END,
    );
    expect(ds.isNil).toBe(true);
    expect(ds.subcontractorCount).toBe(0);
  });

  it("ignores snapshots from a DIFFERENT tax month", () => {
    const ds = buildMonthlyReturnDataset(
      [
        snap({ payment_id: "in", cis_gross_payment: 100, materials_total: 0, cis_deduction: 20 }),
        snap({
          payment_id: "out",
          tax_month_start: "2026-06-06",
          tax_month_end: "2026-07-05",
          cis_gross_payment: 900,
          materials_total: 0,
          cis_deduction: 180,
        }),
      ],
      TAX_MONTH_END,
    );
    expect(ds.paymentCount).toBe(1);
    expect(ds.totalGross).toBe(100);
  });

  it("reconciles: the header totals equal the sum of the lines, exactly", () => {
    // The same invariant the database enforces at COMMIT. Proven here on
    // awkward pennies rather than round numbers.
    const rows = [
      snap({ payment_id: "a", supplier_id: "s1", cis_gross_payment: 333.33, materials_total: 11.11, cis_deduction: 64.44 }),
      snap({ payment_id: "b", supplier_id: "s2", cis_gross_payment: 166.67, materials_total: 0.01, cis_deduction: 33.33 }),
      snap({ payment_id: "c", supplier_id: "s2", paid_at: "2026-07-21", cis_gross_payment: 0.01, materials_total: 0, cis_deduction: 0 }),
    ];
    const ds = buildMonthlyReturnDataset(rows, TAX_MONTH_END);
    const sum = (f: (l: (typeof ds.lines)[number]) => number) =>
      Math.round(ds.lines.reduce((n, l) => n + f(l), 0) * 100) / 100;

    expect(ds.totalGross).toBe(sum((l) => l.grossAmount));
    expect(ds.totalMaterials).toBe(sum((l) => l.materialsAmount));
    expect(ds.totalDeduction).toBe(sum((l) => l.deductionAmount));
    expect(ds.paymentCount).toBe(rows.length);
  });

  it("has no status that could be mistaken for filed", () => {
    // The load-bearing product constraint: CrewFlow does not file. If a
    // "submitted" state ever appears in this list, a user can claim a statutory
    // obligation was met when it was not.
    expect([...CIS_RETURN_STATUSES]).toEqual(["prepared", "exported"]);
    expect(CIS_NO_FILING_NOTICE).toMatch(/does not file/i);
  });
});

// ---------------------------------------------------------------------------
// Staleness after a void
// ---------------------------------------------------------------------------

describe("assessStatementFreshness", () => {
  it("is fresh when the ledger fingerprint still matches", () => {
    expect(
      assessStatementFreshness({ storedFingerprint: "a".repeat(64), currentFingerprint: "a".repeat(64), status: "issued" }),
    ).toEqual({ fresh: true, reason: null });
  });

  it("is STALE when a covered payment has been voided since issue", () => {
    const r = assessStatementFreshness({
      storedFingerprint: "a".repeat(64),
      currentFingerprint: "b".repeat(64),
      status: "issued",
    });
    expect(r.fresh).toBe(false);
    // The remedy must be a REPLACEMENT, never an edit — the subcontractor holds
    // the original.
    expect(r.reason).toMatch(/replacement/i);
  });

  it("does not nag about an already-superseded or withdrawn statement", () => {
    for (const status of ["superseded", "withdrawn"] as const) {
      expect(
        assessStatementFreshness({
          storedFingerprint: "a".repeat(64),
          currentFingerprint: "b".repeat(64),
          status,
        }).fresh,
      ).toBe(true);
    }
  });
});

describe("daysUntil", () => {
  it("counts forwards and backwards across a deadline", () => {
    expect(daysUntil("2026-08-19", "2026-08-05")).toBe(14);
    expect(daysUntil("2026-08-19", "2026-08-19")).toBe(0);
    expect(daysUntil("2026-08-19", "2026-08-25")).toBe(-6);
    expect(daysUntil("nonsense", "2026-08-25")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The contractor's own identity — required, never derived
// ---------------------------------------------------------------------------

describe("contractor identity", () => {
  it("refuses to consider an org statement-ready without a PAYE reference", () => {
    expect(assessContractorReadiness(null).ready).toBe(false);
    expect(assessContractorReadiness({ legal_name: "Acme", employer_paye_reference: "" }).ready).toBe(false);
    expect(assessContractorReadiness({ legal_name: "", employer_paye_reference: "123/AB1" }).ready).toBe(false);
    expect(assessContractorReadiness({ legal_name: "Acme", employer_paye_reference: "123/AB1" })).toEqual({
      ready: true,
      reason: null,
    });
  });

  it("canonicalises a PAYE reference and rejects a shape that is not one", () => {
    expect(canonicalisePayeReference(" 123 / ab45678 ")).toBe("123/AB45678");
    expect(canonicalisePayeReference("123/A246")).toBe("123/A246");
    expect(canonicalisePayeReference("12345678")).toBeNull();
    expect(canonicalisePayeReference("")).toBeNull();
    expect(canonicalisePayeReference("ABC/12345")).toBeNull();
  });
});
