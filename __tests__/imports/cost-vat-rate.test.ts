import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsvFile } from "@/lib/imports/parsers";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import {
  buildFinanceImportPlan,
  parseVatRate,
  resolveCostVatRate,
} from "@/lib/imports/vat";

/**
 * Imported costs carry a VAT figure; `public.finances` only accepts a VAT
 * *rate*, because `vat_total` is a stored generated column. These tests cover
 * the mapping between the two.
 *
 * The database half of the contract — that `vat_total` is unwritable and
 * `vat_rate` is CHECK-constrained to 0/5/20 — is proved against real Postgres
 * in __tests__/integration/rls/import-generated-columns.test.ts. A unit test
 * can't prove it: a mocked client accepts any column you hand it.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("parseVatRate — reading a VAT-rate cell", () => {
  it("reads plain percentages", () => {
    expect(parseVatRate(20)).toBe(20);
    expect(parseVatRate(5)).toBe(5);
    expect(parseVatRate(0)).toBe(0);
    expect(parseVatRate("20")).toBe(20);
    expect(parseVatRate("20%")).toBe(20);
    expect(parseVatRate(" 5 % ")).toBe(5);
  });

  it("reads percent-formatted cells, which SheetJS hands over as fractions", () => {
    // A cell displayed as "20%" is stored as 0.2. Twenty pence is not a
    // plausible reading of a VAT-rate column.
    expect(parseVatRate(0.2)).toBe(20);
    expect(parseVatRate(0.05)).toBe(5);
    expect(parseVatRate("0.2")).toBe(20);
  });

  it("does NOT re-scale a figure that is explicitly in percent units", () => {
    // "0.2%" says what it means; it must stay 0.2 and be rejected downstream.
    expect(parseVatRate("0.2%")).toBe(0.2);
  });

  it("reads the rate names accounting exports use", () => {
    expect(parseVatRate("Standard")).toBe(20);
    expect(parseVatRate("Standard rate")).toBe(20);
    expect(parseVatRate("Reduced rate")).toBe(5);
    expect(parseVatRate("Zero rated")).toBe(0);
    expect(parseVatRate("Exempt")).toBe(0);
    expect(parseVatRate("No VAT")).toBe(0);
    expect(parseVatRate("20% (VAT on Income)")).toBe(20);
  });

  it("leaves a non-permitted rate alone so it can be rejected BY NAME", () => {
    expect(parseVatRate(17.5)).toBe(17.5);
    expect(parseVatRate("12.5%")).toBe(12.5);
  });

  it("returns null for cells that aren't rates", () => {
    expect(parseVatRate("")).toBeNull();
    expect(parseVatRate("n/a")).toBeNull();
    expect(parseVatRate(null)).toBeNull();
    expect(parseVatRate(undefined)).toBeNull();
  });
});

describe("resolveCostVatRate — imported VAT figure → finances.vat_rate", () => {
  it("backs the rate out of a VAT amount", () => {
    expect(resolveCostVatRate({ amount: 100, vat_total: 20 })).toEqual({
      ok: true,
      vat_rate: 20,
      source: "amount",
    });
    expect(resolveCostVatRate({ amount: 100, vat_total: 5 })).toEqual({
      ok: true,
      vat_rate: 5,
      source: "amount",
    });
    expect(resolveCostVatRate({ amount: 100, vat_total: 0 })).toEqual({
      ok: true,
      vat_rate: 0,
      source: "amount",
    });
  });

  it("tolerates the source system's own 2dp rounding, but only to the penny", () => {
    // 20% of 33.33 is 6.666, which a spreadsheet stores as 6.67.
    expect(resolveCostVatRate({ amount: 33.33, vat_total: 6.67 })).toMatchObject({
      ok: true,
      vat_rate: 20,
    });
    // 5% of 19.99 is 0.9995 → 1.00 in the file.
    expect(resolveCostVatRate({ amount: 19.99, vat_total: 1 })).toMatchObject({
      ok: true,
      vat_rate: 5,
    });
    // Two pence out is not rounding, it's a different number.
    expect(resolveCostVatRate({ amount: 100, vat_total: 20.02 }).ok).toBe(false);
  });

  it("prefers an explicit rate column over the amount", () => {
    // The rate is the writable column and the database recomputes the amount
    // from it, so a stale or differently-rounded amount cell is not a reason to
    // reject a row whose rate is stated plainly.
    expect(
      resolveCostVatRate({ amount: 500, vat_rate: 20, vat_total: 20 }),
    ).toEqual({ ok: true, vat_rate: 20, source: "rate" });
  });

  it("records 0% when the file states no VAT at all", () => {
    // NOT the column's 20% default: finances.vat_total feeds the VAT-quarter
    // figures, so inventing reclaimable VAT the operator never claimed is worse
    // than recording none.
    expect(resolveCostVatRate({ amount: 100 })).toEqual({
      ok: true,
      vat_rate: 0,
      source: "absent",
    });
  });

  it("REJECTS a VAT amount that implies a non-UK rate rather than rounding it", () => {
    const r = resolveCostVatRate({ amount: 100, vat_total: 12.5 });
    expect(r.ok).toBe(false);
    // The message names the figures the operator has to fix.
    expect(!r.ok && r.reason).toMatch(/12\.5%/);
    expect(!r.ok && r.reason).toMatch(/£12\.50/);
    expect(!r.ok && r.reason).toMatch(/£100\.00/);
  });

  it("REJECTS the old 17.5% rate rather than snapping it to 20%", () => {
    // The single most likely bad rate in a UK migration: pre-2011 history.
    // Snapping it to 20% would silently overstate reclaimable VAT on every row.
    const r = resolveCostVatRate({ amount: 200, vat_total: 35 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/17\.5%/);
  });

  it("REJECTS an explicit rate outside 0/5/20", () => {
    for (const bad of ["17.5%", "12.5%", 13.5]) {
      const r = resolveCostVatRate({ amount: 100, vat_rate: bad });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/isn't a UK VAT rate/);
    }
  });

  it("REJECTS VAT that has no net amount to be measured against", () => {
    const r = resolveCostVatRate({ amount: 0, vat_total: 20 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no positive net amount/);
  });
});

describe("buildFinanceImportPlan — the payload the commit path sends", () => {
  it("never includes vat_total (the generated column Postgres refuses)", () => {
    const plan = buildFinanceImportPlan(
      { amount: 100, vat_total: 20, category: "materials", notes: "n" },
      "org-1",
    );
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && plan.row).toEqual({
      org_id: "org-1",
      amount: 100,
      vat_rate: 20,
      category: "materials",
      notes: "n",
    });
    expect(plan.status === "ok" && Object.keys(plan.row)).not.toContain("vat_total");
  });

  it("skips a row with no positive amount", () => {
    expect(buildFinanceImportPlan({ amount: 0 }, "org-1").status).toBe("skip");
    expect(buildFinanceImportPlan({}, "org-1").status).toBe("skip");
    expect(buildFinanceImportPlan({ amount: "abc" }, "org-1").status).toBe("skip");
  });

  it("rejects a row whose VAT can't land on a permitted rate", () => {
    const plan = buildFinanceImportPlan({ amount: 100, vat_total: 12.5 }, "org-1");
    expect(plan.status).toBe("reject");
  });
});

describe("cost sheets → mapped VAT fields", () => {
  it("maps a VAT Rate column onto vat_rate", () => {
    const sheet = parseCsvFile(
      "Date,Description,Amount,VAT Rate,Category\n2026-05-19,Cable,100,20,materials",
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("cost");
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.amount).toBe(100);
    expect(r.mapped.vat_rate).toBe(20);
    expect(buildFinanceImportPlan(r.mapped, "org-1")).toMatchObject({
      status: "ok",
      row: { amount: 100, vat_rate: 20 },
    });
  });

  it("reads a percent-formatted rate cell", () => {
    const sheet = parseCsvFile(
      "Date,Description,Amount,VAT Rate\n2026-05-19,Cable,100,0.2",
    );
    const d = detectEntityType(sheet);
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.vat_rate).toBe(20);
  });

  it("still reads a bare VAT column as the amount, and backs the rate out", () => {
    const sheet = parseCsvFile(
      "Date,Description,Net,VAT,Category\n2026-05-19,Cable,100,20,materials",
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("cost");
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.vat_total).toBe(20);
    expect(r.mapped.vat_rate).toBeUndefined();
    expect(buildFinanceImportPlan(r.mapped, "org-1")).toMatchObject({
      status: "ok",
      row: { amount: 100, vat_rate: 20 },
    });
  });

  it("keeps a cost sheet with no VAT column importable at 0%", () => {
    const sheet = parseCsvFile("Date,Description,Amount\n2026-05-19,Cable,100");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("cost");
    const r = mapRow(d, sheet.rows[0]!);
    expect(buildFinanceImportPlan(r.mapped, "org-1")).toMatchObject({
      status: "ok",
      row: { amount: 100, vat_rate: 0 },
    });
  });

  it("does not read a VAT registration column as reclaimable VAT", () => {
    // The whole point of the header protection, restated in money terms: this
    // row has no VAT, and must import at 0% rather than at whatever the digits
    // of a registration number happen to parse as.
    const sheet = parseCsvFile(
      "Date,Description,Amount,VAT Reg No\n2026-05-19,Cable,100,123456789",
    );
    const d = detectEntityType(sheet);
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.vat_total).toBeUndefined();
    expect(buildFinanceImportPlan(r.mapped, "org-1")).toMatchObject({
      status: "ok",
      row: { amount: 100, vat_rate: 0 },
    });
  });
});

describe("source contract — the commit path never writes a generated column", () => {
  // Postgres refuses an INSERT that supplies a generated column (SQLSTATE
  // 428C9), so both payloads failed 100% of their rows. The database side is
  // proved in __tests__/integration/rls/import-generated-columns.test.ts; what
  // that can't see is the call site, which is what these pin.
  const branch = (src: string, from: string, to: string) =>
    src.slice(src.indexOf(from), src.indexOf(to));

  it("insertOne's cost branch builds its payload with buildFinanceImportPlan", () => {
    // The builder is only a guarantee while insertOne actually uses it.
    // Reverting to a hand-built payload with vat_total is exactly the
    // regression, and it fails here.
    const costBranch = branch(
      read("app/(app)/imports/actions.ts"),
      'case "cost": {',
      'case "staff": {',
    );
    expect(costBranch).toContain("buildFinanceImportPlan");
    expect(costBranch).toContain(".insert(plan.row)");
    expect(costBranch).not.toMatch(/vat_total:/);
  });

  it("insertOne's invoice branch builds its payload with buildInvoiceImportPlan", () => {
    const invoiceBranch = branch(
      read("app/(app)/imports/actions.ts"),
      'case "invoice": {',
      'case "lead": {',
    );
    expect(invoiceBranch).toContain("buildInvoiceImportPlan");
    expect(invoiceBranch).toContain(".insert(plan.row)");
    // `invoices.total` is generated from amount + vat_total and must not be
    // supplied.
    expect(invoiceBranch).not.toMatch(/^\s+total,$/m);
    expect(invoiceBranch).not.toMatch(/total:/);
  });

  it("neither row builder can grow a generated column without a type error", () => {
    // The row types enumerate the WRITABLE columns by hand rather than reusing
    // the permissive generated Insert type, so adding the generated column back
    // fails to compile instead of failing in production.
    expect(read("lib/imports/vat.ts")).toMatch(/vat_total` is deliberately absent/);
    expect(read("lib/imports/invoice-row.ts")).toMatch(/total` is deliberately absent/);
  });
});

/**
 * INVOICE-IMPORT VAT-RATE GUARD (closes the source of the accounting-push
 * batch-poisoning class). An imported invoice carries only header totals, so its
 * derived rate is a single blended figure. A blend that isn't a UK rate (0/5/20)
 * has no honest Xero TaxType / QBO VAT code and would poison the provider push, so
 * buildInvoiceImportPlan REJECTS it at import — the invoice-side mirror of the
 * cost path's resolveCostVatRate. The push-side per-invoice SKIP is the other half
 * (accounting-push.test.ts); this stops the bad row ever reaching the ledger.
 */
describe("buildInvoiceImportPlan — VAT-rate guard", () => {
  it("accepts the three UK rates (20% / 5% / 0%)", () => {
    for (const [total, vat] of [
      [120, 20], // 20%
      [105, 5], // 5%
      [100, 0], // 0% (no VAT)
    ] as const) {
      const plan = buildInvoiceImportPlan(
        { number: "INV-OK", total, vat_total: vat },
        "org-1",
        "sent",
      );
      expect(plan.status).toBe("ok");
    }
  });

  it("REJECTS a legacy 17.5% invoice with a clear, named reason", () => {
    // net 100 + VAT 17.50 → 17.5%, not a UK rate. Before the guard this reached
    // the ledger and later exempted the whole invoice on the provider push.
    const plan = buildInvoiceImportPlan(
      { number: "INV-175", total: 117.5, vat_total: 17.5, amount: 100 },
      "org-1",
      "sent",
    );
    expect(plan.status).toBe("reject");
    expect(plan.status === "reject" && plan.reason).toMatch(/17\.5%|UK VAT rate/);
  });

  it("REJECTS a header-only mixed-rate construction invoice (a blended non-standard rate)", () => {
    // A real 20%+5% construction invoice imported header-only: net 200, VAT 25 →
    // blended 12.5%, which no provider code maps. It must be split per rate first.
    const plan = buildInvoiceImportPlan(
      { number: "INV-MIX", total: 225, vat_total: 25, amount: 200 },
      "org-1",
      "sent",
    );
    expect(plan.status).toBe("reject");
    expect(plan.status === "reject" && plan.reason).toMatch(/UK VAT rate/);
  });

  it("REJECTS VAT with no positive net to measure it against", () => {
    const plan = buildInvoiceImportPlan(
      { number: "INV-NONET", total: 20, vat_total: 20, amount: 0 },
      "org-1",
      "sent",
    );
    expect(plan.status).toBe("reject");
  });

  it("still SKIPS a row with no number or no positive total (unchanged)", () => {
    expect(buildInvoiceImportPlan({ total: 120, vat_total: 20 }, "org-1", "sent").status).toBe(
      "skip",
    );
    expect(
      buildInvoiceImportPlan({ number: "INV-0", total: 0 }, "org-1", "sent").status,
    ).toBe("skip");
  });
});
