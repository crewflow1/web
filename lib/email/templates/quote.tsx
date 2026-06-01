import "server-only";

/**
 * Plain HTML quote email body builder. Mirrors the invoice template but the
 * call-to-action is the customer portal link where they can view, approve or
 * reject the quote (which stamps viewed_at / accepted_at / declined_at).
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type QuoteEmailInput = {
  org_name: string;
  customer_name: string | null;
  quote_number: string;
  total: number;
  valid_until: string | null;
  message: string | null;
  portal_url: string; // /q/<public_token> — view + approve/reject
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildQuoteEmail(input: QuoteEmailInput): {
  html: string;
  text: string;
  subject: string;
} {
  const subject = `${escapeHtml(input.org_name)} — Quote ${input.quote_number} (${GBP.format(input.total)})`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const validLine = input.valid_until
    ? `<p style="margin:0 0 16px;color:#475569;">Valid until <strong>${escapeHtml(input.valid_until)}</strong>.</p>`
    : "";
  const customMessage = input.message
    ? `<p style="margin:0 0 16px;color:#0f172a;white-space:pre-wrap;">${escapeHtml(input.message)}</p>`
    : "";
  const url = escapeHtml(input.portal_url);

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      Please find <strong>Quote ${escapeHtml(input.quote_number)}</strong> for
      <strong>${GBP.format(input.total)}</strong> attached as a PDF.
    </p>
    ${validLine}
    ${customMessage}
    <p style="margin:24px 0;text-align:center;">
      <a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
        View, approve or reject your quote
      </a>
    </p>
    <p style="margin:0 0 8px;color:#475569;font-size:13px;">
      Or open this link: <a href="${url}" style="color:#0f172a;">${url}</a>
    </p>
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div>
</body></html>`;

  const text = [
    greeting.replace(/&#39;/g, "'"),
    "",
    `Please find Quote ${input.quote_number} for ${GBP.format(input.total)} attached as a PDF.`,
    input.valid_until ? `Valid until ${input.valid_until}.` : "",
    input.message ? `\n${input.message}` : "",
    "",
    `View, approve or reject your quote: ${input.portal_url}`,
    "",
    "Thanks,",
    input.org_name,
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text, subject };
}
