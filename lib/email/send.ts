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
  /** Override RESEND_REPLY_TO for this send (e.g. so the org owner gets replies). */
  replyTo?: string;
  attachments?: EmailAttachment[];
};

export type SendEmailResult =
  | { sent: true; id: string }
  | { sent: false; reason: "no_key" }
  | { sent: false; reason: "error"; error: string };

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    return { sent: false, reason: "no_key" };
  }

  try {
    const { Resend } = await import("resend");
    const client = new Resend(apiKey);

    const res = await client.emails.send({
      from: env.RESEND_FROM_EMAIL,
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
