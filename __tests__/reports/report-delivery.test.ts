import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REPORT DELIVERY CRON — dark-safe, composes-and-sends, org-isolated, fair.
 *
 * The cron composes the SAME report the export routes build and emails it as an
 * attachment. These tests pin: (1) with no RESEND key it no-ops WITHOUT touching
 * any cursor (dark); (2) the cadence gate is deterministic; (3) each due
 * subscription is built for ITS OWN org (no blending) and its cursor advances
 * (self-draining); (4) a not-due subscription is skipped and never sent.
 */

const {
  isCronAuthorisedMock,
  withCronTelemetryMock,
  createAdminClientMock,
  buildReportDocumentMock,
  documentToCsvMock,
  loadReportOrgMock,
  renderReportPdfMock,
  sendEmailMock,
  listDueMock,
  markRunMock,
  envMock,
} = vi.hoisted(() => ({
  isCronAuthorisedMock: vi.fn(),
  withCronTelemetryMock: vi.fn(),
  createAdminClientMock: vi.fn(),
  buildReportDocumentMock: vi.fn(),
  documentToCsvMock: vi.fn(),
  loadReportOrgMock: vi.fn(),
  renderReportPdfMock: vi.fn(),
  sendEmailMock: vi.fn(),
  listDueMock: vi.fn(),
  markRunMock: vi.fn(),
  envMock: { RESEND_API_KEY: undefined as string | undefined },
}));

vi.mock("@/lib/cron/auth", () => ({ isCronAuthorised: isCronAuthorisedMock }));
vi.mock("@/lib/env", () => ({ env: envMock }));
vi.mock("@/lib/ops/cron-telemetry", () => ({ withCronTelemetry: withCronTelemetryMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));
vi.mock("@/lib/reports/report-data", () => ({ buildReportDocument: buildReportDocumentMock }));
vi.mock("@/lib/reports/documents", () => ({ documentToCsv: documentToCsvMock }));
vi.mock("@/lib/reports/export-render", () => ({
  loadReportOrg: loadReportOrgMock,
  renderReportPdf: renderReportPdfMock,
  reportFilenameStem: () => "stem",
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/reports/subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/subscriptions")>();
  return {
    ...actual, // keep the real, pure isSubscriptionDue
    listActiveSubscriptionsForDelivery: listDueMock,
    markSubscriptionRun: markRunMock,
  };
});
// Pin "today" to a Monday the 1st so daily/weekly/monthly can all be exercised.
vi.mock("@/lib/time/format", () => ({ formatDayKeyUK: () => "2026-06-01" }));

const { GET } = await import("@/app/api/cron/report-delivery/route");
const { isSubscriptionDue } = await import("@/lib/reports/subscriptions");

beforeEach(() => {
  isCronAuthorisedMock.mockReset().mockReturnValue(true);
  createAdminClientMock.mockReset().mockReturnValue({});
  buildReportDocumentMock.mockReset().mockResolvedValue({
    key: "profit",
    title: "Profit & loss",
    subtitle: "",
    generatedAt: "2026-06-01T07:00:00.000Z",
    sections: [],
  });
  documentToCsvMock.mockReset().mockReturnValue("csv,data");
  loadReportOrgMock.mockReset().mockResolvedValue({ name: "Org", phone: null, vat_number: null, logo_url: null, address: null });
  renderReportPdfMock.mockReset().mockResolvedValue(Buffer.from("pdf"));
  sendEmailMock.mockReset().mockResolvedValue({ sent: true, id: "e1" });
  listDueMock.mockReset().mockResolvedValue([]);
  markRunMock.mockReset().mockResolvedValue({ error: null });
  envMock.RESEND_API_KEY = "re_test";
  // withCronTelemetry runs the wrapped fn and returns {status, payload}.
  withCronTelemetryMock.mockReset().mockImplementation(async (_name: string, fn: () => Promise<Record<string, unknown>>) => {
    const payload = await fn();
    return { status: 200, payload };
  });
});

describe("isSubscriptionDue", () => {
  it("daily is always due unless already run today", () => {
    expect(isSubscriptionDue({ cadence: "daily", last_run_on: null }, "2026-06-01")).toBe(true);
    expect(isSubscriptionDue({ cadence: "daily", last_run_on: "2026-06-01" }, "2026-06-01")).toBe(false);
  });
  it("weekly is due only on a Monday", () => {
    expect(isSubscriptionDue({ cadence: "weekly", last_run_on: null }, "2026-06-01")).toBe(true); // Mon
    expect(isSubscriptionDue({ cadence: "weekly", last_run_on: null }, "2026-06-02")).toBe(false); // Tue
  });
  it("monthly is due only on the 1st", () => {
    expect(isSubscriptionDue({ cadence: "monthly", last_run_on: null }, "2026-06-01")).toBe(true);
    expect(isSubscriptionDue({ cadence: "monthly", last_run_on: null }, "2026-06-15")).toBe(false);
  });
});

describe("GET — dark-safe", () => {
  it("no-ops WITHOUT advancing any cursor when RESEND_API_KEY is unset", async () => {
    envMock.RESEND_API_KEY = undefined;
    const res = await GET(new Request("https://x/api/cron/report-delivery"));
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(buildReportDocumentMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(markRunMock).not.toHaveBeenCalled();
  });

  it("401s an unauthorised caller", async () => {
    isCronAuthorisedMock.mockReturnValue(false);
    const res = await GET(new Request("https://x/api/cron/report-delivery"));
    expect(res.status).toBe(401);
  });
});

describe("GET — drain composes and sends, org-isolated", () => {
  it("builds each due subscription for ITS OWN org and advances its cursor", async () => {
    listDueMock.mockResolvedValue([
      { id: "s1", org_id: "org-A", report_key: "profit", format: "pdf", cadence: "daily", recipients: ["a@a.com"], active: true, last_run_on: null, created_at: "" },
      { id: "s2", org_id: "org-B", report_key: "pipeline", format: "csv", cadence: "daily", recipients: ["b@b.com"], active: true, last_run_on: null, created_at: "" },
    ]);
    const res = await GET(new Request("https://x/api/cron/report-delivery"));
    const body = await res.json();

    expect(body.sent).toBe(2);
    // Org isolation: each build carries the subscription's own org id.
    expect(buildReportDocumentMock).toHaveBeenCalledWith(expect.anything(), "org-A", "profit", expect.anything());
    expect(buildReportDocumentMock).toHaveBeenCalledWith(expect.anything(), "org-B", "pipeline", expect.anything());
    // Format routing: PDF renders, CSV serialises.
    expect(renderReportPdfMock).toHaveBeenCalledTimes(1);
    expect(documentToCsvMock).toHaveBeenCalledTimes(1);
    // Self-draining: both cursors advance to today.
    expect(markRunMock).toHaveBeenCalledWith(expect.anything(), "s1", "2026-06-01");
    expect(markRunMock).toHaveBeenCalledWith(expect.anything(), "s2", "2026-06-01");
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it("skips a not-due subscription without building, sending, or advancing", async () => {
    listDueMock.mockResolvedValue([
      { id: "s3", org_id: "org-A", report_key: "profit", format: "pdf", cadence: "weekly", recipients: ["a@a.com"], active: true, last_run_on: "2026-05-25", created_at: "" },
    ]);
    // 2026-06-01 is a Monday, so weekly IS due — force not-due by pre-running today.
    listDueMock.mockResolvedValue([
      { id: "s3", org_id: "org-A", report_key: "profit", format: "pdf", cadence: "monthly", recipients: ["a@a.com"], active: true, last_run_on: null, created_at: "" },
      { id: "s4", org_id: "org-A", report_key: "profit", format: "pdf", cadence: "weekly", recipients: ["a@a.com"], active: true, last_run_on: "2026-06-01", created_at: "" },
    ]);
    const res = await GET(new Request("https://x/api/cron/report-delivery"));
    const body = await res.json();
    // s3 (monthly, 1st) sends; s4 (already run today) is skipped.
    expect(body.sent).toBe(1);
    expect(body.skipped_not_due).toBe(1);
    expect(markRunMock).toHaveBeenCalledTimes(1);
    expect(markRunMock).toHaveBeenCalledWith(expect.anything(), "s3", "2026-06-01");
  });
});
