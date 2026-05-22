import "server-only";
import { env } from "@/lib/env";

/**
 * Thin Resend wrapper.
 *
 * Mirrors the lib/ai/llm.ts posture:
 *   - Graceful degradation when RESEND_API_KEY is unset.
 *   - Errors are caught and reported via the structured return; we never
 *     throw out of the helper, so a transient email failure doesn't 500
 *     the caller's route. The caller decides how to surface it to the UI.
 *
 * Dynamic import keeps the Resend SDK out of bundles that don't send.
 */

export type EmailAttachment = {
  filename: string;
  content: Buffer | Uint8Array;
};

export type SendEmailInput = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /** Override RESEND_FROM_EMAIL for this send (e.g. notify@ vs hello@). */
  from?: string;
  /** Override RESEND_REPLY_TO for this send (e.g. so the org owner gets replies). */
  replyTo?: string;
  attachments?: EmailAttachment[];
};

export type SendEmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: "no_key" }
  | { sent: false; reason: "self_loop"; from: string; to: string }
  | { sent: false; reason: "error"; error: string };

/** Extract the bare email out of `"Display Name <addr@host>"` or just `addr@host`. */
function extractAddress(field: string): string {
  const m = field.match(/<([^>]+)>/);
  const bare = m && m[1] ? m[1] : field;
  return bare.trim().toLowerCase();
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "no_key" };
  }

  const from = input.from ?? env.RESEND_FROM_EMAIL;

  // Self-loop guard. Sending From and To the same mailbox is one of the
  // top reasons Gmail/Workspace silently drops mail as spam/loop —
  // surface the failure now so the caller can correct the From address
  // instead of silently losing notifications.
  const fromAddr = extractAddress(from);
  const tos = Array.isArray(input.to) ? input.to : [input.to];
  for (const to of tos) {
    if (extractAddress(to) === fromAddr) {
      return { sent: false, reason: "self_loop", from, to };
    }
  }

  try {
    const { Resend } = await import("resend");
    const client = new Resend(apiKey);

    const res = await client.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      replyTo: input.replyTo ?? env.RESEND_REPLY_TO,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.isBuffer(a.content)
          ? a.content
          : Buffer.from(a.content),
      })),
    });

    if (res.error) {
      console.error("[email] resend rejected", res.error);
      return { sent: false, reason: "error", error: res.error.message ?? "unknown" };
    }
    if (!res.data?.id) {
      return { sent: false, reason: "error", error: "no_id_returned" };
    }
    return { sent: true, id: res.data.id };
  } catch (err) {
    console.error("[email] send threw", err);
    return {
      sent: false,
      reason: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
