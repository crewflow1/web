import "server-only";

/**
 * CrewFlow HQ — Communication Layer: the Twilio SMS provider (Directive #018 R5).
 *
 * The V1 implementation of the `SmsProvider` seam — the receptionist's FIRST
 * outbound transport (missed-call text-back). It does NOT introduce a second
 * messaging stack; it is the thin vendor adapter the seam calls, translating a
 * Twilio send into the seam's contract:
 *   - the provider ACCEPTED the message  → resolve with the provider message id (sid).
 *   - the provider degraded (misconfig / vendor error / no sid) → THROW, so the
 *     canonical service records a terminal `failed` attempt and owns retry.
 *
 * "Prefer extension over replacement" (a permanent engineering rule): Twilio is a
 * plug-in behind the factory (./index `getSmsProvider`), never imported by the
 * service. The SDK is loaded LAZILY (dynamic import, exactly as lib/email/send.ts
 * loads Resend) so it never enters a bundle that does not send SMS, and so the unit
 * suite can exercise the seam's null path without the vendor present.
 */

import { env } from "@/lib/env";
import type { SmsAcceptance, SmsMessage, SmsProvider, SmsProviderInfo } from "../types";

const INFO: SmsProviderInfo = { provider: "twilio", channel: "sms" };

export function createTwilioSmsProvider(): SmsProvider {
  return {
    info: INFO,
    async send(message: SmsMessage): Promise<SmsAcceptance> {
      const accountSid = env.TWILIO_ACCOUNT_SID;
      const authToken = env.TWILIO_AUTH_TOKEN;
      const from = message.from ?? env.TWILIO_SMS_FROM;

      // Defensive: the factory only hands back this provider when the credentials
      // are present, but the seam contract is THROW-on-failure, so a missing
      // credential here becomes a recorded `failed` attempt, never a silent no-op.
      if (!accountSid || !authToken || !from) {
        throw new Error(
          "twilio: missing account SID, auth token, or sender (TWILIO_SMS_FROM)",
        );
      }

      const { default: twilio } = await import("twilio");
      const client = twilio(accountSid, authToken);

      const res = await client.messages.create({
        to: message.to,
        from,
        body: message.body,
      });

      // The provider must hand back a message sid (the correlation key). Its
      // absence is a degraded acceptance — throw so the service records `failed`.
      if (!res.sid) {
        throw new Error("twilio: send returned no message sid");
      }
      return { providerMessageId: res.sid };
    },
  };
}
