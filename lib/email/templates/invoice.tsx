import "server-only";

/**
 * Plain HTML invoice email body builder.
 *
 * Deliberately minimal — most email clients butcher modern CSS, and the
 * PDF attachment carries the visual identity. Keep this short, readable,
 * and pay-by-bank-transfer-actionable.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type InvoiceEmailInput = {
  org_name: string;
  customer_name: string | null;
  invoice_number: string;
  total: number;
  due_date: string | null;
  message: string | null;
  pdf_url: string | null; // optional inline link as a fallback to the attachment
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildInvoiceEmail(input: InvoiceEmailInput): { html: string; text: string; subject: string } {
  const subject = `${escapeHtml(input.org_name)} — Invoice ${input.invoice_number} (${GBP.format(input.total)})`;

  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const dueLine = input.due_date
    ? `<p style="margin:0 0 16px;color:#475569;">Due by <strong>${escapeHtml(input.due_date)}</strong>.</p>`
    : "";
  const customMessage = input.message
    ? `<p style="margin:0 0 16px;color:#0f172a;white-space:pre-wrap;">${escapeHtml(input.message)}</p>`
    : "";
  const pdfLine = input.pdf_url
    ? `<p style="margin:0 0 8px;color:#475569;font-size:13px;">If the attachment doesn't open, you can also <a href="${escapeHtml(input.pdf_url)}" style="color:#0f172a;">view it online</a>.</p>`
    : "";

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      Please find <strong>Invoice ${escapeHtml(input.invoice_number)}</strong> for
      <strong>${GBP.format(input.total)}</strong> attached as a PDF.
    </p>
    ${dueLine}
    ${customMessage}
    ${pdfLine}
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div>
</body></html>`;

  const text = [
    `${greeting.replace(/&#39;/g, "'")}`,
    "",
    `Please find Invoice ${input.invoice_number} for ${GBP.format(input.total)} attached as a PDF.`,
    input.due_date ? `Due by ${input.due_date}.` : "",
    input.message ? `\n${input.message}` : "",
    "",
    `Thanks,`,
    input.org_name,
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text, subject };
}
