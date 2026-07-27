import "server-only";

/**
 * CrewFlow HQ — Communication Layer: the Resend email provider (Directive 010, Phase 4).
 *
 * The V1 implementation of the `EmailProvider` seam. It does NOT re-implement
 * transport — it DELEGATES to the existing `lib/email/send.ts` (the thin Resend
 * wrapper the rest of the app already uses), translating that helper's structured
 * result into the seam's contract:
 *   - the transport ACCEPTED the message  → resolve with the provider message id.
 *   - the transport degraded (no key / self-loop / vendor error) → THROW, so the
 *     service records a `failed` attempt and owns retry.
 *
 * "Prefer extension over replacement" (a permanent engineering rule): one transport,
 * wrapped by the seam, not a second mailer. Swapping Resend for another vendor is a
 * sibling file here plus a branch in ./index — never a change to the service.
 */

import { sendEmail } from "@/lib/email/send";
import type { CommProviderInfo, EmailAcceptance, EmailMessage, EmailProvider } from "../types";

const INFO: CommProviderInfo = { provider: "resend", channel: "email" };

export function createResendEmailProvider(): EmailProvider {
  return {
    info: INFO,
    async send(message: EmailMessage): Promise<EmailAcceptance> {
      const result = await sendEmail({
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        from: message.from,
        replyTo: message.replyTo,
      });

      if (result.sent) {
        return { providerMessageId: result.id };
      }

      // The transport degrades structurally; the seam contract is THROW-on-failure
      // (mirroring lib/ai/text's provider.generate), so the service records a
      // terminal `failed` attempt with the reason and decides on retry.
      if (result.reason === "self_loop") {
        throw new Error(`resend: self-loop blocked (from=${result.from} to=${result.to})`);
      }
      if (result.reason === "no_key") {
        throw new Error("resend: no API key configured");
      }
      throw new Error(`resend: ${result.error}`);
    },
  };
}
