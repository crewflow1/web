import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsvFile } from "@/lib/imports/parsers";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { importedCreatedAt } from "@/lib/imports/dates";
import { buildInvoiceImportPlan } from "@/lib/imports/invoice-row";
import { buildFinanceImportPlan } from "@/lib/imports/vat";

/**
 * An imported row keeps the date the source file gave it.
 *
 * The mapper always extracted that date — COST_FIELDS maps "date" / "expense
 * date" / "created", INVOICE_FIELDS maps "invoice date" / "date" / "created" —
 * but the commit path dropped it on the floor, so a firm importing two years of
 * expense history got every cost stamped with the day the migration ran.
 * `finances.created_at` is the column the VAT-quarter and tax-year queries
 * filter on, so the whole history collapsed into the CURRENT quarter and every
 * historical quarter read as empty.
 *
 * That the back-dated value actually PERSISTS, and lands in the right quarter
 * regardless of the database's timezone, is proved against real Postgres in
 * __tests__/integration/rls/import-back-dating.test.ts — a unit test can't see
 * a NOT NULL column, a default, or a session TimeZone.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("importedCreatedAt — the file's date, pinned to an instant", () => {
  it("anchors a date-only value to midnight UTC", () => {
    // Explicitly, not by handing Postgres a bare date: a bare date resolves
    // against the session TimeZone, so the stored instant would depend on a
    // server setting rather than on the file.
    expect(importedCreatedAt("2024-03-15")).toEqual({
      ok: true,
      value: "2024-03-15T00:00:00.000Z",
    });
    expect(importedCreatedAt("2026-01-01")).toEqual({
      ok: true,
      value: "2026-01-01T00:00:00.000Z",
    });
  });

  it("yields NO VALUE — never null — when the file gave no date", () => {
    // Both created_at columns are NOT NULL with `default now()`. The absent
    // case has to omit the key; an explicit null would fail the whole row.
    for (const absent of [undefined, null, "", "   "]) {
      const r = importedCreatedAt(absent);
      expect(r).toEqual({ ok: true });
      expect(r.ok && r.value).toBeUndefined();
    }
  });

  it("treats a date it cannot read as a ROW-LEVEL ERROR, not a fallback", () => {
    // The distinction that matters: "no date" means use now(); "a date I can't
    // read" means the operator has a broken cell, and silently substituting
    // now() would file that row in the wrong VAT quarter — the exact defect
    // this module exists to fix.
    for (const bad of ["not a date", "2024-13-45", "2024-02-31", 20240315, {}]) {
      const r = importedCreatedAt(bad);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/Couldn't read/);
    }
  });

  it("rejects an out-of-range date rather than letting Date roll it forward", () => {
    // normaliseDate's DD/MM/YYYY branch assembles its output from the digits it
    // matched without checking them, and Date.parse would happily roll
    // 2024-02-31 into 2024-03-02 — back-dating the row to a day the file never
    // mentioned, in a quarter it never mentioned.
    expect(importedCreatedAt("2024-02-31").ok).toBe(false);
  });

  it("keeps a full timestamp that already carries a time", () => {
    expect(importedCreatedAt("2024-03-15T09:30:00.000Z")).toEqual({
      ok: true,
      value: "2024-03-15T09:30:00.000Z",
    });
  });
});

describe("buildFinanceImportPlan — back-dating an imported cost", () => {
  it("writes the mapped created_at into the finances row", () => {
    expect(
      buildFinanceImportPlan({ amount: 100, vat_rate: 20, created_at: "2024-03-15" }, "org-1"),
    ).toMatchObject({
      status: "ok",
      row: { amount: 100, vat_rate: 20, created_at: "2024-03-15T00:00:00.000Z" },
    });
  });

  it("OMITS the key entirely when the file had no date column", () => {
    // Not `created_at: null` and not `created_at: undefined` — the column is
    // NOT NULL, and only an absent key falls back to `default now()`.
    const plan = buildFinanceImportPlan({ amount: 100, vat_rate: 20 }, "org-1");
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && "created_at" in plan.row).toBe(false);
  });

  it("rejects the row when the file's date is unreadable", () => {
    const plan = buildFinanceImportPlan(
      { amount: 100, vat_rate: 20, created_at: "2024-13-45" },
      "org-1",
    );
    expect(plan.status).toBe("reject");
    expect(plan.status === "reject" && plan.reason).toMatch(/Couldn't read/);
  });
});

describe("buildInvoiceImportPlan — back-dating an imported invoice", () => {
  it("writes the mapped created_at and omits the generated total", () => {
    const plan = buildInvoiceImportPlan(
      { number: "INV-1", total: 120, vat_total: 20, amount: 100, created_at: "2024-05-09" },
      "org-1",
      "sent",
    );
    expect(plan.status).toBe("ok");
    expect(plan.status === "ok" && plan.row).toMatchObject({
      number: "INV-1",
      amount: 100,
      vat_total: 20,
      created_at: "2024-05-09T00:00:00.000Z",
    });
    expect(plan.status === "ok" && Object.keys(plan.row)).not.toContain("total");
  });

  it("derives the net amount from the total when the file gives no net figure", () => {
    const plan = buildInvoiceImportPlan(
      { number: "INV-2", total: 120, vat_total: 20 },
      "org-1",
      "sent",
    );
    expect(plan.status === "ok" && plan.row.amount).toBe(100);
  });

  it("omits created_at when the file had no date", () => {
    const plan = buildInvoiceImportPlan({ number: "INV-3", total: 120 }, "org-1", "sent");
    expect(plan.status === "ok" && "created_at" in plan.row).toBe(false);
  });

  it("rejects an invoice whose date is unreadable", () => {
    const plan = buildInvoiceImportPlan(
      { number: "INV-4", total: 120, created_at: "2024-13-45" },
      "org-1",
      "sent",
    );
    expect(plan.status).toBe("reject");
  });
});

describe("cost sheets → the date the expense happened", () => {
  const planFor = (csv: string, rowIdx = 0) => {
    const sheet = parseCsvFile(csv);
    const d = detectEntityType(sheet);
    return { d, plan: buildFinanceImportPlan(mapRow(d, sheet.rows[rowIdx]!).mapped, "org-1") };
  };

  it("maps a Date column through to the finances row", () => {
    const { d, plan } = planFor(
      "Date,Description,Amount,VAT Rate,Category\n2024-03-15,Cable,100,20,materials",
    );
    expect(d.entity_type).toBe("cost");
    expect(plan).toMatchObject({
      status: "ok",
      row: { amount: 100, created_at: "2024-03-15T00:00:00.000Z" },
    });
  });

  it("maps an Expense Date column the same way", () => {
    const { plan } = planFor(
      "Expense Date,Description,Amount,Category\n2023-11-02,Timber,250,materials",
    );
    expect(plan).toMatchObject({
      status: "ok",
      row: { created_at: "2023-11-02T00:00:00.000Z" },
    });
  });

  it("reads a UK DD/MM/YYYY date as day-first", () => {
    const { plan } = planFor("Date,Description,Amount,Category\n03/04/2024,Sand,60,materials");
    // 3 April, not 4 March — and those fall in different VAT quarters.
    expect(plan).toMatchObject({
      status: "ok",
      row: { created_at: "2024-04-03T00:00:00.000Z" },
    });
  });

  it("leaves the column to the DB default when the sheet has no date at all", () => {
    const { d, plan } = planFor("Description,Amount,Category\nCable,100,materials");
    expect(d.entity_type).toBe("cost");
    expect(plan.status === "ok" && "created_at" in plan.row).toBe(false);
  });

  it("keeps each row on its own date across a multi-year history", () => {
    // The reported symptom: a two-year expense file must not collapse onto a
    // single day.
    const sheet = parseCsvFile(
      "Date,Description,Amount,Category\n" +
        "2024-01-15,Cable,100,materials\n" +
        "2025-06-30,Timber,200,materials\n" +
        "2026-02-01,Sand,300,materials",
    );
    const d = detectEntityType(sheet);
    const dates = sheet.rows.map((row) => {
      const plan = buildFinanceImportPlan(mapRow(d, row).mapped, "org-1");
      return plan.status === "ok" ? plan.row.created_at : null;
    });
    expect(dates).toEqual([
      "2024-01-15T00:00:00.000Z",
      "2025-06-30T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ]);
  });

  it("puts each UK VAT quarter boundary on the right side of the line", () => {
    // Quarter starts are the dates a timezone slip would move; each of these is
    // the FIRST day of a quarter, which is where an off-by-one lands in the
    // previous one.
    const firstDays = ["2024-01-01", "2024-04-01", "2024-07-01", "2024-10-01"];
    for (const day of firstDays) {
      const r = importedCreatedAt(day);
      expect(r.ok && r.value).toBe(`${day}T00:00:00.000Z`);
    }
  });
});

describe("invoice sheets → the date the invoice was raised", () => {
  it("maps an Invoice Date column onto created_at", () => {
    const sheet = parseCsvFile(
      "Invoice Number,Invoice Date,Net,VAT,Total,Status\nINV-1,2024-05-09,100,20,120,paid",
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("invoice");
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.created_at).toBe("2024-05-09");
    // due_date is a separate column and must not be confused with it.
    expect(r.mapped.due_date).toBeUndefined();
  });

  it("keeps the invoice date distinct from the due date", () => {
    const sheet = parseCsvFile(
      "Invoice Number,Invoice Date,Due Date,Net,VAT,Total\nINV-2,2024-05-09,2024-06-08,100,20,120",
    );
    const d = detectEntityType(sheet);
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.created_at).toBe("2024-05-09");
    expect(r.mapped.due_date).toBe("2024-06-08");
  });
});

describe("source contract — the commit path writes the file's date", () => {
  it("both row builders thread the date through the one canonical helper", () => {
    // One helper owns the absent/valid/malformed decision. Two call sites each
    // doing their own thing is how the invoice branch and the cost branch drift
    // apart again.
    expect(read("lib/imports/vat.ts")).toContain("importedCreatedAt");
    expect(read("lib/imports/invoice-row.ts")).toContain("importedCreatedAt");
  });
});
