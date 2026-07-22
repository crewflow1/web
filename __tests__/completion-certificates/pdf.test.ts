import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { CompletionCertificatePdf } from "@/lib/pdf/completion-certificate-pdf";
import type { CertificateSnapshot } from "@/lib/completion-certificates/snapshot";

/**
 * Render the completion-certificate component to a real PDF buffer (server-side,
 * exactly as the routes do) and assert a well-formed, non-trivial document —
 * proves the template compiles + renders across its sections. Called as a plain
 * function (no JSX) so the test stays a .test.ts the unit config picks up.
 */
const snapshot: CertificateSnapshot = {
  certificate_number: "CERT-0001",
  completion_date: "2026-07-01",
  defects_liability_months: 12,
  defects_liability_end: "2027-07-01",
  works_description: "Complete electrical installation to BS 7671.",
  retention_note: "5% retention, half released at practical completion.",
  handover_notes: "Test certificates issued; keys handed over.",
  statement: null,
  contractor_name: "Sparks Ltd",
  customer_name: "Mrs Jones",
  job_reference: "abcd1234",
  site_address: "1 High Street, Belfast, BT1 1AA",
  signatory_name: "A. Foreman",
  issued_on: "2026-07-22",
};

describe("CompletionCertificatePdf", () => {
  it("renders a real PDF from a frozen snapshot", async () => {
    const buf = await renderToBuffer(
      CompletionCertificatePdf({ c: { orgName: "Sparks Ltd", orgBlockLines: ["1 Depot Rd", "Belfast BT2 2BB"], logoUrl: null, snapshot, isDraft: false } }),
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a draft preview too", async () => {
    const buf = await renderToBuffer(
      CompletionCertificatePdf({ c: { orgName: "Sparks Ltd", orgBlockLines: [], logoUrl: null, snapshot, isDraft: true } }),
    );
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
