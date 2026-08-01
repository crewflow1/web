import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/send";
import { buildPortalReplyEmail } from "@/lib/email/templates/portal-reply";
import { readFailure } from "@/lib/supabase/read-failure";
import { env } from "@/lib/env";
import { isValidPortalTokenShape } from "@/lib/customers/portal-token";

/**
 * Tenant → customer: notify a customer by EMAIL that staff replied to their
 * portal support thread. A portal reply is otherwise silent — the customer has
 * no CrewFlow login and no in-app notification feed, so without this they must
 * revisit the portal to discover a reply.
 *
 * This is the portal peer of lib/email/send-quote.ts: the EXISTING Resend
 * wrapper, a scoped portal-token link, best-effort (never throws). It is NOT the
 * notification bus — that resolves recipients to `organizations.email` and links
 * into the CrewFlow app, neither of which reaches the org's own customer.
 *
 * SECURITY / no-leakage invariants:
 *   - The recipient is derived from the TICKET's own customer, re-loaded here
 *     scoped by (id = customer_id AND org_id = the active org). A foreign or
 *     cross-org customer_id resolves to no row → skipped, never emailed.
 *   - The link uses THAT customer's own portal_token, so it can only ever open
 *     their own thread.
 *   - The email carries the org name + link only — NEVER the message body (see
 *     the template). Email is forwardable and insecure; the content stays behind
 *     the token gate.
 *
 * CONSENT / preference gating (customer_portal_preferences.preferred_channel,
 * shipped #522): if the customer has chosen a non-email channel we skip and say
 * why. A missing preferences row means the default ('email'), so we send.
 *
 * Idempotency: this is invoked once from the reply server action, after the
 * message row is persisted — one reply, one send. It performs no writes and must
 * never be called from a render/GET path.
 */

export type SendPortalReplyEmailResult =
  | { sent: true; emailId: string; to: string }
  | {
      sent: false;
      reason:
        | "no_resend_key"
        | "customer_not_found"
        | "no_recipient"
        | "invalid_recipient"
        | "no_token"
        | "token_expired"
        | "channel_opt_out"
        | "load_failed"
        | "send_failed";
      detail?: string;
    };

type CustomerRow = {
  id: string;
  name: string;
  email: string | null;
  portal_token: string | null;
  portal_token_expires_at: string | null;
};

type OrgRow = { name: string | null };

type PrefRow = { preferred_channel: string };

/**
 * @param orgId       the ACTIVE org resolved by the caller (org-pin). The
 *                    customer lookup is scoped to it so a dual-org actor can
 *                    never email another org's customer.
 * @param customerId  the ticket's own customer_id (already org-pinned when the
 *                    caller resolved the ticket).
 * @param ticketId    the thread the link should open.
 * @param ticketNumber for the subject line.
 */
export async function sendPortalReplyNotificationEmail(input: {
  orgId: string;
  customerId: string;
  ticketId: string;
  ticketNumber: number;
}): Promise<SendPortalReplyEmailResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_resend_key" };

  const admin = createAdminClient();

  // Recipient = the TICKET's own customer, scoped to the active org. A foreign
  // or cross-org customer_id yields no row and we send nothing.
  const { data: customerRaw, error: cErr } = await (
    admin.from("customers" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: CustomerRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, name, email, portal_token, portal_token_expires_at")
    .eq("id", input.customerId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (cErr) throw readFailure("send-portal-reply: customer", cErr);
  if (!customerRaw) return { sent: false, reason: "customer_not_found" };
  const customer = customerRaw;

  const recipient = customer.email;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, reason: "invalid_recipient" };
  }

  // A dead link is worse than no email — don't send an expired portal token.
  if (!customer.portal_token || !isValidPortalTokenShape(customer.portal_token)) {
    return { sent: false, reason: "no_token" };
  }
  if (
    customer.portal_token_expires_at &&
    Date.parse(customer.portal_token_expires_at) <= Date.now()
  ) {
    return { sent: false, reason: "token_expired" };
  }

  // CONSENT: respect the customer's chosen channel. Default (no row) = email.
  const { data: prefRaw, error: pErr } = await (
    admin.from("customer_portal_preferences" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: PrefRow | null;
              error: { message: string } | null;
            }>;
          };
        };
      };
    }
  )
    .select("preferred_channel")
    .eq("org_id", input.orgId)
    .eq("customer_id", input.customerId)
    .maybeSingle();
  if (pErr) throw readFailure("send-portal-reply: preferences", pErr);
  if (prefRaw && prefRaw.preferred_channel !== "email") {
    return { sent: false, reason: "channel_opt_out", detail: prefRaw.preferred_channel };
  }

  const { data: orgRaw, error: oErr } = await admin
    .from("organizations")
    .select("name")
    .eq("id", input.orgId)
    .maybeSingle();
  if (oErr) throw readFailure("send-portal-reply: org", oErr);
  const org = (orgRaw as OrgRow | null) ?? { name: null };

  const portalUrl = `${env.NEXT_PUBLIC_APP_URL}/customer-portal/${customer.portal_token}/messages/${input.ticketId}`;

  const { html, text, subject } = buildPortalReplyEmail({
    org_name: org.name ?? "Your contractor",
    customer_name: customer.name,
    portal_url: portalUrl,
    ticket_number: input.ticketNumber,
  });

  const result = await sendEmail({ to: recipient, subject, html, text });
  if (!result.sent) {
    return {
      sent: false,
      reason: result.reason === "no_key" ? "no_resend_key" : "send_failed",
      detail: "error" in result ? result.error : result.reason,
    };
  }
  return { sent: true, emailId: result.id, to: recipient };
}
