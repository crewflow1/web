import "server-only";

/**
 * Email body builders for the cron-driven follow-ups.
 *
 * Invoice reminders are stage-based (see invoice_reminders.stage):
 *   day_3   Friendly reminder
 *   day_7   Payment reminder
 *   day_14  Invoice overdue
 *   day_21  Final reminder
 *   manual  Operator-triggered send
 *
 * Quote follow-up is a single stage (5 days after sent, unviewed).
 *
 * Plain HTML, short copy. The attachment carries the visual identity.
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
// Invoice reminders (4 stages + manual)
// -------------------------------------------------------------------------
export type ReminderStage = "day_3" | "day_7" | "day_14" | "day_21" | "manual";

export type InvoiceReminderInput = {
  org_name: string;
  customer_name: string | null;
  invoice_number: string;
  total: number;
  due_date: string | null;
  stage: ReminderStage;
  /** Free-text message — used for stage="manual" so the operator can add a note. */
  custom_message?: string | null;
};

const STAGE_HEADERS: Record<ReminderStage, string> = {
  day_3: "Friendly reminder",
  day_7: "Payment reminder",
  day_14: "Invoice overdue",
  day_21: "Final reminder",
  manual: "Payment reminder",
};

const STAGE_TONES: Record<ReminderStage, string> = {
  day_3:
    "Just a friendly reminder that the invoice attached is awaiting payment. No rush — let us know if you have any questions.",
  day_7:
    "This is a polite reminder that the invoice attached is still outstanding. The PDF and bank details for payment are attached.",
  day_14:
    "The attached invoice is now overdue. Please settle it at your earliest convenience, or reply to this email if there's an issue we can help resolve.",
  day_21:
    "This is a final reminder that the attached invoice remains unpaid. If we don't hear from you, we may need to pause further work. Please reply to this email so we can sort it out.",
  manual:
    "Just following up on the attached invoice. The PDF and bank details for payment are included.",
};

export function buildInvoiceReminder(input: InvoiceReminderInput): {
  subject: string;
  html: string;
  text: string;
} {
  const header = STAGE_HEADERS[input.stage];
  // Optional note renders ABOVE the default polite tone, set apart with
  // its own block so the operator's words stand out. The stage default
  // is never replaced — if the operator wrote a note, they get both.
  const note = input.custom_message?.trim() || null;
  const tone = STAGE_TONES[input.stage];

  const subject = `${header}: Invoice ${input.invoice_number} (${GBP.format(input.total)})`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const dueLine = input.due_date
    ? `<p style="margin:0 0 16px;color:#475569;">Original due date: <strong>${escapeHtml(input.due_date)}</strong>.</p>`
    : "";
  const noteBlock = note
    ? `<div style="margin:0 0 16px;padding:12px;border-left:3px solid #0f172a;background:#f8fafc;">
        <p style="margin:0;font-size:14px;color:#0f172a;white-space:pre-wrap;">${escapeHtml(note)}</p>
      </div>`
    : "";

  const html = shell(`
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    ${noteBlock}
    <p style="margin:0 0 16px;font-size:16px;">
      ${escapeHtml(tone)}
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#0f172a;">
      <strong>Invoice ${escapeHtml(input.invoice_number)}</strong> &middot;
      <strong>${GBP.format(input.total)}</strong>
    </p>
    ${dueLine}
    <p style="margin:24px 0 0;color:#0f172a;">Thanks,<br/>${escapeHtml(input.org_name)}</p>
  `);
  const text = [
    `${greeting.replace(/&#39;/g, "'")}`,
    "",
    note ? note : "",
    note ? "" : "",
    tone,
    "",
    `Invoice ${input.invoice_number} — ${GBP.format(input.total)}`,
    input.due_date ? `Original due date: ${input.due_date}` : "",
    "",
    `Thanks,`,
    input.org_name,
  ]
    .filter(Boolean)
    .join("\n");
  return { subject, html, text };
}

// -------------------------------------------------------------------------
// Quote follow-up (single stage, kept from earlier)
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
