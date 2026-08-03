import { describe, it, expect } from "vitest";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
  isSensitiveColumn,
  redactRow,
  REDACTED_PLACEHOLDER,
  SENSITIVE_COLUMN_RX,
} from "@/lib/gdpr/export-tables";

/**
 * GDPR export registry — pure unit contracts (no DB).
 *
 * These pin the deterministic table-set algebra and the column redactor that
 * together guarantee: an export names exactly the classified business tables,
 * never a credential store, and never a secret-named column.
 */

describe("GDPR export table registry", () => {
  it("ORG_EXPORT_TABLES = KNOWN minus EXCLUDED (no overlap, full cover)", () => {
    const known = new Set<string>(KNOWN_ORG_SCOPED_TABLES);
    const excluded = new Set<string>(Object.keys(EXCLUDED_FROM_EXPORT));

    // Every excluded table is a real known org table (no dead deny-list entries).
    for (const t of excluded) expect(known.has(t)).toBe(true);

    // The exported set is exactly KNOWN \ EXCLUDED.
    const expected = [...known].filter((t) => !excluded.has(t)).sort();
    expect([...ORG_EXPORT_TABLES]).toEqual(expected);

    // Partition is exact: EXPORT ∪ EXCLUDED === KNOWN, and they never overlap.
    for (const t of ORG_EXPORT_TABLES) expect(excluded.has(t)).toBe(false);
    expect(ORG_EXPORT_TABLES.length + excluded.size).toBe(known.size);
  });

  it("is deterministic: ORG_EXPORT_TABLES is sorted and unique", () => {
    const arr = [...ORG_EXPORT_TABLES];
    expect(arr).toEqual([...arr].sort());
    expect(new Set(arr).size).toBe(arr.length);
  });

  it("never exports a credential / token / connection store", () => {
    for (const t of [
      "accounting_connections",
      "bank_connections",
      "calendar_connections",
      "hmrc_connections",
      "api_keys",
      "phone_numbers",
      "webhook_endpoints",
      "asset_qr_identities",
    ]) {
      expect(ORG_EXPORT_TABLES).not.toContain(t);
      expect(EXCLUDED_FROM_EXPORT[t]).toBeTruthy();
    }
  });

  it("never bulk-exports government identifiers (staff_secrets)", () => {
    expect(ORG_EXPORT_TABLES).not.toContain("staff_secrets");
    expect(EXCLUDED_FROM_EXPORT.staff_secrets).toMatch(/NI number|government/i);
  });

  it("DOES export the core tenant business tables", () => {
    for (const t of [
      "customers",
      "jobs",
      "quotes",
      "invoices",
      "finances",
      "leads",
      "suppliers",
    ]) {
      expect(ORG_EXPORT_TABLES).toContain(t);
    }
  });
});

describe("column redaction", () => {
  it("flags secret / credential / government-id column names", () => {
    for (const c of [
      "portal_token",
      "public_token",
      "access_token",
      "refresh_token",
      "token",
      "key_hash",
      "client_secret",
      "provider_auth_secret",
      "password",
      "ni_number",
      "webhook_secret",
    ]) {
      expect(isSensitiveColumn(c), c).toBe(true);
      expect(SENSITIVE_COLUMN_RX.test(c), c).toBe(true);
    }
  });

  it("does NOT flag benign business columns", () => {
    for (const c of [
      "id",
      "org_id",
      "name",
      "email",
      "amount",
      "status",
      "notes",
      "created_at",
      "customer_id",
      "content_hash", // integrity metadata, not a secret
    ]) {
      expect(isSensitiveColumn(c), c).toBe(false);
    }
  });

  it("redactRow strips only sensitive keys, keeps the rest, and is pure", () => {
    const row = {
      id: "r1",
      org_id: "o1",
      name: "Acme",
      portal_token: "SECRET-abc",
      public_token: "SECRET-def",
      amount: 100,
    };
    const out = redactRow(row);
    expect(out).toEqual({ id: "r1", org_id: "o1", name: "Acme", amount: 100 });
    expect("portal_token" in out).toBe(false);
    expect("public_token" in out).toBe(false);
    // Purity: original untouched.
    expect(row.portal_token).toBe("SECRET-abc");
  });

  // FIX 1 — third-party government tax identifiers (subcontractor UTR / verify
  // ref) must be redacted, but the ORG'S OWN UTR (`contractor_utr`) must NOT be.
  it("redacts a subcontractor's own UTR + verification_reference (exact-name)", () => {
    for (const c of ["utr", "verification_reference"]) {
      expect(isSensitiveColumn(c), c).toBe(true);
      expect(SENSITIVE_COLUMN_RX.test(c), c).toBe(true);
    }
    // cis_subcontractors row shape: raw utr + verification_reference dropped.
    const sub = redactRow({
      id: "s1",
      org_id: "o1",
      legal_name: "Bob the Builder Ltd",
      utr: "1234567890",
      verification_reference: "V0001234567",
      cis_status: "verified",
    });
    expect("utr" in sub).toBe(false);
    expect("verification_reference" in sub).toBe(false);
    expect(sub).toEqual({
      id: "s1",
      org_id: "o1",
      legal_name: "Bob the Builder Ltd",
      cis_status: "verified",
    });
  });

  it("does NOT redact the ORG'S OWN contractor_utr, nor already-masked UTRs", () => {
    // contractor_utr (cis_contractor_profiles) is the org's own, legitimately
    // exportable identifier; the *_utr_masked columns are already masked.
    for (const c of ["contractor_utr", "subcontractor_utr_masked", "utr_masked"]) {
      expect(isSensitiveColumn(c), c).toBe(false);
    }
    const profile = redactRow({
      id: "p1",
      org_id: "o1",
      contractor_utr: "9876543210",
      subcontractor_utr_masked: "*****3210",
    });
    expect(profile).toEqual({
      id: "p1",
      org_id: "o1",
      contractor_utr: "9876543210",
      subcontractor_utr_masked: "*****3210",
    });
  });

  // FIX 2 — jsonb-nested secrets must not bypass column redaction.
  it("recursively redacts a nested secret-named key, keeping siblings", () => {
    const row = {
      id: "e1",
      org_id: "o1",
      // e.g. hmrc_submissions.payload / call_events.payload / *.metadata
      payload: {
        method: "POST",
        access_token: "SHOULD-NOT-LEAK",
        headers: { authorization_secret: "ALSO-SECRET", trace_id: "keep-me" },
        items: [
          { sku: "A1", refresh_token: "NESTED-IN-ARRAY" },
          { sku: "B2", qty: 3 },
        ],
      },
    };
    const out = redactRow(row) as typeof row;
    const [item0, item1] = out.payload.items;
    // Structure + non-secret siblings preserved.
    expect(out.payload.method).toBe("POST");
    expect(out.payload.headers.trace_id).toBe("keep-me");
    expect(item1).toEqual({ sku: "B2", qty: 3 });
    expect(item0?.sku).toBe("A1");
    // Every nested secret redacted in place (value replaced, structure kept).
    expect(out.payload.access_token).toBe(REDACTED_PLACEHOLDER);
    expect(out.payload.headers.authorization_secret).toBe(REDACTED_PLACEHOLDER);
    expect(item0?.refresh_token).toBe(REDACTED_PLACEHOLDER);
    // Purity: original untouched.
    expect(row.payload.access_token).toBe("SHOULD-NOT-LEAK");
  });

  it("recursive redaction is bounded and cycle-safe", () => {
    type Cyclic = { org_id: string; meta: Record<string, unknown> };
    const row: Cyclic = { org_id: "o1", meta: { a: 1 } };
    // Introduce a reference cycle in nested jsonb-like data.
    (row.meta as Record<string, unknown>).self = row.meta;
    expect(() => redactRow(row)).not.toThrow();
    const out = redactRow(row) as Cyclic;
    expect(out.org_id).toBe("o1");
    expect((out.meta as Record<string, unknown>).a).toBe(1);
  });
});
