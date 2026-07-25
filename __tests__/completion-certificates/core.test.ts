import { describe, it, expect } from "vitest";
import {
  canTransitionCert,
  isCertEditable,
  isCertIssued,
  certContentSchema,
} from "@/lib/completion-certificates/schema";
import {
  buildCertificateSnapshot,
  addMonthsIso,
  CERTIFICATE_SNAPSHOT_KEYS,
} from "@/lib/completion-certificates/snapshot";

describe("certificate state machine", () => {
  it("allows draft→issued→superseded→archived, nothing backwards", () => {
    expect(canTransitionCert("draft", "issued")).toBe(true);
    expect(canTransitionCert("issued", "superseded")).toBe(true);
    expect(canTransitionCert("issued", "archived")).toBe(true);
    expect(canTransitionCert("superseded", "archived")).toBe(true);
    expect(canTransitionCert("issued", "draft")).toBe(false);
    expect(canTransitionCert("archived", "issued")).toBe(false);
  });
  it("only a draft is editable; issued+ are 'issued'", () => {
    expect(isCertEditable("draft")).toBe(true);
    expect(isCertEditable("issued")).toBe(false);
    expect(isCertIssued("issued")).toBe(true);
    expect(isCertIssued("draft")).toBe(false);
  });
});

describe("certContentSchema", () => {
  it("requires a completion date + works description", () => {
    expect(certContentSchema.safeParse({ completion_date: "2026-07-01", works_description: "Full rewire" }).success).toBe(true);
    expect(certContentSchema.safeParse({ completion_date: "nope", works_description: "x" }).success).toBe(false);
    expect(certContentSchema.safeParse({ completion_date: "2026-07-01", works_description: "" }).success).toBe(false);
  });
  it("bounds the defects period 0–120 months", () => {
    expect(certContentSchema.safeParse({ completion_date: "2026-07-01", works_description: "x", defects_liability_months: 200 }).success).toBe(false);
    expect(certContentSchema.safeParse({ completion_date: "2026-07-01", works_description: "x", defects_liability_months: 12 }).success).toBe(true);
  });
});

describe("addMonthsIso", () => {
  it("adds months, clamping to month end", () => {
    expect(addMonthsIso("2026-07-01", 12)).toBe("2027-07-01");
    expect(addMonthsIso("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("buildCertificateSnapshot — customer-safe by construction", () => {
  const snap = buildCertificateSnapshot({
    certificateNumber: "CERT-0001",
    content: {
      completion_date: "2026-07-01",
      works_description: "Complete electrical installation to BS 7671",
      defects_liability_months: 12,
      retention_note: "5% retention, half released at PC",
      handover_notes: "Certificates issued; keys handed over",
      statement: undefined,
      signatory_name: "A. Foreman",
    },
    contractorName: "Sparks Ltd",
    customerName: "Mrs Jones",
    jobReference: "JOB-42",
    siteAddress: "1 High St, Belfast",
    issuedByName: "A. Foreman",
    issuedOn: "2026-07-22",
  });

  it("derives the defects-liability end date", () => {
    expect(snap.defects_liability_end).toBe("2027-07-01");
  });
  it("freezes the two parties + the works", () => {
    expect(snap.contractor_name).toBe("Sparks Ltd");
    expect(snap.customer_name).toBe("Mrs Jones");
    expect(snap.works_description).toContain("BS 7671");
  });
  it("contains EXACTLY the customer-safe key set — no internal fields can leak", () => {
    expect(Object.keys(snap).sort()).toEqual([...CERTIFICATE_SNAPSHOT_KEYS].sort());
    // explicit paranoia: none of these ever appear in a published snapshot
    const json = JSON.stringify(snap).toLowerCase();
    for (const forbidden of ["cost", "margin", "profit", "supplier", "email", "retention_percent", "internal"]) {
      expect(json).not.toContain(forbidden);
    }
  });
});
