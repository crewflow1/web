import "server-only";

/**
 * Email body builders for the cron-driven follow-ups (Phase 8.2 b/c/d).
 * Plain HTML, short copy, attachment carries the visual identity.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(bodyHtml: string): string {
  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    ${bodyHtml}
    <hr style="margin:24px 0 12px;border:none;border-top:1px solid #e2e8f0;"/>
    <p style="margin:0;color:#94a3b8;font-size:11px;">Sent via CrewFlow.</p>
  </div>
</body></html>`;
}

// -------------------------------------------------------------------------
// 8.2b — payment reminder (N days before due_date)
// -------------------------------------------------------------------------
export type PaymentReminderInput = {
  org_name: string;
  customer_name: string | null;
  invoice_number: string;
  total: number;
  due_date: string;
  days_until_due: number;
};

export function buildPaymentReminder(input: PaymentReminderInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Reminder: Invoice ${input.invoice_number} due ${input.days_until_due === 0 ? "today" : `in ${input.days_until_due} day${input.days_until_due === 1 ? "" : "s"}`}`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const html = shell(`
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      Just a friendly reminder that <strong>Invoice ${escapeHtml(input.invoice_number)}</strong>
      for <strong>${GBP.format(input.total)}</strong> is due
      ${input.days_until_due === 0
        ? "<strong>today</strong>"
        : `in <strong>${input.days_until_due} day${input.days_until_due === 1 ? "" : "s"}</strong> (${escapeHtml(input.due_date)})`}.
    </p>
    <p style="margin:0 0 16px;color:#475569;">
      The invoice PDF is attached for your reference. Bank details for payment are at the bottom of the PDF.
    </p>
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
  `);
  const text = [
    `${greeting.replace(/&#39;/g, "'")}`,
    "",
    `Just a friendly reminder that Invoice ${input.invoice_number} for ${GBP.format(input.total)} is due ${input.days_until_due === 0 ? "today" : `in ${input.days_until_due} day${input.days_until_due === 1 ? "" : "s"} (${input.due_date})`}.`,
    "",
    `The invoice PDF is attached. Bank details for payment are at the bottom of the PDF.`,
    "",
    `Thanks,`,
    input.org_name,
  ].join("\n");
  return { subject, html, text };
}

// -------------------------------------------------------------------------
// 8.2c — overdue reminder (N days past due_date)
// -------------------------------------------------------------------------
export type OverdueReminderInput = {
  org_name: string;
  customer_name: string | null;
  invoice_number: string;
  total: number;
  due_date: string;
  days_overdue: number;
};

export function buildOverdueReminder(input: OverdueReminderInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Overdue: Invoice ${input.invoice_number} (${input.days_overdue} day${input.days_overdue === 1 ? "" : "s"} past due)`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const html = shell(`
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      <strong>Invoice ${escapeHtml(input.invoice_number)}</strong> for
      <strong>${GBP.format(input.total)}</strong> is now
      <strong>${input.days_overdue} day${input.days_overdue === 1 ? "" : "s"} overdue</strong>
      (due ${escapeHtml(input.due_date)}).
    </p>
    <p style="margin:0 0 16px;color:#475569;">
      If you've already settled this, please ignore this message — we may not have matched it up yet.
      Otherwise, the invoice PDF is attached and bank details for payment are at the bottom.
    </p>
    <p style="margin:0 0 16px;color:#475569;">
      If there's anything blocking payment, just reply to this email and we'll sort it.
    </p>
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
  `);
  const text = [
    `${greeting.replace(/&#39;/g, "'")}`,
    "",
    `Invoice ${input.invoice_number} for ${GBP.format(input.total)} is now ${input.days_overdue} day${input.days_overdue === 1 ? "" : "s"} overdue (due ${input.due_date}).`,
    "",
    `If you've already settled this, please ignore this message. Otherwise, the invoice PDF is attached and bank details are at the bottom.`,
    "",
    `If there's anything blocking payment, just reply and we'll sort it.`,
    "",
    `Thanks,`,
    input.org_name,
  ].join("\n");
  return { subject, html, text };
}

// -------------------------------------------------------------------------
// 8.2d — quote follow-up (N days after sent, no view yet)
// -------------------------------------------------------------------------
export type QuoteFollowupInput = {
  org_name: string;
  customer_name: string | null;
  quote_number: string;
  total: number;
  days_since_sent: number;
};

export function buildQuoteFollowup(input: QuoteFollowupInput): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Following up — Quote ${input.quote_number}`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const html = shell(`
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      Just checking in on <strong>Quote ${escapeHtml(input.quote_number)}</strong>
      (${GBP.format(input.total)}) we sent
      ${input.days_since_sent === 1 ? "yesterday" : `${input.days_since_sent} days ago`}.
    </p>
    <p style="margin:0 0 16px;color:#475569;">
      No rush — happy to walk you through it, tweak the scope, or answer any questions.
      Just reply to this email.
    </p>
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
  `);
  const text = [
    `${greeting.replace(/&#39;/g, "'")}`,
    "",
    `Just checking in on Quote ${input.quote_number} (${GBP.format(input.total)}) we sent ${input.days_since_sent === 1 ? "yesterday" : `${input.days_since_sent} days ago`}.`,
    "",
    `Happy to walk you through it, tweak the scope, or answer any questions. Just reply to this email.`,
    "",
    `Thanks,`,
    input.org_name,
  ].join("\n");
  return { subject, html, text };
}
