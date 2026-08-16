import { describe, it, expect } from "vitest";
import { KNOWN_ORG_SCOPED_TABLES } from "@/lib/gdpr/export-tables";
import {
  ERASE_ANONYMISE,
  ERASE_RETAIN,
  ERASE_ANONYMISE_TABLES,
  ERASE_RETAIN_TABLES,
  ERASE_HARD_DELETE_TABLES,
  ERASE_STORAGE_BUCKETS,
  erasureDisposition,
} from "@/lib/gdpr/erase-tables";

/**
 * GDPR ERASURE registry — pure unit contracts (no DB).
 *
 * These pin the deterministic three-way partition (anonymise / retain /
 * hard-delete) and its statutory-retention guarantees: the partition is exact
 * and disjoint over the export census, every financial/tax/payroll record is
 * PRESERVED (anonymise/retain, never destroyed), platform-side records are
 * retained, and PII operational tables default to destruction.
 */

describe("GDPR erasure classification partition", () => {
  it("ANONYMISE ∪ RETAIN ∪ HARD_DELETE === KNOWN, with no overlap", () => {
    const known = new Set(KNOWN_ORG_SCOPED_TABLES);
    const anon = new Set(ERASE_ANONYMISE_TABLES);
    const retain = new Set(ERASE_RETAIN_TABLES);
    const del = new Set(ERASE_HARD_DELETE_TABLES);

    // Every classified table is a real known org table (no dead entries).
    for (const t of anon) expect(known.has(t), `anonymise ${t} not in KNOWN`).toBe(true);
    for (const t of retain) expect(known.has(t), `retain ${t} not in KNOWN`).toBe(true);

    // Pairwise disjoint.
    for (const t of anon) expect(retain.has(t), `${t} in anon AND retain`).toBe(false);
    for (const t of anon) expect(del.has(t), `${t} in anon AND delete`).toBe(false);
    for (const t of retain) expect(del.has(t), `${t} in retain AND delete`).toBe(false);

    // Exact cover: the three sets partition KNOWN.
    expect(anon.size + retain.size + del.size).toBe(known.size);
    const union = new Set([...anon, ...retain, ...del]);
    expect(union.size).toBe(known.size);
    for (const t of known) expect(union.has(t), `${t} unclassified`).toBe(true);
  });

  it("HARD_DELETE is the DERIVED default (KNOWN minus preserved sets), sorted", () => {
    const preserved = new Set([...ERASE_ANONYMISE_TABLES, ...ERASE_RETAIN_TABLES]);
    const expected = KNOWN_ORG_SCOPED_TABLES.filter((t) => !preserved.has(t)).sort();
    expect([...ERASE_HARD_DELETE_TABLES]).toEqual(expected);
    // Deterministic: sorted + unique.
    expect([...ERASE_HARD_DELETE_TABLES]).toEqual([...ERASE_HARD_DELETE_TABLES].sort());
    expect(new Set(ERASE_HARD_DELETE_TABLES).size).toBe(ERASE_HARD_DELETE_TABLES.length);
  });

  it("every preserved table carries a documented reason", () => {
    for (const t of ERASE_ANONYMISE_TABLES) expect(ERASE_ANONYMISE[t]?.length ?? 0).toBeGreaterThan(0);
    for (const t of ERASE_RETAIN_TABLES) expect(ERASE_RETAIN[t]?.length ?? 0).toBeGreaterThan(0);
  });

  it("erasureDisposition() agrees with the sets and defaults to hard_delete", () => {
    for (const t of ERASE_ANONYMISE_TABLES) expect(erasureDisposition(t)).toBe("anonymise");
    for (const t of ERASE_RETAIN_TABLES) expect(erasureDisposition(t)).toBe("retain");
    for (const t of ERASE_HARD_DELETE_TABLES) expect(erasureDisposition(t)).toBe("hard_delete");
    // An unknown / newly-added table defaults to destruction (the GDPR-safe
    // default for erasure — nothing personal is silently retained).
    expect(erasureDisposition("some_table_added_next_week")).toBe("hard_delete");
  });
});

describe("GDPR erasure PRESERVES statutory-retention records (never destroys them)", () => {
  // UK financial records (Companies Act 2006 s386) + HMRC 6-year duty: these
  // MUST be retained. The erasure ANONYMISES them (keeps the record, scrubs PII)
  // — it must NEVER hard-delete them.
  it("financial records are ANONYMISED, never hard-deleted", () => {
    for (const t of [
      "finances",
      "invoices",
      "invoice_line_items",
      "invoice_payments",
      "payments",
      "supplier_payments",
      "supplier_payment_allocations",
      "purchase_orders",
      "purchase_order_line_items",
      "bank_statements",
      "bank_statement_lines",
    ]) {
      expect(erasureDisposition(t), `${t} must be anonymised, not destroyed`).toBe("anonymise");
      expect(ERASE_HARD_DELETE_TABLES).not.toContain(t);
    }
  });

  it("tax / payroll / CIS / pension records are ANONYMISED, never hard-deleted", () => {
    for (const t of [
      "hmrc_submissions",
      "payroll_runs",
      "payroll_lines",
      "payroll_tax_profiles",
      "pension_enrolments",
      "holiday_entitlements",
      "cis_subcontractors",
      "cis_contractor_profiles",
      "cis_statements",
      "cis_statement_payments",
      "cis_payment_snapshots",
      "cis_monthly_returns",
      "cis_monthly_return_lines",
      "cis_bill_details",
    ]) {
      expect(erasureDisposition(t), `${t} must be anonymised, not destroyed`).toBe("anonymise");
    }
  });

  it("the accountability trails are RETAINED (erasure never erases its own audit)", () => {
    for (const t of ["gdpr_export_log", "gdpr_erasure_log"]) {
      expect(erasureDisposition(t)).toBe("retain");
      expect(ERASE_HARD_DELETE_TABLES).not.toContain(t);
    }
  });

  it("CrewFlow platform-side records are RETAINED (not the tenant's to erase)", () => {
    for (const t of ["billing_events", "billing_invoices", "org_subscriptions"]) {
      expect(erasureDisposition(t)).toBe("retain");
    }
  });
});

describe("GDPR erasure DESTROYS operational personal data", () => {
  it("customer / lead / comms / staff PII tables are hard-deleted", () => {
    for (const t of [
      "customers",
      "customer_contacts",
      "leads",
      "properties",
      "messages",
      "conversations",
      "site_visitors",
      "signatures",
      "staff_secrets",
    ]) {
      expect(erasureDisposition(t), `${t} should be hard-deleted`).toBe("hard_delete");
    }
  });

  it("credential / secret stores are hard-deleted on teardown", () => {
    for (const t of [
      "api_keys",
      "phone_numbers",
      "webhook_endpoints",
      "accounting_connections",
      "bank_connections",
      "hmrc_connections",
    ]) {
      expect(erasureDisposition(t)).toBe("hard_delete");
    }
  });
});

describe("GDPR erasure storage bucket census", () => {
  it("is deterministic (sorted, unique) and covers the tenant buckets", () => {
    expect([...ERASE_STORAGE_BUCKETS]).toEqual([...ERASE_STORAGE_BUCKETS].sort());
    expect(new Set(ERASE_STORAGE_BUCKETS).size).toBe(ERASE_STORAGE_BUCKETS.length);
    for (const b of [
      "job-photos",
      "receipts",
      "tenant-attachments",
      "compliance-docs",
      "portal-uploads",
      "signatures",
      "blueprints",
    ]) {
      expect(ERASE_STORAGE_BUCKETS).toContain(b);
    }
  });
});
