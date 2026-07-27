import { describe, it, expect } from "vitest";
import { parseCsvFile } from "@/lib/imports/parsers";
import { detectEntityType, mapRow } from "@/lib/imports/detect";
import { headerTokens, matchColumns, normaliseHeader } from "@/lib/imports/header-match";

/**
 * Header matching is a money-integrity problem, not a convenience feature.
 *
 * The matcher it replaced took, for each canonical field independently, the
 * first header that CONTAINED one of that field's aliases anywhere in its text.
 * Three silent corruptions followed:
 *
 *   `VAT Reg No` contains "vat"   → a tax registration became a VAT amount.
 *   `Total Due`  contains "due"   → an invoice total became a due DATE.
 *   `Subtotal`   contains "total" → the gross total bound to the NET figure.
 *
 * These tests pin the general rules that close all three (whole-token matching,
 * semantic field classes evaluated on residual tokens, one column per field),
 * and — just as importantly — pin the matches that must keep working, since a
 * matcher that refuses everything would also pass a test that only checks the
 * bugs are gone.
 */

const detectFor = (csv: string) => {
  const sheet = parseCsvFile(csv);
  const d = detectEntityType(sheet);
  return { d, row: mapRow(d, sheet.rows[0]!) };
};

// ===========================================================================
// Normalisation — machine-generated headers
// ===========================================================================

describe("normalisation: separators a machine puts in a header", () => {
  it("treats underscores, hyphens and dots as word breaks", () => {
    expect(normaliseHeader("customer_name")).toBe("customer name");
    expect(normaliseHeader("invoice-number")).toBe("invoice number");
    expect(normaliseHeader("Due.Date")).toBe("due date");
    expect(normaliseHeader("  Total   Due  ")).toBe("total due");
  });

  it("keeps currency symbols and % as tokens of their own", () => {
    // They are the strongest single hint about what kind of column this is,
    // so they must survive normalisation rather than being stripped.
    expect(headerTokens("Amount£")).toEqual(["amount", "£"]);
    expect(headerTokens("VAT %")).toEqual(["vat", "%"]);
  });

  it("maps snake_case and kebab-case invoice sheets end to end", () => {
    // Defect E: a database or code-generated export uses `invoice_number`, not
    // "Invoice Number". None of these columns matched before.
    for (const sep of ["_", "-"]) {
      const { row } = detectFor(
        `invoice${sep}number,customer${sep}name,net,vat${sep}amount,total,due${sep}date\n` +
          `INV-1,Acme,100,20,120,2024-06-01`,
      );
      expect(row.mapped).toMatchObject({
        number: "INV-1",
        customer_name: "Acme",
        amount: 100,
        vat_total: 20,
        total: 120,
        due_date: "2024-06-01",
      });
    }
  });
});

// ===========================================================================
// Defect E/F/G — the two collisions that had to be closed
// ===========================================================================

describe("a VAT registration number is NEVER a VAT amount", () => {
  // Defect: `VAT Reg No` contains "vat", so a company's tax ID (a string like
  // "GB123456789") was read as reclaimable VAT.
  const regHeaders = [
    "VAT Reg No",
    "VAT Reg",
    "VAT Number",
    "VAT No",
    "VAT Registration",
    "VAT Registration Number",
    "Tax ID",
    "Tax Reference",
    "Company Reg No",
  ];

  for (const header of regHeaders) {
    it(`refuses "${header}" as the VAT amount`, () => {
      const { d, row } = detectFor(
        `Date,Description,Amount,${header},Category\n2024-03-15,Cable,100,GB123456789,materials`,
      );
      expect(d.entity_type).toBe("cost");
      expect(d.column_map.vat_total).toBeUndefined();
      expect(row.mapped.vat_total).toBeUndefined();
      // The rest of the sheet still maps — this is a refusal, not a bail-out.
      expect(row.mapped.amount).toBe(100);
    });
  }

  it("still reads a bare VAT column as the amount", () => {
    // The protection must not cost the convention it exists to protect.
    const { row } = detectFor(
      "Date,Description,Net,VAT,Category\n2024-03-15,Cable,100,20,materials",
    );
    expect(row.mapped.vat_total).toBe(20);
  });

  it("reads an explicit VAT Rate column as a rate, not as an amount", () => {
    const { d, row } = detectFor(
      "Date,Description,Amount,VAT Rate,Category\n2024-03-15,Cable,100,20,materials",
    );
    expect(d.column_map.vat_rate).toBe("VAT Rate");
    // A rate is not money, and one column cannot be both.
    expect(d.column_map.vat_total).toBeUndefined();
    expect(row.mapped.vat_rate).toBe(20);
  });
});

describe("a money column is NEVER a date", () => {
  // Defect: `Total Due` contains "due", so an invoice's gross figure was ALSO
  // written to `due_date` — 1250.00 read as an Excel serial date.
  it("maps Total Due to the total and leaves due_date unset", () => {
    const { d, row } = detectFor(
      "Invoice Number,Customer,Subtotal,VAT,Total Due\nINV-1,Acme,100,20,120",
    );
    expect(d.entity_type).toBe("invoice");
    expect(d.column_map.total).toBe("Total Due");
    expect(d.column_map.due_date).toBeUndefined();
    expect(row.mapped.total).toBe(120);
    expect(row.mapped.due_date).toBeUndefined();
  });

  for (const header of ["Amount Due", "Balance Due", "Total Outstanding"]) {
    it(`never reads "${header}" as due_date`, () => {
      const { d } = detectFor(
        `Invoice Number,Customer,Net,VAT,Total,${header}\nINV-1,Acme,100,20,120,120`,
      );
      expect(d.column_map.due_date).toBeUndefined();
    });
  }

  it("still maps a real Due Date column", () => {
    const { row } = detectFor(
      "Invoice Number,Customer,Net,VAT,Total,Due Date\nINV-1,Acme,100,20,120,2024-06-01",
    );
    expect(row.mapped.due_date).toBe("2024-06-01");
  });

  it("maps Total Due and Due Date side by side without confusing them", () => {
    const { row } = detectFor(
      "Invoice Number,Customer,Net,VAT,Total Due,Due Date\nINV-1,Acme,100,20,120,2024-06-01",
    );
    expect(row.mapped.total).toBe(120);
    expect(row.mapped.due_date).toBe("2024-06-01");
  });
});

describe("whole-token matching: Subtotal is not a Total", () => {
  // Defect: "total" was substring-matched inside "subtotal", so on the most
  // common invoice layout of all — net / VAT / gross — the `total` field bound
  // to the SUBTOTAL and every invoice imported VAT-exclusive.
  it("binds amount to Subtotal and total to Total", () => {
    const { d, row } = detectFor(
      "Invoice Number,Customer,Subtotal,VAT,Total\nINV-1,Acme,100,20,120",
    );
    expect(d.column_map.amount).toBe("Subtotal");
    expect(d.column_map.total).toBe("Total");
    expect(row.mapped.amount).toBe(100);
    expect(row.mapped.total).toBe(120);
  });

  it("does not match an alias that only appears inside a longer word", () => {
    const { perField } = matchColumns(["Subtotal"], { total: ["total"] });
    expect(perField.total).toBe(0);
  });
});

// ===========================================================================
// The general rule, stated directly
// ===========================================================================

describe("class protection is evaluated on the tokens OUTSIDE the alias", () => {
  it("allows an alias to contain the very word its class forbids", () => {
    // "rate" marks a percentage and money is protected from it — but "hourly
    // rate" is the alias asking for that word, so the match must stand.
    // Without the residual rule, staff pay would stop importing.
    const { perField, map } = matchColumns(["Hourly Rate (£)"], {
      hourly_pay: ["hourly rate", "rate"],
    });
    expect(perField.hourly_pay).toBeGreaterThan(0);
    expect(map.hourly_pay).toBe("Hourly Rate (£)");
  });

  it("refuses when the contradicting word is genuinely extra", () => {
    // "rate" is inside the alias here too, but "%" is not — and a percentage
    // column is not a wage.
    const { perField } = matchColumns(["Rate %"], { hourly_pay: ["rate"] });
    expect(perField.hourly_pay).toBe(0);
  });

  it("keeps Day Rate importable as pay", () => {
    const { row } = detectFor(
      "Full Name,Email,Day Rate,Start Date\nJane,j@x.com,150,2024-01-01",
    );
    expect(row.mapped.hourly_pay).toBe(150);
  });

  it("does not let an identifier word block a contact column", () => {
    // `Mobile Number` and `Contact Number` are phones. "number" next to a
    // contact word means a phone number, so email/phone are deliberately not
    // protected from identifier words.
    const { row } = detectFor(
      "Full Name,E-Mail Address,Mobile Number\nJane,j@x.com,07000000000",
    );
    expect(row.mapped.email).toBe("j@x.com");
    expect(row.mapped.phone).toBe("07000000000");
  });

  it("refuses Payment Terms as a payment amount", () => {
    const { d } = detectFor(
      "Invoice No,Amount,Payment Date,Payment Terms\nINV-1,100,2024-01-01,30 days",
    );
    expect(d.column_map.amount).toBe("Amount");
    expect(d.column_map.paid_at).toBe("Payment Date");
  });
});

describe("one column belongs to at most one field", () => {
  it("does not let two fields claim the same header", () => {
    const { map, idxMap } = matchColumns(["Total Due"], {
      total: ["total"],
      due_date: ["due"],
    });
    const claimed = Object.values(idxMap);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(map.total).toBe("Total Due");
    expect(map.due_date).toBeUndefined();
  });

  it("settles every exact match before any loose one", () => {
    // "Date" exactly names created_at, so a loose "due" match must not be able
    // to take it first.
    const { map } = matchColumns(["Date", "Due Date"], {
      due_date: ["due date", "due"],
      created_at: ["date"],
    });
    expect(map.created_at).toBe("Date");
    expect(map.due_date).toBe("Due Date");
  });
});

// ===========================================================================
// OCR-shaped and ambiguous headers
// ===========================================================================

describe("OCR-shaped headers", () => {
  it("recovers a letter-spaced heading", () => {
    // A scanned invoice routinely comes back with "V A T" or "T O T A L".
    const { row } = detectFor(
      "Date,Description,Net,V A T,Category\n2024-03-15,Cable,100,20,materials",
    );
    expect(row.mapped.vat_total).toBe(20);
  });

  it("survives stray punctuation and trailing colons", () => {
    const { row } = detectFor(
      "Invoice Number:,Customer:,Net:,VAT:,Total:\nINV-1,Acme,100,20,120",
    );
    expect(row.mapped).toMatchObject({ number: "INV-1", amount: 100, total: 120 });
  });

  it("does not glue letters in an ordinary header", () => {
    // The repair applies only to runs of single letters; nothing else changes.
    expect(normaliseHeader("Due Date")).toBe("due date");
  });
});

describe("ambiguous headers resolve toward the more specific field", () => {
  it("prefers the longer alias phrase when both could match", () => {
    const { map } = matchColumns(["Invoice Date"], {
      created_at: ["invoice date", "date"],
      due_date: ["due date"],
    });
    expect(map.created_at).toBe("Invoice Date");
  });

  it("keeps the invoice date and the due date apart", () => {
    const { row } = detectFor(
      "Invoice Number,Invoice Date,Due Date,Net,VAT,Total\nINV-1,2024-05-09,2024-06-08,100,20,120",
    );
    expect(row.mapped.created_at).toBe("2024-05-09");
    expect(row.mapped.due_date).toBe("2024-06-08");
  });
});

// ===========================================================================
// Defect I — the customer/staff regression guard must survive all of this
// ===========================================================================

describe("REGRESSION GUARD: a customer list is never filed as staff", () => {
  // A customer list misclassified as staff surfaces the staff-invite flow,
  // which emails CUSTOMERS a staff magic-link into the org. The matcher rewrite
  // touches exactly the scoring these classifications rest on, so the guard is
  // re-proved here rather than assumed.
  it("classifies a plain name/email/phone sheet as customer", () => {
    const { d } = detectFor("Name,Email,Phone\nJane,j@x.com,07000000000");
    expect(d.entity_type).toBe("customer");
  });

  it("classifies a full-name contact sheet as customer, not staff", () => {
    const { d } = detectFor("Full Name,Email,Phone\nJane,j@x.com,07000000000");
    expect(d.entity_type).toBe("customer");
  });

  it("leans to customer AND forces review on a soft-only staff signal", () => {
    // "Role" appears on plenty of CRM exports, so it is not enough to file
    // people as staff on its own.
    for (const soft of ["Role", "Position", "Job Title"]) {
      const { d } = detectFor(`Name,Email,Phone,${soft}\nJane,j@x.com,07000000000,Manager`);
      expect(d.entity_type).toBe("customer");
      expect(d.review_required).toBe(true);
    }
  });

  it("still detects a real staff roster on a strong payroll signal", () => {
    for (const strong of ["Hourly Rate", "Wage", "Employment Type", "Start Date"]) {
      const { d } = detectFor(`Full Name,Email,Phone,${strong}\nJane,j@x.com,07000000000,15`);
      expect(d.entity_type).toBe("staff");
      expect(d.review_required).toBeFalsy();
    }
  });

  it("maps a staff roster's payroll columns through", () => {
    const { row } = detectFor(
      "Full Name,Email,Phone,Hourly Rate,Employment Type,Start Date\n" +
        "Jane,j@x.com,07000000000,15.50,self employed,2024-01-08",
    );
    expect(row.mapped).toMatchObject({
      full_name: "Jane",
      email: "j@x.com",
      hourly_pay: 15.5,
      employment_type: "self_employed",
      start_date: "2024-01-08",
    });
  });

  it("separates a customer sheet and a staff sheet in the same workbook", () => {
    // Mixed files must still split: each sheet is classified on its own headers.
    const customers = detectFor("Name,Email,Phone\nJane,j@x.com,07000000000");
    const staff = detectFor("Full Name,Email,Hourly Rate\nSam,s@x.com,18");
    expect(customers.d.entity_type).toBe("customer");
    expect(staff.d.entity_type).toBe("staff");
  });
});
