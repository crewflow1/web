import {
  ACCOUNT_BILLING_PATH,
  CANCELLATION_COPY,
} from "./cancellation";

/**
 * The cancellation CONFIRMATION email — pure builder (no send, no env).
 *
 * Sent once, to the owner who cancelled, when the cancellation is confirmed.
 * It says only what CANCELLATION_COPY says (the same statements the
 * confirmation step made before they clicked), so the email can never promise
 * something the product did not.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type CancellationEmailInput = {
  orgName: string;
  /** Absolute app origin, no trailing slash needed. */
  appUrl: string;
  /** True when a Stripe subscription was terminated (vs. a workspace with none). */
  hadSubscription: boolean;
};

export type CancellationEmail = { subject: string; html: string; text: string };

export function buildCancellationEmail(input: CancellationEmailInput): CancellationEmail {
  const base = input.appUrl.replace(/\/$/, "");
  const billingUrl = `${base}${ACCOUNT_BILLING_PATH}`;
  const termsUrl = `${base}/terms`;
  const subject = `Your CrewFlow subscription for ${input.orgName} is cancelled`;

  const paragraphs: string[] = [
    input.hadSubscription
      ? `This confirms that the CrewFlow subscription for ${input.orgName} has been cancelled, effective immediately.`
      : `This confirms that the CrewFlow workspace for ${input.orgName} has been cancelled, effective immediately. There was no card subscription on the account.`,
    CANCELLATION_COPY.charges,
    ...(input.hadSubscription ? [CANCELLATION_COPY.unpaid, CANCELLATION_COPY.refund] : []),
    CANCELLATION_COPY.data,
    `Invoices, receipts and your data export: ${billingUrl}`,
    CANCELLATION_COPY.reactivate,
    `Our terms: ${termsUrl}`,
    "If you didn't ask for this, reply to this email straight away.",
  ];

  const text = ["Hi,", ...paragraphs, "CrewFlow"].join("\n\n");

  const htmlParagraphs = paragraphs
    .map((p) => {
      const safe = esc(p)
        .replace(esc(billingUrl), `<a href="${esc(billingUrl)}">${esc(billingUrl)}</a>`)
        .replace(esc(termsUrl), `<a href="${esc(termsUrl)}">${esc(termsUrl)}</a>`);
      return `<p>${safe}</p>`;
    })
    .join("\n  ");

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55">
  <p>Hi,</p>
  <h1 style="margin:16px 0;font-size:20px">Your subscription is cancelled</h1>
  ${htmlParagraphs}
  <p style="color:#475569;font-size:12px;margin-top:32px">CrewFlow</p>
</div>`;

  return { subject, html, text };
}
