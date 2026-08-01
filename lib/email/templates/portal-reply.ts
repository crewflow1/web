import "server-only";

/**
 * Portal-reply NOTIFICATION email.
 *
 * Sent to an org's own customer when a staff member replies to the customer's
 * portal support thread — because a portal reply is otherwise silent (the
 * customer must revisit the portal to discover it). This is a NOTIFICATION, not
 * a transcript: it carries the org's name and a scoped link to the customer's
 * own thread, and DELIBERATELY no message body. The reply may quote or discuss
 * the customer's account, prior messages, or third parties, and email is an
 * insecure, forwardable channel — so the content stays behind the token-gated
 * portal, and the email only says "there's a reply, here's the link".
 */

export type PortalReplyEmailInput = {
  org_name: string;
  customer_name: string | null;
  /** /customer-portal/<token>/messages/<ticketId> — this customer's own thread. */
  portal_url: string;
  ticket_number: number;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildPortalReplyEmail(input: PortalReplyEmailInput): {
  html: string;
  text: string;
  subject: string;
} {
  const org = escapeHtml(input.org_name);
  const subject = `${input.org_name} replied to your message (#${input.ticket_number})`;
  const greeting = input.customer_name
    ? `Hi ${escapeHtml(input.customer_name)},`
    : "Hi,";
  const url = escapeHtml(input.portal_url);

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;background:#f8fafc;margin:0;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;">
    <p style="margin:0 0 16px;font-size:16px;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:16px;">
      <strong>${org}</strong> has replied to your message. For your security we
      keep the conversation in your portal rather than in email — open the thread
      to read the reply and respond.
    </p>
    <p style="margin:24px 0;text-align:center;">
      <a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
        View the reply
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
    `${input.org_name} has replied to your message. For your security we keep the conversation in your portal rather than in email — open the thread to read the reply and respond.`,
    "",
    `View the reply: ${input.portal_url}`,
    "",
    "Thanks,",
    input.org_name,
  ].join("\n");

  return { html, text, subject };
}
