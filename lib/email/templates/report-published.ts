import "server-only";

/**
 * Report-published NOTIFICATION email.
 *
 * Sent to an org's own customer when a staff member PUBLISHES a site/progress
 * report to that customer's portal — because publication is otherwise silent
 * (the customer must revisit the portal to discover the report exists). This is
 * a NOTIFICATION, not the report itself: it carries the org's name, the report
 * number/title and a scoped link to the customer's own report page, and
 * DELIBERATELY no report body.
 *
 * A site report can name a job, third parties, internal-adjacent commentary and
 * financial context, and email is an insecure, forwardable channel — so the
 * content stays behind the token-gated portal, and the email only says
 * "there's a new report, here's the link". This mirrors buildPortalReplyEmail.
 */

export type ReportPublishedEmailInput = {
  org_name: string;
  customer_name: string | null;
  /** /customer-portal/<token>/reports/<reportId> — this customer's own report. */
  portal_url: string;
  /** Human reference for the subject line, e.g. "SR-0007". Null → generic copy. */
  report_number: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildReportPublishedEmail(input: ReportPublishedEmailInput): {
  html: string;
  text: string;
  subject: string;
} {
  const org = escapeHtml(input.org_name);
  const ref = input.report_number ? ` (${input.report_number})` : "";
  const refPlain = input.report_number ? ` (${input.report_number})` : "";
  const subject = `${input.org_name} shared a new report with you${refPlain}`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const url = escapeHtml(input.portal_url);

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      <strong>${org}</strong> has shared a new report${escapeHtml(ref)} with you. For
      your security we keep it in your portal rather than in email — open it there
      to read the update. If it asks for any decisions, you can respond from the
      same page.
    </p>
    <p style="margin:24px 0;text-align:center;">
      <a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
        View the report
      </a>
    </p>
    <p style="margin:0 0 8px;color:#475569;font-size:13px;">
      Or open this link: <a href="${url}" style="color:#0f172a;">${url}</a>
    </p>
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${org}</p>
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div>
</body></html>`;

  const text = [
    greeting.replace(/&#39;/g, "'"),
    "",
    `${input.org_name} has shared a new report${refPlain} with you. For your security we keep it in your portal rather than in email — open it there to read the update. If it asks for any decisions, you can respond from the same page.`,
    "",
    `View the report: ${input.portal_url}`,
    "",
    "Thanks,",
    input.org_name,
  ].join("\n");

  return { html, text, subject };
}
