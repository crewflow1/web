import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { StatementPdf } from "@/lib/pdf/statement-pdf";
import { sendEmail } from "@/lib/email/send";
import { buildStatementEmail } from "@/lib/email/templates/statement";
import {
  loadCustomerStatement,
  type StatementRange,
} from "@/server/services/customer-statement";
import { env } from "@/lib/env";

/**
 * Render + email a customer's statement of account (PDF attachment).
 *
 * DARK-SAFE: when RESEND_API_KEY is unset the whole path short-circuits to
 * `{ sent:false, reason:"no_resend_key" }` before any render — mirrors
 * lib/email/send-invoice.ts, so the feature ships and simply becomes live the
 * moment a provider is configured. Never throws for a send/transport failure;
 * a genuine READ failure inside loadCustomerStatement (loud reads) still
 * propagates so a broken read can never masquerade as an empty statement.
 *
 * ACTIVE-ORG scope is enforced by loadCustomerStatement (`orgId` pin) — a
 * foreign customer id resolves to null and yields `reason:"not_found"`.
 */

export type SendStatementResult =
  | { sent: true; emailId: string; to: string; closingBalance: number }
  | {
      sent: false;
      reason:
        | "no_resend_key"
        | "not_found"
        | "no_recipient"
        | "invalid_recipient"
        | "send_failed";
      detail?: string;
    };

type SendStatementOptions = {
  /** Recipient override; defaults to the customer's email on file. */
  to?: string;
  /** Optional covering note added to the email body. */
  message?: string;
  /** Statement date range. */
  range?: StatementRange;
};

export async function sendCustomerStatementEmail(
  supabase: SupabaseClient<Database>,
  orgId: string,
  customerId: string,
  options: SendStatementOptions = {},
): Promise<SendStatementResult> {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_resend_key" };

  const view = await loadCustomerStatement(
    supabase,
    orgId,
    customerId,
    options.range ?? {},
  );
  if (!view) return { sent: false, reason: "not_found" };

  const recipient = options.to ?? view.customer.email ?? null;
  if (!recipient) return { sent: false, reason: "no_recipient" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return { sent: false, reason: "invalid_recipient" };
  }

  const pdfBuffer = await renderToBuffer(StatementPdf({ s: view.pdfInput }));

  const { html, text, subject } = buildStatementEmail({
    org_name: view.pdfInput.org_name,
    customer_name: view.customer.name,
    from: view.statement.from,
    to: view.statement.to,
    closing_balance: view.statement.closingBalance,
    message: options.message ?? null,
  });

  const result = await sendEmail({
    to: recipient,
    subject,
    html,
    text,
    attachments: [{ filename: `${view.filename}.pdf`, content: pdfBuffer }],
  });

  if (!result.sent) {
    return {
      sent: false,
      reason: result.reason === "no_key" ? "no_resend_key" : "send_failed",
      detail: "error" in result ? result.error : undefined,
    };
  }

  return {
    sent: true,
    emailId: result.id,
    to: recipient,
    closingBalance: view.statement.closingBalance,
  };
}
