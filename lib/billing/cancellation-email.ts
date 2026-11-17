import {
  ACCOUNT_BILLING_PATH,
  CANCELLATION_COPY,
  formatAccessDate,
} from "./cancellation";
import { operatorDisclosure } from "@/lib/legal/operator";

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
  const subject = `Your CrewFlow subscription for ${input.orgName} has ended`;

  const paragraphs: string[] = [
    input.hadSubscription
      ? `This confirms that the CrewFlow subscription for ${input.orgName} has ended. Staff no longer have access; the account owner keeps read-only access to download data and invoices.`
      : `This confirms that the CrewFlow workspace for ${input.orgName} has been closed. There was no card subscription on the account. The account owner keeps read-only access to download data and invoices.`,
    CANCELLATION_COPY.charges,
    ...(input.hadSubscription ? [CANCELLATION_COPY.unpaid, CANCELLATION_COPY.refund] : []),
    CANCELLATION_COPY.data,
    `Invoices, receipts and your data export: ${billingUrl}`,
    CANCELLATION_COPY.reactivate,
    `Our terms: ${termsUrl}`,
    "If you didn't ask for this, reply to this email straight away.",
  ];

  const op = operatorDisclosure();
  const text = ["Hi,", ...paragraphs, "CrewFlow", ...(op ? [op.line] : [])].join("\n\n");

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
  <h1 style="margin:16px 0;font-size:20px">Your subscription has ended</h1>
  ${htmlParagraphs}
  <p style="color:#475569;font-size:12px;margin-top:32px">CrewFlow</p>${op ? `\n  <p style="color:#475569;font-size:12px">${esc(op.line)}</p>` : ""}
</div>`;

  return { subject, html, text };
}

export type CancellationScheduleEmailInput = {
  orgName: string;
  appUrl: string;
  kind: "scheduled" | "resumed";
  /** Unix seconds: access end (scheduled) or next renewal (resumed). */
  at: number;
};

/**
 * Sent when the owner SCHEDULES a cancellation (with the exact final access
 * date) or withdraws one. Same statements as the confirmation dialog.
 */
export function buildCancellationScheduleEmail(input: CancellationScheduleEmailInput): CancellationEmail {
  const base = input.appUrl.replace(/\/$/, "");
  const billingUrl = `${base}${ACCOUNT_BILLING_PATH}`;
  const termsUrl = `${base}/terms`;
  const date = formatAccessDate(input.at);
  const scheduled = input.kind === "scheduled";
  const subject = scheduled
    ? `Your CrewFlow subscription for ${input.orgName} ends on ${date}`
    : `Your CrewFlow subscription for ${input.orgName} will continue`;
  const paragraphs: string[] = scheduled
    ? [
        `This confirms that the CrewFlow subscription for ${input.orgName} is cancelled from the end of the current paid period. Your final day of access is ${date}.`,
        CANCELLATION_COPY.scheduledAccess(date),
        CANCELLATION_COPY.charges,
        CANCELLATION_COPY.refund,
        CANCELLATION_COPY.data,
        CANCELLATION_COPY.undo(date),
        `Billing page: ${billingUrl}`,
        `Our terms: ${termsUrl}`,
        "If you didn't ask for this, reply to this email straight away.",
      ]
    : [
        `This confirms that the scheduled cancellation for ${input.orgName} has been withdrawn. Your subscription continues and next renews on ${date}.`,
        `Billing page: ${billingUrl}`,
        "If you didn't ask for this, reply to this email straight away.",
      ];
  const op = operatorDisclosure();
  const text = ["Hi,", ...paragraphs, "CrewFlow", ...(op ? [op.line] : [])].join("\n\n");
  const htmlParagraphs = paragraphs
    .map((p) => {
      const safe = esc(p)
        .replace(esc(billingUrl), `<a href="${esc(billingUrl)}">${esc(billingUrl)}</a>`)
        .replace(esc(termsUrl), `<a href="${esc(termsUrl)}">${esc(termsUrl)}</a>`);
      return `<p>${safe}</p>`;
    })
    .join("\n  ");
  const heading = scheduled ? `Your subscription ends on ${esc(date)}` : "Your subscription will continue";
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.55">
  <p>Hi,</p>
  <h1 style="margin:16px 0;font-size:20px">${heading}</h1>
  ${htmlParagraphs}
  <p style="color:#475569;font-size:12px;margin-top:32px">CrewFlow</p>${op ? `\n  <p style="color:#475569;font-size:12px">${esc(op.line)}</p>` : ""}
</div>`;
  return { subject, html, text };
}
