import { describe, it, expect } from "vitest";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { parseCsvFile } from "@/lib/imports/parsers";

describe("detectEntityType", () => {
  it("identifies a customer sheet from exact column names", () => {
    const sheet = parseCsvFile("Name,Email,Phone,Postcode\nAcme,info@x.test,07700,SW1A 1AA");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    expect(d.confidence).toBeGreaterThanOrEqual(70);
    expect(d.column_map.name).toBe("Name");
    expect(d.column_map.email).toBe("Email");
  });

  it("identifies an invoice sheet with substring matches (e.g. 'Inv #')", () => {
    const sheet = parseCsvFile("Inv #,Total,Due Date,Status\nINV-001,1200,2026-06-01,sent");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("invoice");
    expect(d.column_map.number).toBe("Inv #");
    expect(d.column_map.total).toBe("Total");
  });

  it("identifies a staff sheet with hourly_pay", () => {
    const sheet = parseCsvFile("Full Name,Email,Hourly Rate,Start Date\nJane,j@x.test,15,2026-01-01");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("staff");
    expect(d.column_map.hourly_pay).toBe("Hourly Rate");
  });

  it("falls back to 'unknown' when nothing matches", () => {
    const sheet = parseCsvFile("Foo,Bar,Baz\n1,2,3");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("unknown");
    expect(d.confidence).toBe(0);
  });

  it("requires the required fields to be present", () => {
    // Header has email + phone but NO name → not a customer.
    const sheet = parseCsvFile("Email,Phone\nx@x.test,07700");
    const d = detectEntityType(sheet);
    expect(d.entity_type).not.toBe("customer");
  });

  it("disambiguates between customer + lead when both could match", () => {
    // 'Service' + 'Source' are lead-specific signals.
    const sheet = parseCsvFile("Name,Email,Source,Service\nx,x@x.test,Google,Plumbing");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("lead");
  });
});

describe("mapRow", () => {
  it("canonicalises numeric/date/email fields", () => {
    const sheet = parseCsvFile(
      "Invoice Number,Total,VAT,Due Date,Status\nINV-001,\"£1,200.00\",200,01/06/2026,Paid",
    );
    const d = detectEntityType(sheet);
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.entity_type).toBe("invoice");
    expect(r.mapped.number).toBe("INV-001");
    expect(r.mapped.total).toBe(1200);
    expect(r.mapped.vat_total).toBe(200);
    expect(r.mapped.due_date).toBe("2026-06-01");
    expect(r.mapped.status).toBe("paid");
  });

  it("knocks confidence down when required fields are missing on this row", () => {
    // Postcode column makes this an unambiguous customer sheet (staff has no postcode field).
    const sheet = parseCsvFile("Name,Email,Postcode\nJane,j@x.test,SW1A 1AA\n,missing-name@x.test,SW1A 2BB");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    const ok = mapRow(d, sheet.rows[0]!);
    const bad = mapRow(d, sheet.rows[1]!);
    expect(ok.confidence).toBeGreaterThan(bad.confidence);
    expect(bad.warnings.some((w) => w.includes("missing name"))).toBe(true);
  });

  it("rejects bad email values with a warning but keeps the row", () => {
    const sheet = parseCsvFile("Name,Email,Postcode\nJane,not-an-email,SW1A 1AA");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.email).toBeUndefined();
    expect(r.mapped.name).toBe("Jane");
    expect(r.warnings.some((w) => w.includes("bad email"))).toBe(true);
  });

  it("normalises employment_type free text", () => {
    const sheet = parseCsvFile(
      "Full Name,Email,Hourly Rate,Employment Type\nJane,j@x.test,15,Self-employed subbie",
    );
    const d = detectEntityType(sheet);
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.employment_type).toBe("self_employed");
  });

  it("parses Excel serial dates into ISO", () => {
    // 45474 ≈ 2024-07-13 in Excel's serial-date scheme.
    // Use a known value: 2026-05-19 corresponds to serial 46161
    const sheet = {
      name: "x",
      header: ["Date", "Amount"],
      rows: [[46161, 100] as (string | number)[]],
    };
    const d = detectEntityType({
      name: "x",
      header: ["Date", "Amount"],
      rows: [],
    });
    // Cost detection: amount + date → cost
    expect(d.entity_type).toBe("cost");
    const r = mapRow(d, sheet.rows[0]!);
    expect(r.mapped.created_at).toBe("2026-05-19");
    expect(r.mapped.amount).toBe(100);
  });
});

describe("detectEntityType — staff vs customer (launch-blocker regression)", () => {
  // The defect: a customer list (name/email/phone) scored HIGHER as staff
  // (staff's smaller catalog inflates its per-field average), so customers were
  // silently filed as staff — then skipped on commit (staff never auto-import)
  // and offered a "send staff invite" CTA. The fix gates staff behind an
  // explicit staff signal and routes soft-only ties to manual review.

  it("classifies a plain name/email/phone sheet as CUSTOMER, not staff", () => {
    const sheet = parseCsvFile("name,email,phone\nAcme Ltd,info@acme.test,07700900100");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    expect(d.review_required ?? false).toBe(false);
  });

  it("classifies full name/email/mobile as CUSTOMER when no staff signal is present", () => {
    const sheet = parseCsvFile("Full Name,Email,Mobile\nBob Sparks,bob@x.test,07700900201");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    expect(d.review_required ?? false).toBe(false);
  });

  it("classifies name/email/hourly rate as STAFF (a strong staff signal)", () => {
    const sheet = parseCsvFile("name,email,hourly rate\nJane,jane@x.test,18.50");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("staff");
    expect(d.review_required ?? false).toBe(false);
  });

  it.each([
    "employment type",
    "start date",
    "hire date",
    "payroll number",
    "wage",
  ])("treats '%s' as a strong staff signal → STAFF (no review)", (signal) => {
    const sheet = parseCsvFile(`name,email,${signal}\nJane,jane@x.test,value`);
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("staff");
    expect(d.review_required ?? false).toBe(false);
  });

  it("routes a soft-only staff win (job title) to review as a CUSTOMER", () => {
    // "job title" is a SOFT signal — it appears on staff rosters AND on plenty
    // of CRM/customer exports. So staff is only a weak candidate: lean to
    // customer and force manual review rather than auto-filing people as staff.
    const sheet = parseCsvFile("name,email,phone,job title\nJane,jane@x.test,07700,Engineer");
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("customer");
    expect(d.review_required).toBe(true);
  });
});
