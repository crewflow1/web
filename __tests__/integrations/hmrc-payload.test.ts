import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { composeVatReturn } from "@/lib/integrations/hmrc/vat-return";
import { composeCis300Return } from "@/lib/integrations/hmrc/cis-return";
import { buildFraudPreventionHeaders } from "@/lib/integrations/hmrc/fraud-headers";
import { computeVatQuarter, computeVatNetTotals } from "@/lib/tax/compute";
import type { MonthlyReturnDataset } from "@/lib/cis/statements";

/**
 * HMRC payload composers (20261099) — box mapping + refusal, as pure functions.
 *
 * These prove the composers map CrewFlow's EXISTING authorities onto the HMRC
 * shapes correctly WHEN connectable, and refuse WHEN dark. They set the
 * connectable env locally so the box-mapping logic can be exercised; the security
 * tier proves the dark refusal against the real (unset) posture.
 */

const CONNECTABLE_ENV = {
  HMRC_CLIENT_ID: "test-client-id",
  HMRC_CLIENT_SECRET: "test-client-secret",
  NEXT_PUBLIC_FEATURE_HMRC_CONNECT: "true",
};

describe("composeVatReturn — 9-box mapping from computeVatQuarter", () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, CONNECTABLE_ENV);
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("maps boxes 1/4 from the VAT authority and derives 3/5", () => {
    // Two paid invoices → output VAT 1000; one finance row → input VAT 400.
    const vat = computeVatQuarter(
      [
        { status: "paid", vat_total: 600, total: 3600, amount: 3000, paid_at: "2026-05-01", created_at: "2026-05-01" },
        { status: "paid", vat_total: 400, total: 2400, amount: 2000, paid_at: "2026-05-10", created_at: "2026-05-10" },
      ],
      [{ vat_total: 400, amount: 2000, created_at: "2026-05-02" }],
      "2026-04-01",
    );
    const res = composeVatReturn({ periodKey: "18A1", vat });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;
    expect(p.periodKey).toBe("18A1");
    expect(p.vatDueSales).toBe(1000); // box 1
    expect(p.vatDueAcquisitions).toBe(0); // box 2 default
    expect(p.totalVatDue).toBe(1000); // box 3 = 1 + 2
    expect(p.vatReclaimedCurrPeriod).toBe(400); // box 4
    expect(p.netVatDue).toBe(600); // box 5 = |3 - 4|
    // COMPOSER DEFAULT ONLY: with no netTotals supplied, boxes 6-9 default to 0.
    // The LIVE prepare path MUST supply boxes 6/7 (see the reconciliation test
    // below) — a bare compose like this must not be used to freeze a real return.
    expect(p.totalValueSalesExVAT).toBe(0);
    expect(p.totalValuePurchasesExVAT).toBe(0);
    expect(p.totalValueGoodsSuppliedExVAT).toBe(0);
    expect(p.totalAcquisitionsExVAT).toBe(0);
    // never silently finalised
    expect(p.finalised).toBe(false);
  });

  it("LIVE prepare path: boxes 6/7 are the ex-VAT net totals reconciling with boxes 1/4 (not frozen at £0)", () => {
    // Mirrors server/services/hmrc-connections.ts prepareVatReturn EXACTLY: the
    // same in-window rows feed computeVatQuarter (boxes 1/4) AND computeVatNetTotals
    // (boxes 6/7), then composeVatReturn freezes the 9-box payload. Representative
    // paid invoices + finance rows, all inside [2026-04-01, 2026-07-01).
    const quarterStart = "2026-04-01";
    const quarterEnd = "2026-07-01";
    const invoices = [
      // 20% VAT: net 3000 → VAT 600 ; net 2000 → VAT 400
      { status: "paid", vat_total: 600, total: 3600, amount: 3000, paid_at: "2026-05-01", created_at: "2026-04-20" },
      { status: "paid", vat_total: 400, total: 2400, amount: 2000, paid_at: "2026-05-10", created_at: "2026-05-02" },
      // out-of-window paid invoice — must NOT feed box 1 OR box 6
      { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2026-08-01", created_at: "2026-07-30" },
      // unpaid invoice — must NOT feed box 1 OR box 6
      { status: "sent", vat_total: 123, total: 738, amount: 615, paid_at: null, created_at: "2026-05-05" },
    ];
    const finances = [
      { vat_total: 400, amount: 2000, created_at: "2026-05-02" },
      { vat_total: 100, amount: 500, created_at: "2026-06-15" },
      // out-of-window cost — must NOT feed box 4 OR box 7
      { vat_total: 50, amount: 250, created_at: "2026-03-31" },
    ];

    const vat = computeVatQuarter(invoices, finances, quarterStart, quarterEnd);
    const netTotals = computeVatNetTotals(invoices, finances, quarterStart, quarterEnd);
    const res = composeVatReturn({ periodKey: "2026-04-01", vat, netTotals }, { allowInternalPrepare: true });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;

    // boxes 1/4 unchanged (the fix touches ONLY 6/7)
    expect(p.vatDueSales).toBe(1000); // box 1: 600 + 400
    expect(p.vatReclaimedCurrPeriod).toBe(500); // box 4: 400 + 100

    // THE FIX: boxes 6/7 are derived, > 0, and reconcile with the rows feeding 1/4
    expect(p.totalValueSalesExVAT).toBe(5000); // box 6: net 3000 + 2000 (paid, in-window)
    expect(p.totalValuePurchasesExVAT).toBe(2500); // box 7: net 2000 + 500 (in-window)
    expect(p.totalValueSalesExVAT).toBeGreaterThan(0);
    expect(p.totalValuePurchasesExVAT).toBeGreaterThan(0);

    // Reconciliation: box 6 ≈ box 1 / 0.20 and box 7 ≈ box 4 / 0.20 at the 20%
    // standard rate — the net values are the exact base the VAT boxes were charged on.
    expect(p.totalValueSalesExVAT).toBe(Math.round(p.vatDueSales / 0.2));
    expect(p.totalValuePurchasesExVAT).toBe(Math.round(p.vatReclaimedCurrPeriod / 0.2));

    // EU-only / acquisition boxes correctly stay 0 for a UK-domestic contractor
    expect(p.totalValueGoodsSuppliedExVAT).toBe(0); // box 8
    expect(p.totalAcquisitionsExVAT).toBe(0); // box 9
    expect(p.vatDueAcquisitions).toBe(0); // box 2
  });

  it("net VAT due is always non-negative (repayment case)", () => {
    const res = composeVatReturn({
      periodKey: "18A2",
      vat: { output_vat: 100, input_vat: 450, net_payable: -350, confidence: "computed" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.netVatDue).toBe(350); // |100 - 450|
  });

  it("carries boxes 2/6-9 from optional net totals, rounding 6-9 to whole pounds", () => {
    const res = composeVatReturn({
      periodKey: "18A3",
      vat: { output_vat: 200, input_vat: 50, net_payable: 150, confidence: "computed" },
      netTotals: {
        vatDueAcquisitions: 30,
        totalValueSalesExVAT: 1234.56,
        totalValuePurchasesExVAT: 789.4,
        totalValueGoodsSuppliedExVAT: 12.9,
        totalAcquisitionsExVAT: 5.1,
      },
      finalised: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;
    expect(p.vatDueAcquisitions).toBe(30); // box 2
    expect(p.totalVatDue).toBe(230); // box 3 = 200 + 30
    expect(p.netVatDue).toBe(180); // |230 - 50|
    expect(p.totalValueSalesExVAT).toBe(1235); // whole pounds
    expect(p.totalValuePurchasesExVAT).toBe(789);
    expect(p.totalValueGoodsSuppliedExVAT).toBe(13);
    expect(p.totalAcquisitionsExVAT).toBe(5);
    expect(p.finalised).toBe(true);
  });

  it("refuses an empty periodKey even when connectable", () => {
    const res = composeVatReturn({
      periodKey: "   ",
      vat: { output_vat: 1, input_vat: 0, net_payable: 1, confidence: "computed" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid");
  });
});

describe("composeCis300Return — CIS300 mapping from the return dataset", () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, CONNECTABLE_ENV);
  });
  afterEach(() => {
    process.env = { ...original };
  });

  const dataset: MonthlyReturnDataset = {
    taxMonthStart: "2026-04-06",
    taxMonthEnd: "2026-05-05",
    taxMonthLabel: "6 Apr–5 May 2026",
    dueOn: "2026-05-19",
    isNil: false,
    subcontractorCount: 2,
    paymentCount: 3,
    totalGross: 5000,
    totalMaterials: 800,
    totalDeduction: 840,
    lines: [
      {
        supplierId: "sup-a",
        subcontractorName: "Alpha Groundworks Ltd",
        utrMasked: "*****4321",
        verificationNumber: null,
        verificationNumberRequired: false,
        rate: { uniform: true, rate: 20, status: "standard_20" },
        grossAmount: 3000,
        materialsAmount: 500,
        deductionAmount: 500,
        paymentCount: 2,
      },
      {
        supplierId: "sup-b",
        subcontractorName: "Beta Brick",
        utrMasked: "*****9876",
        verificationNumber: "V1234567890",
        verificationNumberRequired: true,
        rate: { uniform: true, rate: 30, status: "higher_30" },
        grossAmount: 2000,
        materialsAmount: 300,
        deductionAmount: 340,
        paymentCount: 1,
      },
    ],
  };

  it("maps each subcontractor line onto the CIS300 vocabulary", () => {
    const res = composeCis300Return({ dataset });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const p = res.payload;
    expect(p.taxYear).toBe("2026-27"); // month ending 5 May 2026 → 2026-27 tax year
    expect(p.taxMonth).toEqual({ from: "2026-04-06", to: "2026-05-05" });
    expect(p.nilReturn).toBe(false);
    expect(p.subcontractors).toHaveLength(2);
    expect(p.subcontractors[0]).toEqual({
      name: "Alpha Groundworks Ltd",
      utr: "*****4321",
      verificationNumber: null,
      totalPayments: 3000,
      costOfMaterials: 500,
      totalDeducted: 500,
    });
    expect(p.subcontractors[1]!.verificationNumber).toBe("V1234567890");
    expect(p.subcontractors[1]!.totalDeducted).toBe(340);
  });

  it("NEVER asserts a declaration on the user's behalf", () => {
    const res = composeCis300Return({ dataset });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.declarations).toEqual({
      employmentStatus: null,
      verification: null,
      informationCorrect: null,
      inactivity: null,
    });
  });

  it("classifies a nil month (no payments) as a reportable nil return", () => {
    const nil: MonthlyReturnDataset = { ...dataset, isNil: true, lines: [], subcontractorCount: 0, paymentCount: 0 };
    const res = composeCis300Return({ dataset: nil });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.nilReturn).toBe(true);
    expect(res.payload.subcontractors).toHaveLength(0);
  });

  it("derives the tax year across the 5/6 April boundary", () => {
    const march = { ...dataset, taxMonthStart: "2026-03-06", taxMonthEnd: "2026-04-05" };
    const res = composeCis300Return({ dataset: march });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // A month ending 5 April 2026 belongs to the 2025-26 tax year.
    expect(res.payload.taxYear).toBe("2025-26");
  });
});

describe("buildFraudPreventionHeaders — pure Gov-Client/Gov-Vendor builder", () => {
  it("emits only the headers whose inputs are present (never fabricates)", () => {
    const headers = buildFraudPreventionHeaders(
      {
        deviceId: "dev-uuid-1",
        userId: "user-9",
        timezone: "Europe/London",
        publicIps: ["203.0.113.4"],
        publicIpTimestamp: "2026-05-01T09:00:00Z",
        userAgent: "Mozilla/5.0",
        screen: { widthPx: 1920, heightPx: 1080, scalingFactor: 2, colourDepth: 24 },
        window: { widthPx: 1200, heightPx: 800 },
      },
      { productName: "CrewFlow", productVersion: "2026.8.1" },
    );
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(headers["Gov-Client-Device-ID"]).toBe("dev-uuid-1");
    expect(headers["Gov-Client-User-IDs"]).toBe("crewflow=user-9");
    expect(headers["Gov-Client-Timezone"]).toBe("Europe/London");
    expect(headers["Gov-Client-Public-IP"]).toBe("203.0.113.4");
    expect(headers["Gov-Client-Public-IP-Timestamp"]).toBe("2026-05-01T09:00:00Z");
    expect(headers["Gov-Client-Screens"]).toBe("width=1920&height=1080&scaling-factor=2&colour-depth=24");
    expect(headers["Gov-Client-Window-Size"]).toBe("width=1200&height=800");
    expect(headers["Gov-Vendor-Product-Name"]).toBe("CrewFlow");
    expect(headers["Gov-Vendor-Version"]).toBe("CrewFlow=2026.8.1");
  });

  it("omits absent optional headers rather than emitting blanks", () => {
    const headers = buildFraudPreventionHeaders();
    expect(headers["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(headers["Gov-Vendor-Product-Name"]).toBe("CrewFlow");
    expect(headers).not.toHaveProperty("Gov-Client-Device-ID");
    expect(headers).not.toHaveProperty("Gov-Client-Public-IP");
    expect(headers).not.toHaveProperty("Gov-Client-Screens");
  });
});
