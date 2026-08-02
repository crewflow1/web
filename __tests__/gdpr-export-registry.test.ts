import { describe, it, expect } from "vitest";
import {
  KNOWN_ORG_SCOPED_TABLES,
  EXCLUDED_FROM_EXPORT,
  ORG_EXPORT_TABLES,
  isSensitiveColumn,
  redactRow,
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
});
