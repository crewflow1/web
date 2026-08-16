import "server-only";

/**
 * Plain HTML statement-of-account email body builder.
 *
 * Deliberately minimal — email clients butcher modern CSS, and the PDF
 * attachment carries the visual identity. Mirrors lib/email/templates/invoice.
 * A credit balance is spelled out ("in credit") rather than shown as a bare
 * minus, which a reader misreads.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type StatementEmailInput = {
  org_name: string;
  customer_name: string | null;
  /** Range bounds (YYYY-MM-DD) or null when open-ended. */
  from: string | null;
  to: string | null;
  closing_balance: number;
  message: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function balancePhrase(v: number): string {
  if (v < 0) return `${GBP.format(-v)} in credit`;
  return `${GBP.format(v)} outstanding`;
}

function periodPhrase(from: string | null, to: string | null): string {
  if (from && to) return ` for the period ${from} to ${to}`;
  if (from) return ` from ${from}`;
  if (to) return ` up to ${to}`;
  return "";
}

export function buildStatementEmail(input: StatementEmailInput): {
  html: string;
  text: string;
  subject: string;
} {
  const subject = `${input.org_name} — Statement of account (${balancePhrase(input.closing_balance)})`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const period = periodPhrase(input.from, input.to);
  const balanceLine = `<p style="margin:0 0 16px;color:#0f172a;">The closing balance on your account is <strong>${escapeHtml(balancePhrase(input.closing_balance))}</strong>.</p>`;
  const customMessage = input.message
    ? `<p style="margin:0 0 16px;color:#0f172a;white-space:pre-wrap;">${escapeHtml(input.message)}</p>`
    : "";

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      Please find your <strong>statement of account</strong>${escapeHtml(period)} attached as a PDF.
    </p>
    ${balanceLine}
    ${customMessage}
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div>
</body></html>`;

  const text = [
    greeting.replace(/&#39;/g, "'"),
    "",
    `Please find your statement of account${period} attached as a PDF.`,
    `The closing balance on your account is ${balancePhrase(input.closing_balance)}.`,
    input.message ? `\n${input.message}` : "",
    "",
    "Thanks,",
    input.org_name,
  ]
    .filter(Boolean)
    .join("\n");

  return { html, text, subject };
}
