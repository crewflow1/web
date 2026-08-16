import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildReportPublishedEmail } from "@/lib/email/templates/report-published";

/**
 * Portal completion R4 — email a customer when a report is PUBLISHED.
 *
 * Publication was silent: a customer with no login had to revisit the portal to
 * discover a new report. This closes that gap using the EXISTING Resend wrapper
 * and the same org-pinned, consent-gated, no-leakage doctrine as the portal
 * reply email. Pure template tested behaviourally; the send module + the action
 * wiring pinned on SOURCE (repo convention — see portal-reply-notifications).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const SEND = read("lib/email/send-report-published.ts");
const TEMPLATE = read("lib/email/templates/report-published.ts");
const SITE_REPORT_ACTIONS = read("app/(app)/site-reports/actions.ts");

// =====================================================================
// The send module — scoping + consent + no leakage
// =====================================================================

describe("sendReportPublishedNotificationEmail — scoped, consent-gated, minimal", () => {
  it("resolves the recipient from the REPORT's own customer, org-pinned", () => {
    expect(SEND).toMatch(/\.eq\("id", input\.customerId\)/);
    expect(SEND).toMatch(/\.eq\("org_id", input\.orgId\)/);
    expect(SEND).toMatch(/customer_not_found/);
  });

  it("builds the link from THAT customer's own portal_token + reportId", () => {
    expect(SEND).toMatch(
      /customer-portal\/\$\{customer\.portal_token\}\/reports\/\$\{input\.reportId\}/,
    );
  });

  it("respects the customer's preferred_channel (consent gate)", () => {
    expect(SEND).toMatch(/customer_portal_preferences/);
    expect(SEND).toMatch(/preferred_channel !== "email"[\s\S]*channel_opt_out/);
  });

  it("never emails a dead link — guards missing/expired tokens", () => {
    expect(SEND).toMatch(/no_token/);
    expect(SEND).toMatch(/token_expired/);
  });

  it("uses the EXISTING Resend wrapper, no new provider", () => {
    expect(SEND).toMatch(/import \{ sendEmail \} from "@\/lib\/email\/send"/);
    expect(SEND).not.toMatch(/new Resend|twilio|whatsapp|meta/i);
  });

  it("passes NO report body to the template — only org, number and link", () => {
    // The send never reads the report's snapshot / decision / body columns, so
    // that data cannot ride into the email. It only ever selects customer
    // identity + token columns and the org name.
    expect(SEND).not.toMatch(/snapshot|client_decisions/);
    expect(SEND).not.toMatch(/\.select\([^)]*content/);
    expect(SEND).toMatch(
      /\.select\("id, name, email, portal_token, portal_token_expires_at"\)/,
    );
  });
});

// =====================================================================
// The action wiring — best-effort, event-driven, customer-derived
// =====================================================================

describe("publishToPortal — emails the report's customer, best-effort", () => {
  it("imports the dedicated send module", () => {
    expect(SITE_REPORT_ACTIONS).toMatch(
      /import \{ sendReportPublishedNotificationEmail \} from "@\/lib\/email\/send-report-published"/,
    );
  });

  it("calls it EXACTLY ONCE (one publish, one email)", () => {
    const calls =
      SITE_REPORT_ACTIONS.match(/sendReportPublishedNotificationEmail\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it("derives recipient + org from the report, active-org pinned", () => {
    expect(SITE_REPORT_ACTIONS).toMatch(/orgId: ctx\.org\.id/);
    expect(SITE_REPORT_ACTIONS).toMatch(/customerId: report\.customer_id/);
    expect(SITE_REPORT_ACTIONS).toMatch(/reportId: id/);
  });

  it("emits only AFTER the publish is persisted + audited", () => {
    const updateIdx = SITE_REPORT_ACTIONS.indexOf("portal_published_at: new Date()");
    const auditIdx = SITE_REPORT_ACTIONS.indexOf("site_report.portal_published");
    const sendIdx = SITE_REPORT_ACTIONS.indexOf(
      "sendReportPublishedNotificationEmail(",
    );
    expect(updateIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(updateIdx);
    expect(sendIdx).toBeGreaterThan(auditIdx);
  });

  it("is best-effort — a mail failure cannot break the persisted publish", () => {
    const sendIdx = SITE_REPORT_ACTIONS.indexOf(
      "sendReportPublishedNotificationEmail(",
    );
    const tryIdx = SITE_REPORT_ACTIONS.lastIndexOf("try {", sendIdx);
    const catchIdx = SITE_REPORT_ACTIONS.indexOf("} catch", sendIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(sendIdx);
  });
});

// =====================================================================
// The template — notification + link only, no report content
// =====================================================================

describe("buildReportPublishedEmail — notification + link only", () => {
  const built = buildReportPublishedEmail({
    org_name: "Acme Builders",
    customer_name: "Jane",
    portal_url: "https://app.example/customer-portal/tok-123/reports/rep-1",
    report_number: "SR-0007",
  });

  it("carries the org, the report ref and the scoped link", () => {
    expect(built.subject).toContain("Acme Builders");
    expect(built.subject).toContain("SR-0007");
    expect(built.html).toContain(
      "https://app.example/customer-portal/tok-123/reports/rep-1",
    );
    expect(built.text).toContain(
      "https://app.example/customer-portal/tok-123/reports/rep-1",
    );
  });

  it("cannot carry report content — no parameter exists for one", () => {
    const secret = "SECRET-REPORT-BODY-AND-DECISIONS";
    expect(built.html).not.toContain(secret);
    expect(built.text).not.toContain(secret);
    // The template input type declares no body/snapshot/content field.
    expect(TEMPLATE).not.toMatch(/(snapshot|content|body)\s*\??:/);
  });

  it("degrades gracefully with no report number", () => {
    const b = buildReportPublishedEmail({
      org_name: "Acme",
      customer_name: null,
      portal_url: "https://x/y",
      report_number: null,
    });
    expect(b.subject).toContain("Acme");
    expect(b.html).toContain("Hi,");
  });
});
