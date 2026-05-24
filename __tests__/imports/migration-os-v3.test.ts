import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectEntityType, mapRow } from "@/lib/imports/detect";

/**
 * Migration OS v3 — expansion to 9 categories per CEO directive.
 *
 * v2 (existing): customer / invoice / lead / staff / cost / supplier
 * v3 adds:        job / quote / payment
 *
 * Payroll + tax stay roadmap until their destination tables grow
 * import-friendly columns; flagged in the final report.
 *
 * These tests run the detection + mapping pipeline against synthetic
 * sheets and pin:
 *   - new entity types are detected when the discriminator signal is
 *     present in headers,
 *   - they're NOT detected when the signal is missing (no clash with
 *     customer / invoice / cost),
 *   - mapRow normalises money / dates / status enums,
 *   - the actions.ts plumbing (insertOne, tableFor, ORDER) knows the
 *     new entity types,
 *   - the UI surface (RowSummary, post-commit imported/flagged
 *     counters) lists the new types.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const DETECT_SRC = read("lib/imports/detect.ts");
const ACTIONS_SRC = read("app/(app)/imports/actions.ts");
const PAGE_SRC = read("app/(app)/imports/[id]/page.tsx");

function makeSheet(headers: string[], rows: (string | number | null)[][]) {
  return {
    name: "test",
    header: headers,
    rows,
  };
}

// =====================================================================
// 1. EntityType + ENTITY_FIELDS + REQUIRED_FIELDS catalogues are extended
// =====================================================================

describe("entity-type catalogue v3", () => {
  it("EntityType union includes job | quote | payment", () => {
    expect(DETECT_SRC).toMatch(/\| "job"/);
    expect(DETECT_SRC).toMatch(/\| "quote"/);
    expect(DETECT_SRC).toMatch(/\| "payment"/);
  });

  it("ENTITY_FIELDS has aliases for each new type", () => {
    expect(DETECT_SRC).toMatch(/JOB_FIELDS/);
    expect(DETECT_SRC).toMatch(/QUOTE_FIELDS/);
    expect(DETECT_SRC).toMatch(/PAYMENT_FIELDS/);
  });

  it("REQUIRED_FIELDS pins parent-resolution keys", () => {
    // Jobs need a customer; quotes need both id + customer; payments
    // need an invoice ref + amount.
    expect(DETECT_SRC).toMatch(/job: \["customer_name"\]/);
    expect(DETECT_SRC).toMatch(/quote: \["number", "customer_name"\]/);
    expect(DETECT_SRC).toMatch(/payment: \["invoice_number", "amount"\]/);
  });
});

// =====================================================================
// 2. Detection — discriminator signals
// =====================================================================

describe("detection v3 — discriminators", () => {
  it("detects a JOB sheet when 'job' / 'scheduled' / 'assigned' header is present", () => {
    const sheet = makeSheet(
      ["Customer", "Job Title", "Status", "Scheduled date", "Notes"],
      [["Acme Ltd", "Fix roof", "in-progress", "2026-01-10", "third storey"]],
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("job");
    expect(d.confidence).toBeGreaterThan(0);
  });

  it("a customer sheet without a job signal does NOT mis-detect as job", () => {
    const sheet = makeSheet(
      ["Customer Name", "Email", "Phone", "Address"],
      [["Sam", "sam@x.co", "+447111", "1 High St"]],
    );
    const d = detectEntityType(sheet);
    // Could be customer OR staff (overlap on name+email+phone) — what
    // we're pinning is "NOT job" since there's no job/scheduled/assigned
    // signal in the headers.
    expect(d.entity_type).not.toBe("job");
  });

  it("detects a QUOTE sheet when 'quote' / 'valid until' header is present", () => {
    const sheet = makeSheet(
      ["Quote Number", "Customer", "Total", "Status", "Valid until"],
      [["Q-1001", "Acme Ltd", "1200", "sent", "2026-02-01"]],
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("quote");
  });

  it("an invoice sheet without a quote signal does NOT mis-detect as quote", () => {
    const sheet = makeSheet(
      ["Invoice Number", "Total", "Status"],
      [["INV-1", "500", "sent"]],
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("invoice");
  });

  it("detects a PAYMENT sheet when 'payment' / 'paid' header is present", () => {
    const sheet = makeSheet(
      ["Invoice Number", "Amount", "Paid Date", "Payment Method"],
      [["INV-1", "500", "2026-01-15", "BACS"]],
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("payment");
  });

  it("an invoice sheet without payment signal stays as invoice", () => {
    const sheet = makeSheet(
      ["Invoice Number", "Total", "Due Date"],
      [["INV-1", "500", "2026-01-15"]],
    );
    const d = detectEntityType(sheet);
    expect(d.entity_type).toBe("invoice");
  });
});

// =====================================================================
// 3. mapRow normalises new fields
// =====================================================================

describe("mapRow v3 — value normalisation", () => {
  it("job: status enum normalises into the schema's check constraint", () => {
    const sheet = makeSheet(
      ["Customer", "Job", "Status", "Scheduled"],
      [["Acme", "Roof", "WIP", "2026-01-10"]],
    );
    const d = detectEntityType(sheet);
    const m = mapRow(d, sheet.rows[0]!);
    expect(m.entity_type).toBe("job");
    // "WIP" should normalise to "in-progress" (matches jobs.status check).
    expect(m.mapped.status).toBe("in-progress");
  });

  it("job: scheduled_date parses common formats", () => {
    const sheet = makeSheet(
      ["Customer", "Job", "Scheduled"],
      [["Acme", "Roof", "10/01/2026"]],
    );
    const d = detectEntityType(sheet);
    const m = mapRow(d, sheet.rows[0]!);
    // DD/MM/YYYY → ISO yyyy-mm-dd.
    expect(m.mapped.scheduled_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("quote: total parses money strings", () => {
    const sheet = makeSheet(
      ["Quote Number", "Customer", "Total", "Valid Until"],
      [["Q-1", "Acme", "£1,250.50", "2026-02-01"]],
    );
    const d = detectEntityType(sheet);
    const m = mapRow(d, sheet.rows[0]!);
    expect(m.entity_type).toBe("quote");
    expect(m.mapped.total).toBe(1250.5);
  });

  it("quote: status normalises won/lost into accepted/declined", () => {
    const sheet = makeSheet(
      ["Quote Number", "Customer", "Total", "Status", "Valid Until"],
      [["Q-1", "Acme", "100", "won", "2026-02-01"]],
    );
    const d = detectEntityType(sheet);
    const m = mapRow(d, sheet.rows[0]!);
    expect(m.mapped.status).toBe("accepted");
  });

  it("payment: amount parses money strings, paid_at parses dates", () => {
    const sheet = makeSheet(
      ["Invoice Number", "Amount", "Paid Date", "Payment Method"],
      [["INV-1", "$500.00", "2026-01-15", "BACS"]],
    );
    const d = detectEntityType(sheet);
    const m = mapRow(d, sheet.rows[0]!);
    expect(m.mapped.amount).toBe(500);
    expect(m.mapped.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.mapped.payment_method).toBe("BACS");
  });
});

// =====================================================================
// 4. insertOne / tableFor / ORDER wired in actions.ts
// =====================================================================

describe("actions.ts wiring v3", () => {
  it("tableFor() returns the right destination tables", () => {
    expect(ACTIONS_SRC).toMatch(/case "job":\s*return "jobs"/);
    expect(ACTIONS_SRC).toMatch(/case "quote":\s*return "quotes"/);
    expect(ACTIONS_SRC).toMatch(
      /case "payment":\s*return "invoice_payments"/,
    );
  });

  it("insertOne handles each new entity", () => {
    expect(ACTIONS_SRC).toMatch(/case "job": \{/);
    expect(ACTIONS_SRC).toMatch(/case "quote": \{/);
    expect(ACTIONS_SRC).toMatch(/case "payment": \{/);
  });

  it("jobs + quotes resolve customer_name → customer_id", () => {
    expect(ACTIONS_SRC).toMatch(/resolveCustomerByName/);
  });

  it("payments resolve invoice_number → invoice_id", () => {
    expect(ACTIONS_SRC).toMatch(/resolveInvoiceByNumber/);
  });

  it("parent-resolution returns null on miss — never throws (partial success)", () => {
    // The directive's "AI flags issues but does not stop migration"
    // rule. A null return marks the row 'skipped'; throws would bail
    // the loop.
    expect(ACTIONS_SRC).toMatch(
      /async function resolveCustomerByName[\s\S]*\.maybeSingle\(\)/,
    );
    expect(ACTIONS_SRC).toMatch(
      /async function resolveInvoiceByNumber[\s\S]*\.maybeSingle\(\)/,
    );
  });

  it("commit ORDER inserts new types after their parents", () => {
    // Customers + invoices must land before children that FK into them.
    // The string match below confirms the rank ordering at a glance.
    const orderBlock =
      ACTIONS_SRC.match(/const ORDER: EntityType\[\] = \[[^\]]+\]/)?.[0] ?? "";
    const customerIdx = orderBlock.indexOf('"customer"');
    const invoiceIdx = orderBlock.indexOf('"invoice"');
    const jobIdx = orderBlock.indexOf('"job"');
    const quoteIdx = orderBlock.indexOf('"quote"');
    const paymentIdx = orderBlock.indexOf('"payment"');
    expect(customerIdx).toBeGreaterThan(-1);
    expect(invoiceIdx).toBeGreaterThan(customerIdx);
    expect(jobIdx).toBeGreaterThan(customerIdx);
    expect(quoteIdx).toBeGreaterThan(customerIdx);
    expect(paymentIdx).toBeGreaterThan(invoiceIdx);
  });

  it("rollback REVERSE_ORDER deletes children first (FKs respected)", () => {
    const block =
      ACTIONS_SRC.match(/const REVERSE_ORDER = \[[^\]]+\]/)?.[0] ?? "";
    const paymentsIdx = block.indexOf("invoice_payments");
    const jobsIdx = block.indexOf("jobs");
    const quotesIdx = block.indexOf("quotes");
    const invoicesIdx = block.indexOf("invoices");
    const customersIdx = block.indexOf("customers");
    expect(paymentsIdx).toBeGreaterThan(-1);
    expect(paymentsIdx).toBeLessThan(invoicesIdx);
    expect(jobsIdx).toBeLessThan(customersIdx);
    expect(quotesIdx).toBeLessThan(customersIdx);
  });
});

// =====================================================================
// 5. /imports/[id] UI surfaces the new types + flagged counter
// =====================================================================

describe("/imports/[id] UI v3", () => {
  it("RowSummary knows which fields to show for job / quote / payment", () => {
    expect(PAGE_SRC).toMatch(/job: \["customer_name", "status", "scheduled_date"\]/);
    expect(PAGE_SRC).toMatch(/quote: \["number", "customer_name", "total"\]/);
    expect(PAGE_SRC).toMatch(/payment: \["invoice_number", "amount", "paid_at"\]/);
  });

  it("post-commit summary renders imported + flagged counters", () => {
    // Matches the CEO directive's "Jobs: 98 imported, 2 flagged" format.
    expect(PAGE_SRC).toMatch(/imported: 0/);
    expect(PAGE_SRC).toMatch(/flagged: 0/);
    expect(PAGE_SRC).toMatch(/text-emerald-700/);
    expect(PAGE_SRC).toMatch(/text-amber-700/);
  });

  it("flagged counter includes errors, duplicates, and skipped-with-message", () => {
    expect(PAGE_SRC).toMatch(/r\.status === "duplicate"/);
    expect(PAGE_SRC).toMatch(/r\.status === "error"/);
    expect(PAGE_SRC).toMatch(/r\.status === "skipped" && r\.error_message/);
  });
});

// =====================================================================
// 6. Partial-success guarantees
// =====================================================================

describe("partial success — never blocks migration on one bad row", () => {
  it("commit loop wraps every insert in try/catch — failures mark the row, not the session", () => {
    // The existing pipeline already does this; pin the invariant so
    // future refactors keep it.
    expect(ACTIONS_SRC).toMatch(
      /for \(const r of list\) \{[\s\S]*try \{[\s\S]*\} catch/,
    );
    expect(ACTIONS_SRC).toMatch(/status: "error", error_message:/);
  });
});
