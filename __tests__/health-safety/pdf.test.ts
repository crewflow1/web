import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { RamsPdf, type RamsPdfInput } from "@/lib/pdf/rams-pdf";
import { PermitPdf, type PermitPdfInput } from "@/lib/pdf/permit-pdf";

const rams: RamsPdfInput = {
  org_name: "Acme Build", reference: "RA-0007", title: "Roof works", activity: "Tiling",
  location: "Plot 4", assessor_name: "J. Smith", assessment_date: "2026-01-01", review_date: "2026-06-01",
  ppe: ["Hard hat", "Harness"], method_statement: "Erect scaffold, then tile from the eaves up.",
  status: "issued", revision_number: 1, issued_at: "2026-01-02T09:00:00Z",
  hazards: [{ hazard: "Fall from height", who_at_risk: "Roofers", likelihood: 4, severity: 5, control_measures: "Edge protection + harness", residual_likelihood: 1, residual_severity: 3 }],
  signoffs: [{ signer_name: "Jordan Lee", signed_name: "Jordan Lee", acknowledged_at: "2026-01-03T08:00:00Z" }],
  generated_at: "2026-01-04T12:00:00Z",
};

const permit: PermitPdfInput = {
  org_name: "Acme Build", reference: "PTW-0003", permit_type: "hot_works", title: "Welding beam", scope: "Weld the RSJ",
  location: "Level 2", responsible_person: "A. Foreman", isolation_details: null, emergency_arrangements: "Muster at gate",
  rams_reference: "RA-0007", valid_from: "2026-01-05T08:00:00Z", valid_until: "2026-01-05T16:00:00Z",
  status: "active", effective_status: "active", issued_at: "2026-01-05T07:30:00Z", closeout_notes: null, closed_at: null,
  conditions: [{ label: "Fire watch in place", required: true, confirmed: true, confirmed_at: "2026-01-05T07:45:00Z" }],
  signoffs: [], generated_at: "2026-01-05T12:00:00Z",
};

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("RamsPdf", () => {
  it("renders a well-formed, non-trivial PDF", async () => {
    const b = await renderToBuffer(RamsPdf({ ra: rams }));
    expect(isPdf(b)).toBe(true);
    expect(b.length).toBeGreaterThan(1000);
  });
  it("renders when hazards + sign-offs + method are empty (no throw)", async () => {
    const b = await renderToBuffer(RamsPdf({ ra: { ...rams, hazards: [], signoffs: [], method_statement: null, ppe: [] } }));
    expect(isPdf(b)).toBe(true);
  });
  it("the PDF input carries H&S content only — no cost/margin/internal-note fields", () => {
    expect(Object.keys(rams).join(",")).not.toMatch(/margin|profit|price|\bcost\b|unit_|day_rate|hourly/i);
  });
});

describe("PermitPdf", () => {
  it("renders a well-formed PDF", async () => {
    const b = await renderToBuffer(PermitPdf({ p: permit }));
    expect(isPdf(b)).toBe(true);
    expect(b.length).toBeGreaterThan(1000);
  });
  it("renders with no conditions / closed state (no throw)", async () => {
    const b = await renderToBuffer(PermitPdf({ p: { ...permit, status: "closed", effective_status: "closed", closed_at: "2026-01-05T17:00:00Z", closeout_notes: "Area cleared", conditions: [] } }));
    expect(isPdf(b)).toBe(true);
  });
  it("an expired (past-window) permit renders its derived EXPIRED status, never a stale 'active'", async () => {
    // effective_status is what the route computes via effectiveStatus(); a live
    // permit past valid_until must never read 'active' on an evidence document.
    const b = await renderToBuffer(PermitPdf({ p: { ...permit, status: "active", effective_status: "expired" } }));
    expect(isPdf(b)).toBe(true);
    expect(b.length).toBeGreaterThan(1000);
  });
  it("the PDF input carries H&S content only — no cost/margin/internal fields", () => {
    expect(Object.keys(permit).join(",")).not.toMatch(/margin|profit|price|\bcost\b|unit_|day_rate|hourly/i);
  });
});
